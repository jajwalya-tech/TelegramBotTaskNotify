/**
 * Telegram Task/Reminder Bot
 *
 * Patches applied:
 *  - Fix /settime parsing (split only on first colon)
 *  - Message queue concurrency guard (processing flag)
 *  - Send CSV as Buffer (no disk file I/O)
 *  - SIGINT + SIGTERM handlers for graceful shutdown
 *  - Pool SSL optional via DB_SSL env var
 *  - Auto-create user row on /addtask to avoid FK errors
 *
 * ENV VARS (required):
 *   BOT_TOKEN        - Telegram bot token
 *   DATABASE_URL     - Postgres connection string
 *
 * Optional ENV VARS:
 *   DEFAULT_TIMEZONE - e.g. "Asia/Kolkata" (default: Asia/Kolkata)
 *   MSG_INTERVAL_MS  - queue polling interval in ms (default: 300)
 *   DB_SSL           - "true" to enable ssl: { rejectUnauthorized: false }
 *   DB_CONNECTION_TIMEOUT, DB_IDLE_TIMEOUT, DB_MAX_CONNECTIONS - pool tuning
 *
 * Deployment:
 *   - If you keep polling: run as a Background Worker / Daemon (Render).
 *   - If you prefer webhook mode, convert to webhook and run as Web Service.
 */

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const { CronJob } = require('cron');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const { stringify } = require('csv-stringify/sync'); // sync stringify for simplicity
// Note: csv-stringify also exports async versions; using sync avoids callback nesting
// but keep output sizes reasonable.
dayjs.extend(utc);
dayjs.extend(tz);

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN env var. Exiting.');
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL env var. Exiting.');
  process.exit(1);
}

const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata';
const MSG_INTERVAL_MS = Number(process.env.MSG_INTERVAL_MS || 300);
const DB_CONNECTION_TIMEOUT = Number(process.env.DB_CONNECTION_TIMEOUT || 10000); // 10 seconds
const DB_IDLE_TIMEOUT = Number(process.env.DB_IDLE_TIMEOUT || 30000); // 30 seconds  
const DB_MAX_CONNECTIONS = Number(process.env.DB_MAX_CONNECTIONS || 3); // Conservative for Supabas


const dns = require('dns');
const { promisify } = require('util');

// Custom function to resolve hostname to IPv4
async function resolveIPv4(hostname) {
  try {
    const resolve4 = promisify(dns.resolve4);
    const addresses = await resolve4(hostname);
    return addresses[0]; // Return the first IPv4 address
  } catch (err) {
    console.error('DNS resolution failed:', err.message);
    return hostname; // Fall back to hostname
  }
}

// Parse the database URL to extract components
const { URL } = require('url');
const dbUrl = new URL(process.env.DATABASE_URL);

// Create pool configuration with custom connection logic
const poolConfig = {
  user: dbUrl.username,
  password: dbUrl.password,
  host: dbUrl.hostname, // Will be resolved to IPv4
  port: dbUrl.port || 5432,
  database: dbUrl.pathname.replace('/', ''),
  connectionTimeoutMillis: DB_CONNECTION_TIMEOUT,
  idleTimeoutMillis: DB_IDLE_TIMEOUT,
  max: DB_MAX_CONNECTIONS,
};

// Override the connection logic to force IPv4
const originalConnect = Pool.prototype.connect;
Pool.prototype.connect = function(callback) {
  // Resolve host to IPv4 before connecting
  resolveIPv4(this.options.host).then(ipv4Address => {
    this.options.host = ipv4Address;
    console.log('Connecting to database at:', ipv4Address);
    originalConnect.call(this, callback);
  }).catch(err => {
    console.error('Failed to resolve IPv4 address:', err);
    callback(err);
  });
};

if (process.env.DB_SSL === 'true') {
  poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* -------------------------
   Database: init tables
   ------------------------- */

async function initTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        chat_id TEXT PRIMARY KEY,
        name TEXT,
        timezone TEXT,
        sessions JSONB,
        fun_day JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_chat_date ON tasks(chat_id, date);`).catch(()=>{});
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        chat_id TEXT REFERENCES users(chat_id) ON DELETE CASCADE,
        date DATE,
        description TEXT,
        completed BOOLEAN DEFAULT FALSE,
        reason TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(date);`).catch(()=>{});
    console.log('DB: tables ensured.');
  } catch (err) {
    console.error('DB init error', err);
    throw err;
  } finally {
    client.release();
  }
}

/* -------------------------
   Messages templates
   ------------------------- */

const messages =  {
  startOfDay: [
    '🌅 Good morning {name}! Here are your tasks for today:\n{tasks}\n\n“Each morning we are born again. What we do today is what matters most.” — Buddha',
    '☀️ Morning {name}! Ready to crush today? Tasks:\n{tasks}\n\n“Great things are not done by impulse, but by a series of small things brought together.” — Vincent van Gogh',
    '🌞 Rise and shine {name}! Let’s make today count:\n{tasks}\n\n“Your time is limited, so don’t waste it living someone else’s life.” — Steve Jobs',
    '🌻 Hello {name}, today is a blank canvas. Here are your brushstrokes:\n{tasks}\n\n“What would life be if we had no courage to attempt anything?” — Vincent van Gogh',
    '🌤️ A new day begins, {name}. Your tasks:\n{tasks}\n\n“Life is what happens when you’re busy making other plans.” — John Lennon',
  ],
  morning: [
    '⏰ Morning session starting soon, {name}! Stay centered.\n\n“Do not dwell in the past, do not dream of the future, concentrate the mind on the present moment.” — Buddha',
    '💡 Hey {name} — morning session in a few minutes. Let’s go!\n\n“In the middle of every difficulty lies opportunity.” — Albert Einstein',
    '🌱 Good focus makes the morning bloom, {name}.\n\n“Everything you can imagine is real.” — Pablo Picasso',
    '🌄 Time to begin, {name}. Morning is the seed of success.\n\n“The best way to predict the future is to create it.” — Peter Drucker',
  ],
  afternoon: [
    '☀️ Afternoon check-in, {name}. You got this!\n\n“Without work, nothing prospers.” — Sophocles',
    '🔔 Heads up {name} — afternoon session starting soon.\n\n“It does not matter how slowly you go as long as you do not stop.” — Confucius',
    '🌿 Keep steady, {name}. Afternoon is the bridge to the evening.\n\n“I dream of painting and then I paint my dream.” — Vincent van Gogh',
    '🍃 Midday reminder, {name}.\n\n“Success is not final, failure is not fatal: it is the courage to continue that counts.” — Winston Churchill',
  ],
  evening: [
    '🌙 Evening wrap-up session in a bit, {name}.\n\n“Inspiration exists, but it has to find you working.” — Pablo Picasso',
    '🌌 Evening reminder, {name}. Finish strong!\n\n“Your work is to discover your work and then with all your heart to give yourself to it.” — Buddha',
    '🕯️ The day winds down, {name} — time to bring tasks to a close.\n\n“What is done in love is done well.” — Vincent van Gogh',
    '🌠 Evening focus, {name}.\n\n“Try to be a rainbow in someone’s cloud.” — Maya Angelou',
  ],
  endOfDay: [
  '🌌 That\'s a wrap {name}! Before you go: {tasks}\n\n✅ Please add reasons via /reason or say /noreason if none.\n📝 Don’t forget to add tomorrow’s tasks with /tomorrow\n\n“Peace comes from within. Do not seek it without.” — Buddha',
  '🌠 Day finished {name}. Tasks: {tasks}\n\n✅ Please add reasons via /reason or say /noreason if none.\n📝 Don’t forget to add tomorrow’s tasks with /tomorrow\n\n“Do not go where the path may lead, go instead where there is no path and leave a trail.” — Ralph Waldo Emerson',
  '😴 Time to rest, {name}. Review your day: {tasks}\n\n✅ Please add reasons via /reason or say /noreason if none.\n📝 Don’t forget to add tomorrow’s tasks with /tomorrow\n\n“The wound is the place where the Light enters you.” — Rumi',
  '🌙 Well done {name}. Wrap up your tasks: {tasks}\n\n✅ Please add reasons via /reason or say /noreason if none.\n📝 Don’t forget to add tomorrow’s tasks with /tomorrow\n\n“Every day I discover more and more beautiful things. My head is bursting with the desire to do everything.” — Claude Monet',
  '💤 Rest easy, {name}. Reflect on your progress: {tasks}\n\n✅ Please add reasons via /reason or say /noreason if none.\n📝 Don’t forget to add tomorrow’s tasks with /tomorrow\n\n“Happiness is not something ready made. It comes from your own actions.” — Dalai Lama',
],

};

function pickMessage(type, name = '', tasksStr = '') {
  const arr = messages[type] || ['Hello {name}'];
  const msg = arr[Math.floor(Math.random() * arr.length)];
  return msg.replace(/\{name\}/g, name || '').replace(/\{tasks\}/g, tasksStr || '');
}

/* -------------------------
   Helpers (time & formatting)
   ------------------------- */

function localDateStr(tzName = DEFAULT_TZ, offsetDays = 0) {
  return dayjs().tz(tzName).add(offsetDays, 'day').format('YYYY-MM-DD');
}

function parseTimeHHMM(value) {
  // Accept "HH:MM" 24-hour format
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  const hh = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  return `${hh}:${mm}`;
}

/* -------------------------
   Message queue (safe)
   ------------------------- */
const messageQueue = [];
let processingQueue = false;

function enqueueMessage(chatId, text, opts = {}) {
  messageQueue.push({ chatId, text, opts, retries: 0 });
}

async function processQueueTick() {
  if (processingQueue) return;
  if (!messageQueue.length) return;
  processingQueue = true;
  const item = messageQueue[0];
  try {
    await bot.sendMessage(item.chatId, item.text, item.opts);
    messageQueue.shift();
  } catch (err) {
    // If Telegram returns 403 (bot blocked) or 400 user not found, drop and cleanup schedules
    console.error('sendMessage error for', item.chatId, err.message || err);
    item.retries = (item.retries || 0) + 1;
    if (item.retries >= 3 || (err.response && [400,403,404].includes(err.response.statusCode))) {
      console.warn(`Dropping message for ${item.chatId} after ${item.retries} retries.`);
      messageQueue.shift();
      // If bot was blocked (403), remove scheduled jobs for that chat to avoid future retries
      if (err.response && err.response.statusCode === 403) {
        clearJobs(item.chatId);
      }
    }
  } finally {
    processingQueue = false;
  }
}

setInterval(processQueueTick, MSG_INTERVAL_MS);

/* -------------------------
   Scheduling management
   ------------------------- */

const scheduledJobs = new Map(); // chatId -> [CronJob, ...]

function clearJobs(chatId) {
  const jobs = scheduledJobs.get(chatId);
  if (!jobs) return;
  jobs.forEach(j => {
    try { j.stop(); } catch (e) {}
  });
  scheduledJobs.delete(chatId);
}

function pushJob(chatId, job) {
  const arr = scheduledJobs.get(chatId) || [];
  arr.push(job);
  scheduledJobs.set(chatId, arr);
}

/**
 * Convert "HH:MM" to cron pattern for daily at that time in local timezone
 * Cron: 'm H * * *' with second optional
 */
function cronPatternForHHMM(hhmm) {
  const [hh, mm] = hhmm.split(':');
  return `${Number(mm)} ${Number(hh)} * * *`;
}

/* Schedule startOfDay, sessions, endOfDay */
async function scheduleAllForUser(user) {
  if (!user || !user.chat_id) return;
  const chatId = user.chat_id;
  const name = user.name || '';
  const tzName = user.timezone || DEFAULT_TZ;
  const sessions = user.sessions || {
    startOfDay: '07:00',
    morning: '08:30',
    afternoon: '14:30',
    evening: '19:30',
    endOfDay: '22:00'
  };

  clearJobs(chatId);

  // Start of day
  if (sessions.startOfDay) {
    const pattern = cronPatternForHHMM(sessions.startOfDay);
    const job = new CronJob(pattern, async () => {
      try {
        const today = localDateStr(tzName, 0);
        const { rows } = await pool.query(
          `SELECT id, description, completed FROM tasks WHERE chat_id=$1 AND date=$2 ORDER BY id`,
          [chatId, today]
        );
        let tasksStr = rows.length ? rows.map(r => `${r.id}. ${r.description} ${r.completed ? '✅' : ''}`).join('\n') : 'No tasks for today.';
        enqueueMessage(chatId, pickMessage('startOfDay', name, tasksStr));
      } catch (err) {
        console.error('startOfDay job error', err);
      }
    }, null, true, tzName);
    pushJob(chatId, job);
  }

  // Session reminders: schedule 15 and 5 minutes before session times for morning/afternoon/evening
  const sessionKeys = ['morning', 'afternoon', 'evening'];
  for (const key of sessionKeys) {
    const timeStr = sessions[key];
    if (!timeStr) continue;
    const parsed = parseTimeHHMM(timeStr);
    if (!parsed) continue;

    // 15 minutes before
    const [hh, mm] = parsed.split(':').map(Number);
    const dt15 = dayjs().tz(tzName).hour(hh).minute(mm).second(0).subtract(15, 'minute');
    const cron15 = `${dt15.minute()} ${dt15.hour()} * * *`;
    const job15 = new CronJob(cron15, async () => {
      try {
        enqueueMessage(chatId, `${pickMessage(key, name)}\nStarts in 15 minutes.`);
      } catch (err) {
        console.error('session 15 job error', err);
      }
    }, null, true, tzName);
    pushJob(chatId, job15);

    // 5 minutes before
    const dt5 = dayjs().tz(tzName).hour(hh).minute(mm).second(0).subtract(5, 'minute');
    const cron5 = `${dt5.minute()} ${dt5.hour()} * * *`;
    const job5 = new CronJob(cron5, async () => {
      try {
        enqueueMessage(chatId, `${pickMessage(key, name)}\nStarts in 5 minutes.`);
      } catch (err) {
        console.error('session 5 job error', err);
      }
    }, null, true, tzName);
    pushJob(chatId, job5);
  }

  // End of day
  if (sessions.endOfDay) {
    const pattern = cronPatternForHHMM(sessions.endOfDay);
    const job = new CronJob(pattern, async () => {
      try {
        const today = localDateStr(tzName, 0);
        const { rows } = await pool.query(
          `SELECT id, description, completed FROM tasks WHERE chat_id=$1 AND date=$2 ORDER BY id`,
          [chatId, today]
        );
        const incomplete = rows.filter(r => !r.completed);
        let tasksStr;
        if (rows.length === 0) tasksStr = 'No tasks were added today.';
        else tasksStr = rows.map(r => `${r.id}. ${r.description} ${r.completed ? '✅' : ''}`).join('\n');

        enqueueMessage(chatId, pickMessage('endOfDay', name, tasksStr));
      } catch (err) {
        console.error('endOfDay job error', err);
      }
    }, null, true, tzName);
    pushJob(chatId, job);
  }
}

/* Reschedule all users from DB on startup */
async function rescheduleAll() {
  try {
    const { rows } = await pool.query(`SELECT * FROM users`);
    for (const user of rows) {
      try {
        await scheduleAllForUser(user);
      } catch (e) {
        console.error('scheduleAllForUser error for', user.chat_id, e);
      }
    }
    console.log('Reschedule complete for', rows.length, 'users.');
  } catch (err) {
    console.error('rescheduleAll error', err);
  }
}

/* -------------------------
   Command handlers
   ------------------------- */

bot.onText(/\/start|\/help/, (msg) => {
  const chatId = String(msg.chat.id);
  const helpText = [
    'Welcome! Commands:',
    '/register <name> - register yourself',
    '/addtask <task> - add task for today',
    '/tomorrow <t1; t2; ...> - add tasks for tomorrow',
    '/markcomplete <task_id> - mark a task complete',
    '/reason <task_id> <reason> - add reason for incomplete task',
    '/noreason <reason> - declare no tasks were added but give reason',
    '/settime startOfDay:07:00;morning:08:30;afternoon:14:30;evening:19:30;endOfDay:22:00 - change times',
    '/report weekly|monthly - get CSV report',
    '/today - list today tasks',
  ].join('\n');
  bot.sendMessage(chatId, helpText);
});

bot.onText(/\/register (.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const name = (match[1] || '').trim();
  if (!name) return bot.sendMessage(chatId, 'Please provide a name: /register YourName');

  // default sessions
  const defaultSessions = {
    startOfDay: '07:00',
    morning: '08:30',
    afternoon: '14:30',
    evening: '19:30',
    endOfDay: '22:00'
  };

  try {
    await pool.query(
      `INSERT INTO users (chat_id, name, timezone, sessions) 
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (chat_id) DO UPDATE SET name = $2, timezone = $3, sessions = $4, updated_at = NOW()`,
      [chatId, name, DEFAULT_TZ, JSON.stringify(defaultSessions)]
    );
    // clear existing jobs and reschedule
    clearJobs(chatId);
    await scheduleAllForUser({ chat_id: chatId, name, timezone: DEFAULT_TZ, sessions: defaultSessions });
    return bot.sendMessage(chatId, `Registered as ${name}. I will remind you according to your schedule.`);
  } catch (err) {
    console.error('/register error', err);
    return bot.sendMessage(chatId, 'Registration failed. Try again later.');
  }
});

bot.onText(/\/addtask (.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const description = (match[1] || '').trim();
  if (!description) return bot.sendMessage(chatId, 'Please provide a task: /addtask Buy milk');

  const date = localDateStr(DEFAULT_TZ, 0);
  try {
    // Ensure user row exists to avoid FK error
    await pool.query(`INSERT INTO users (chat_id, timezone, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) ON CONFLICT DO NOTHING`, [chatId, DEFAULT_TZ]);

    const res = await pool.query(
      `INSERT INTO tasks (chat_id, date, description) VALUES ($1,$2,$3) RETURNING id`,
      [chatId, date, description]
    );
    const id = res.rows[0].id;
    return bot.sendMessage(chatId, `Added task #${id}: ${description}`);
  } catch (err) {
    console.error('/addtask error', err);
    return bot.sendMessage(chatId, 'Failed to add task. Please try again.');
  }
});

bot.onText(/\/tomorrow (.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const body = (match[1] || '').trim();
  if (!body) return bot.sendMessage(chatId, 'Provide semicolon-separated tasks: /tomorrow task1; task2');

  const parts = body.split(';').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return bot.sendMessage(chatId, 'No valid tasks detected.');

  const date = localDateStr(DEFAULT_TZ, 1);
  try {
    await pool.query(`INSERT INTO users (chat_id, timezone, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) ON CONFLICT DO NOTHING`, [chatId, DEFAULT_TZ]);

    const insertPromises = parts.map(desc => pool.query(`INSERT INTO tasks (chat_id, date, description) VALUES ($1,$2,$3)`, [chatId, date, desc]));
    await Promise.all(insertPromises);
    return bot.sendMessage(chatId, `Added ${parts.length} tasks for ${date}.`);
  } catch (err) {
    console.error('/tomorrow error', err);
    return bot.sendMessage(chatId, 'Failed to add tomorrow tasks. Try again later.');
  }
});

bot.onText(/\/markcomplete (\d+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const id = Number(match[1]);
  if (!id) return bot.sendMessage(chatId, 'Provide a valid task id: /markcomplete 123');

  try {
    const res = await pool.query(`UPDATE tasks SET completed = TRUE, updated_at = NOW() WHERE id=$1 AND chat_id=$2 RETURNING description`, [id, chatId]);
    if (res.rowCount === 0) return bot.sendMessage(chatId, `No task ${id} found.`);
    return bot.sendMessage(chatId, `Marked task ${id} complete: ${res.rows[0].description}`);
  } catch (err) {
    console.error('/markcomplete error', err);
    return bot.sendMessage(chatId, 'Failed to mark complete. Try again later.');
  }
});

bot.onText(/\/reason (\d+)\s+(.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const id = Number(match[1]);
  const reason = (match[2] || '').trim();
  if (!id || !reason) return bot.sendMessage(chatId, 'Usage: /reason <task_id> <reason>');

  try {
    const res = await pool.query(`UPDATE tasks SET reason=$1, updated_at=NOW() WHERE id=$2 AND chat_id=$3 RETURNING id`, [reason, id, chatId]);
    if (res.rowCount === 0) return bot.sendMessage(chatId, `No task ${id} found for you.`);
    return bot.sendMessage(chatId, `Saved reason for task ${id}.`);
  } catch (err) {
    console.error('/reason error', err);
    return bot.sendMessage(chatId, 'Failed to save reason. Try again later.');
  }
});

bot.onText(/\/noreason (.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const reason = (match[1] || '').trim();
  const date = localDateStr(DEFAULT_TZ, 0);
  try {
    await pool.query(`INSERT INTO users (chat_id, timezone, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) ON CONFLICT DO NOTHING`, [chatId, DEFAULT_TZ]);
    await pool.query(`INSERT INTO tasks (chat_id, date, description, completed, reason) VALUES ($1,$2,$3,true,$4)`, [chatId, date, 'No tasks added today', reason]);
    return bot.sendMessage(chatId, 'Noted — no tasks today. Thanks!');
  } catch (err) {
    console.error('/noreason error', err);
    return bot.sendMessage(chatId, 'Failed to record. Try again later.');
  }
});

/**
 * /settime parsing:
 * Example usage:
 *   /settime startOfDay:07:00;morning:08:30;afternoon:14:30;evening:19:30;endOfDay:22:00
 *
 * This handler will parse using only first colon as separator so times with ':'
 * remain intact.
 */
bot.onText(/\/settime (.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const payload = (match[1] || '').trim();
  if (!payload) return bot.sendMessage(chatId, 'Provide config like: startOfDay:07:00;morning:08:30;...');

  const allowed = ['startOfDay', 'morning', 'afternoon', 'evening', 'endOfDay'];
  const timePairs = payload.split(';').map(s => s.trim()).filter(Boolean);
  const newSessions = {};
  for (const pair of timePairs) {
    const idx = pair.indexOf(':');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim(); // keeps remainder (HH:MM)
    if (!allowed.includes(key)) continue;
    const parsed = parseTimeHHMM(value);
    if (!parsed) {
      return bot.sendMessage(chatId, `Invalid time for ${key}: ${value}. Use HH:MM (24h)`);
    }
    newSessions[key] = parsed;
  }
  if (!Object.keys(newSessions).length) return bot.sendMessage(chatId, 'No valid time entries found.');

  try {
    // load user, update sessions
    await pool.query(`INSERT INTO users (chat_id, timezone, sessions, created_at, updated_at) VALUES ($1,$2,$3,NOW(),NOW()) ON CONFLICT (chat_id) DO UPDATE SET sessions = $3, updated_at = NOW()`, [chatId, DEFAULT_TZ, JSON.stringify(newSessions)]);
    // refresh schedule
    clearJobs(chatId);
    const { rows } = await pool.query(`SELECT * FROM users WHERE chat_id=$1`, [chatId]);
    const user = rows[0];
    if (user) {
      // merge sessions: keep missing keys from prior sessions or defaults
      user.sessions = Object.assign({
        startOfDay: '07:00',
        morning: '08:30',
        afternoon: '14:30',
        evening: '19:30',
        endOfDay: '22:00'
      }, user.sessions || {}, newSessions);
      await scheduleAllForUser(user);
      return bot.sendMessage(chatId, 'Schedule updated and rescheduled.');
    } else {
      return bot.sendMessage(chatId, 'Schedule updated.');
    }
  } catch (err) {
    console.error('/settime error', err);
    return bot.sendMessage(chatId, 'Failed to set times. Try again later.');
  }
});

bot.onText(/\/today/, async (msg) => {
  const chatId = String(msg.chat.id);
  const date = localDateStr(DEFAULT_TZ, 0);
  try {
    const { rows } = await pool.query(`SELECT id, description, completed, reason FROM tasks WHERE chat_id=$1 AND date=$2 ORDER BY id`, [chatId, date]);
    if (!rows.length) return bot.sendMessage(chatId, `No tasks for today (${date}).`);
    const text = rows.map(r => `${r.id}. ${r.description} ${r.completed ? '✅' : ''}${r.reason ? ' — ' + r.reason : ''}`).join('\n');
    return bot.sendMessage(chatId, `Tasks for ${date}:\n${text}`);
  } catch (err) {
    console.error('/today error', err);
    return bot.sendMessage(chatId, 'Failed to fetch today tasks.');
  }
});

/* Report generation: weekly or monthly */
bot.onText(/\/report (weekly|monthly)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const type = match[1];
  let startDate;
  const tzName = DEFAULT_TZ;
  if (type === 'weekly') {
    startDate = dayjs().tz(tzName).subtract(7, 'day').format('YYYY-MM-DD');
  } else {
    startDate = dayjs().tz(tzName).subtract(1, 'month').format('YYYY-MM-DD');
  }
  try {
    const { rows } = await pool.query(`SELECT date, description, completed, reason FROM tasks WHERE chat_id=$1 AND date >= $2 ORDER BY date`, [chatId, startDate]);
    if (!rows.length) return bot.sendMessage(chatId, `No tasks since ${startDate}.`);
    const csv = stringify(rows, {
      header: true,
      columns: [
        { key: 'date', header: 'Date' },
        { key: 'description', header: 'Task' },
        { key: 'completed', header: 'Completed' },
        { key: 'reason', header: 'Reason' }
      ]
    });
    const fileName = `report_${chatId}_${type}_${dayjs().format('YYYYMMDD_HHmmss')}.csv`;
    try {
      await bot.sendDocument(chatId, Buffer.from(csv), {}, { filename: fileName });
    } catch (err) {
      console.error('Error sending CSV buffer', err);
      await bot.sendMessage(chatId, 'Failed to send report. Try again later.');
    }
  } catch (err) {
    console.error('/report error', err);
    return bot.sendMessage(chatId, 'Failed to build report. Try again later.');
  }
});

/* -------------------------
   Errors & process signals
   ------------------------- */

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

async function gracefulShutdown(signal) {
  console.log(`${signal} received. Shutting down...`);
  try {
    // stop all cron jobs
    for (const jobs of scheduledJobs.values()) {
      jobs.forEach(j => {
        try { j.stop(); } catch (e) {}
      });
    }
    // make one last attempt to flush queue (best effort)
    if (messageQueue.length) {
      console.log('Flushing message queue before exit...');
      // Attempt sending remaining messages (not guaranteed)
      for (let i = 0; i < Math.min(20, messageQueue.length); i++) {
        await processQueueTick();
      }
    }
    await pool.end();
    console.log('DB pool closed. Exiting.');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Add this function BEFORE the main function
async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('✅ Successfully connected to Supabase database!');
    console.log('📍 Host: db.sjxcfetwrzejxohskeft.supabase.co');
    client.release();
    return true;
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    return false;
  }
}

/* -------------------------
   Startup sequence
   ------------------------- */

(async function main() {
  try {
    // Test connection first
    const connected = await testConnection();
    if (!connected) {
      console.error('Cannot start without database connection');
      process.exit(1);
    }
    
    await initTables();
    // small delay to ensure DB is ready; then reschedule
    setTimeout(rescheduleAll, 2000);
    console.log('Bot started and polling for Telegram updates.');
  } catch (err) {
    console.error('Startup error', err);
    process.exit(1);
  }
})();
