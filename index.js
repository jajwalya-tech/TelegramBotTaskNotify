
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
 *  - Railway deployment fixes (IPv6/SSL handling)
 *  - Force IPv4 connections for Railway compatibility
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
 *   FORCE_IPV4       - "true" to force IPv4 connections (default: true)
 *
 * Deployment:
 *   - If you keep polling: run as a Background Worker / Daemon (Railway).
 *   - If you prefer webhook mode, convert to webhook and run as Web Service.
 */

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const { CronJob } = require('cron');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const { stringify } = require('csv-stringify/sync');
const { URL } = require('url');

dayjs.extend(utc);
dayjs.extend(tz);

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ Missing BOT_TOKEN env var. Exiting.');
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ Missing DATABASE_URL env var. Exiting.');
  process.exit(1);
}

const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata';
const MSG_INTERVAL_MS = Number(process.env.MSG_INTERVAL_MS || 300);
const DB_CONNECTION_TIMEOUT = Number(process.env.DB_CONNECTION_TIMEOUT || 10000);
const DB_IDLE_TIMEOUT = Number(process.env.DB_IDLE_TIMEOUT || 30000);
const DB_MAX_CONNECTIONS = Number(process.env.DB_MAX_CONNECTIONS || 10);
const FORCE_IPV4 = process.env.FORCE_IPV4 !== 'false';

// Parse DATABASE_URL and create IPv4-compatible pool config
function createPoolConfig(databaseUrl) {
  try {
    const dbUrl = new URL(databaseUrl);
    
    // Base configuration
    const config = {
      connectionTimeoutMillis: DB_CONNECTION_TIMEOUT,
      idleTimeoutMillis: DB_IDLE_TIMEOUT,
      max: DB_MAX_CONNECTIONS,
      // Enable keep-alive for better connection stability
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    };

    // Handle SSL configuration
    if (process.env.DB_SSL !== 'false') {
      config.ssl = {
        rejectUnauthorized: false
      };
    }

    // If forcing IPv4 or if we detect potential IPv6 issues
    if (FORCE_IPV4) {
      console.log('🔧 Configuring for IPv4-only connections...');
      
      // Extract connection details from URL
      config.host = dbUrl.hostname;
      config.port = dbUrl.port || 5432;
      config.database = dbUrl.pathname.slice(1); // Remove leading '/'
      config.user = dbUrl.username;
      config.password = dbUrl.password;
      
      // Force IPv4 DNS resolution by using IPv4-specific options
      config.host = dbUrl.hostname.replace(/^\[|\]$/g, ''); // Remove brackets if IPv6
      
      // Additional pg connection options to prefer IPv4
      config.options = '-c default_transaction_isolation=read-committed';
      
    } else {
      // Use connection string as-is
      config.connectionString = databaseUrl;
    }

    return config;
  } catch (err) {
    console.error('❌ Error parsing DATABASE_URL:', err);
    // Fallback to original approach
    return {
      connectionString: databaseUrl,
      connectionTimeoutMillis: DB_CONNECTION_TIMEOUT,
      idleTimeoutMillis: DB_IDLE_TIMEOUT,
      max: DB_MAX_CONNECTIONS,
      ssl: process.env.DB_SSL !== 'false' ? { rejectUnauthorized: false } : undefined
    };
  }
}

const poolConfig = createPoolConfig(DATABASE_URL);
console.log('🔧 Database pool config:', {
  host: poolConfig.host || 'from-connection-string',
  port: poolConfig.port || 'from-connection-string',
  database: poolConfig.database || 'from-connection-string',
  ssl: !!poolConfig.ssl,
  forceIPv4: FORCE_IPV4
});

const pool = new Pool(poolConfig);

// Enhanced database connection testing with IPv4/IPv6 diagnostics
async function testDatabaseConnection() {
  let retries = 5;
  while (retries > 0) {
    try {
      console.log('🔄 Testing database connection...');
      
      // Set a shorter timeout for initial connection test
      const testClient = await pool.connect();
      const result = await testClient.query('SELECT NOW(), version()');
      testClient.release();
      
      console.log('✅ Database connection successful');
      console.log('📊 PostgreSQL version:', result.rows[0].version.split(' ')[0] + ' ' + result.rows[0].version.split(' ')[1]);
      return true;
    } catch (err) {
      console.error(`❌ Database connection failed (${retries} retries left):`, err.message);
      
      // Check for specific IPv6 connectivity issues
      if (err.message.includes('ENETUNREACH') && err.message.includes(':::')) {
        console.error('🔍 IPv6 connectivity issue detected. This is common on Railway.');
        if (!FORCE_IPV4) {
          console.error('💡 Consider setting FORCE_IPV4=true environment variable.');
        }
      }
      
      // Check for SSL issues
      if (err.message.includes('no pg_hba.conf entry') || err.message.includes('SSL')) {
        console.error('🔍 SSL/Authentication issue detected.');
        console.error('💡 Verify DATABASE_URL includes SSL parameters or set DB_SSL=false if not needed.');
      }
      
      retries--;
      if (retries > 0) {
        const waitTime = (6 - retries) * 2; // Exponential backoff: 2, 4, 6, 8 seconds
        console.log(`⏳ Retrying in ${waitTime} seconds...`);
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
      }
    }
  }
  console.error('❌ Cannot start without database connection');
  process.exit(1);
}

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
        mandatory_day_off_interval INTEGER DEFAULT NULL,
        last_mandatory_day_off DATE DEFAULT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

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

    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_chat_date ON tasks(chat_id, date);`).catch(()=>{});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(date);`).catch(()=>{});
    // After the CREATE TABLE statements in initTables(), add:
    try {
        await client.query(`
        ALTER TABLE users 
        ADD COLUMN IF NOT EXISTS interval_set_date DATE DEFAULT NULL
  `);
    console.log('✅ Added interval_set_date column if needed');
      } catch (err) {
      console.log('ℹ️ interval_set_date column already exists or could not be added:', err.message);
    }
    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('❌ Database init error', err);
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
    '🌅 Good morning {name}! Here are your tasks for today:\n{tasks}\n\n"Each morning we are born again. What we do today is what matters most." — Buddha',
    '☀️ Morning {name}! Ready to crush today? Tasks:\n{tasks}\n\n"Great things are not done by impulse, but by a series of small things brought together." — Vincent van Gogh',
    '🌞 Rise and shine {name}! Let\'s make today count:\n{tasks}\n\n"Your time is limited, so don\'t waste it living someone else\'s life.\" — Steve Jobs',
    '🌻 Hello {name}, today is a blank canvas. Here are your brushstrokes:\n{tasks}\n\n"What would life be if we had no courage to attempt anything?" — Vincent van Gogh',
    '🌤️ A new day begins, {name}. Your tasks:\n{tasks}\n\n"Life is what happens when you\'re busy making other plans.\" — John Lennon',
  ],
  morning: [
    '⏰ Morning session starting soon, {name}! Stay centered.\n\n"Do not dwell in the past, do not dream of the future, concentrate the mind on the present moment.\" — Buddha',
    '💡 Hey {name} — morning session in a few minutes. Let\'s go!\n\n"In the middle of every difficulty lies opportunity.\" — Albert Einstein',
    '🌱 Good focus makes the morning bloom, {name}.\n\n"Everything you can imagine is real.\" — Pablo Picasso',
    '🌄 Time to begin, {name}. Morning is the seed of success.\n\n"The best way to predict the future is to create it.\" — Peter Drucker',
  ],
  afternoon: [
    '☀️ Afternoon check-in, {name}. You got this!\n\n"Without work, nothing prospers.\" — Sophocles',
    '🔔 Heads up {name} — afternoon session starting soon.\n\n"It does not matter how slowly you go as long as you do not stop.\" — Confucius',
    '🌿 Keep steady, {name}. Afternoon is the bridge to the evening.\n\n"I dream of painting and then I paint my dream.\" — Vincent van Gogh',
    '🍃 Midday reminder, {name}.\n\n"Success is not final, failure is not fatal: it is the courage to continue that counts.\" — Winston Churchill',
  ],
  evening: [
    '🌙 Evening wrap-up session in a bit, {name}.\n\n"Inspiration exists, but it has to find you working.\" — Pablo Picasso',
    '🌌 Evening reminder, {name}. Finish strong!\n\n"Your work is to discover your work and then with all your heart to give yourself to it.\" — Buddha',
    '🕯️ The day winds down, {name} — time to bring tasks to a close.\n\n"What is done in love is done well.\" — Vincent van Gogh',
    '🌠 Evening focus, {name}.\n\n"Try to be a rainbow in someone\'s cloud.\" — Maya Angelou',
  ],
  endOfDay: [
  '🌌 That\'s a wrap {name}! Before you go: {tasks}\n\n✅ Please add reasons via /reason or say /noreason if none.\n📝 Don\'t forget to add tomorrow\'s tasks with /tomorrow\n\n"Peace comes from within. Do not seek it without.\" — Buddha',
  '🌠 Day finished {name}. Tasks: {tasks}\n\n✅ Please add reasons via /reason or say /noreason if none.\n📝 Don\'t forget to add tomorrow\'s tasks with /tomorrow\n\n"Do not go where the path may lead, go instead where there is no path and leave a trail.\" — Ralph Waldo Emerson',
  '😴 Time to rest, {name}. Review your day: {tasks}\n\n✅ Please add reasons via /reason or say /noreason if none.\n📝 Don\'t forget to add tomorrow\'s tasks with /tomorrow\n\n"The wound is the place where the Light enters you.\" — Rumi',
  '🌙 Well done {name}. Wrap up your tasks: {tasks}\n\n✅ Please add reasons via /reason or say /noreason if none.\n📝 Don\'t forget to add tomorrow\'s tasks with /tomorrow\n\n"Every day I discover more and more beautiful things. My head is bursting with the desire to do everything.\" — Claude Monet',
  '💤 Rest easy, {name}. Reflect on your progress: {tasks}\n\n✅ Please add reasons via /reason or say /noreason if none.\n📝 Don\'t forget to add tomorrow\'s tasks with /tomorrow\n\n"Happiness is not something ready made. It comes from your own actions.\" — Dalai Lama',
],
  mandatoryDayOff: [
    '🌴 Today is your mandatory day off {name}! Time to relax and recharge.\n\n"Rest when you\'re weary. Refresh and renew yourself, your body, your mind, your spirit. Then get back to work." — Ralph Marston',
    '🎉 Enjoy your well-deserved day off {name}! You\'ve earned it.\n\n"Almost everything will work again if you unplug it for a few minutes, including you." — Anne Lamott',
    '🌞 Mandatory rest day {name}! Take time for yourself today.\n\n"Take rest; a field that has rested gives a bountiful crop." — Ovid',
    '🏖️ It\'s your mandatory day off {name}! Enjoy the break.\n\n"Sometimes the most productive thing you can do is relax." — Mark Black',
  ],
  endMandatoryDay: [
    '🌙 Your mandatory day off is ending {name}. Don\'t forget to add tomorrow\'s tasks with /tomorrow',
    '🌠 Hope you enjoyed your day off {name}! Time to plan for tomorrow with /tomorrow',
    '😊 Rest day complete {name}! Ready to get back to it tomorrow? Use /tomorrow to add tasks',
    '💫 Your day of rest is over {name}. Prepare for tomorrow with /tomorrow',
  ]
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

// Helper function to check if today is a mandatory day off
function isMandatoryDayOff(user) {
  if (!user.mandatory_day_off_interval) return false;
  
  const today = dayjs().tz(user.timezone || DEFAULT_TZ);
  
  // If user has taken a day off before, use that date
  if (user.last_mandatory_day_off) {
    const lastDayOff = dayjs(user.last_mandatory_day_off).tz(user.timezone || DEFAULT_TZ);
    const daysSinceLastOff = today.diff(lastDayOff, 'day');
    return daysSinceLastOff >= user.mandatory_day_off_interval;
  }
  
  // If no day off taken yet, calculate from when interval was set
  if (user.interval_set_date) {
    const intervalStart = dayjs(user.interval_set_date).tz(user.timezone || DEFAULT_TZ);
    const daysSinceIntervalSet = today.diff(intervalStart, 'day');
    return daysSinceIntervalSet >= user.mandatory_day_off_interval;
  }
  
  // Fallback: if no interval_set_date, use today as start (shouldn't happen)
  return false;
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
        // Check if today is a mandatory day off
        if (isMandatoryDayOff(user)) {
          enqueueMessage(chatId, pickMessage('mandatoryDayOff', name));
          return;
        }
        
        const today = localDateStr(tzName, 0);
        const { rows } = await pool.query(
          `SELECT id, description, completed FROM tasks WHERE chat_id=$1 AND date=$2 ORDER BY id`,
          [chatId, today]
        );
        let tasksStr = rows.length ? rows.map(r => `${r.id}. ${r.description} ${r.completed ? '✅' : '❌'}`).join('\n') : 'No tasks for today.';
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
        // Skip on mandatory day off
        if (isMandatoryDayOff(user)) return;
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
        // Skip on mandatory day off
        if (isMandatoryDayOff(user)) return;
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
        
        // Check if today is a mandatory day off
        if (isMandatoryDayOff(user)) {
          // Update last mandatory day off date
          await pool.query(
            `UPDATE users SET last_mandatory_day_off = $1, updated_at = NOW() WHERE chat_id = $2`,
            [today, chatId]
          );
          
          enqueueMessage(chatId, pickMessage('endMandatoryDay', name));
          return;
        }
        
        const { rows } = await pool.query(
          `SELECT id, description, completed FROM tasks WHERE chat_id=$1 AND date=$2 ORDER BY id`,
          [chatId, today]
        );
        const incomplete = rows.filter(r => !r.completed);
        let tasksStr;
        if (rows.length === 0) tasksStr = 'No tasks were added today.';
        else tasksStr = rows.map(r => `${r.id}. ${r.description} ${r.completed ? '✅' : '❌'}`).join('\n');

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
    console.log('✅ Reschedule complete for', rows.length, 'users.');
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
    '/markincomplete <task_id> - mark a task incomplete',
    '/reason <task_id> <reason> - add reason for incomplete task',
    '/noreason <reason> - declare no tasks were added but give reason',
    '/settime startOfDay:07:00;morning:08:30;afternoon:14:30;evening:19:30;endOfDay:22:00 - change times',
    '/setinterval <days> - set mandatory day off interval (e.g., 15)',
    '/showtimes - display your current schedule timings',
    '/showinterval - display your day off interval settings',
    '/report weekly|monthly - get CSV report',
    '/today - list today tasks',
    '/deleteuser - delete your account and all data',
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

// Add markincomplete command
bot.onText(/\/markincomplete (\d+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const id = Number(match[1]);
  if (!id) return bot.sendMessage(chatId, 'Provide a valid task id: /markincomplete 123');

  try {
    const res = await pool.query(`UPDATE tasks SET completed = FALSE, updated_at = NOW() WHERE id=$1 AND chat_id=$2 RETURNING description`, [id, chatId]);
    if (res.rowCount === 0) return bot.sendMessage(chatId, `No task ${id} found.`);
    return bot.sendMessage(chatId, `Marked task ${id} incomplete: ${res.rows[0].description}`);
  } catch (err) {
    console.error('/markincomplete error', err);
    return bot.sendMessage(chatId, 'Failed to mark incomplete. Try again later.');
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

// Add setinterval command
bot.onText(/\/setinterval (\d+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const interval = parseInt(match[1]);
  
  if (!interval || interval < 1) {
    return bot.sendMessage(chatId, 'Please provide a valid interval (e.g., /setinterval 15)');
  }
  
  try {
    const today = localDateStr(DEFAULT_TZ, 0);
    await pool.query(
      `UPDATE users SET mandatory_day_off_interval = $1, interval_set_date = $2, updated_at = NOW() WHERE chat_id = $3`,
      [interval, today, chatId]
    );
    
    // Reschedule to apply changes
    const { rows } = await pool.query(`SELECT * FROM users WHERE chat_id=$1`, [chatId]);
    if (rows.length) {
      clearJobs(chatId);
      await scheduleAllForUser(rows[0]);
    }
    
    return bot.sendMessage(chatId, `Mandatory day off interval set to ${interval} days. First day off will be in ${interval} days.`);
  } catch (err) {
    console.error('/setinterval error', err);
    return bot.sendMessage(chatId, 'Failed to set interval. Try again later.');
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


//SHOW DEFAULT TIMINGS
bot.onText(/\/showtimes/, async (msg) => {
  const chatId = String(msg.chat.id);
  
  try {
    const { rows } = await pool.query(`SELECT sessions, timezone FROM users WHERE chat_id = $1`, [chatId]);
    
    if (!rows.length) {
      return bot.sendMessage(chatId, 'You need to register first using /register <name>');
    }
    
    const user = rows[0];
    const sessions = user.sessions || {
      startOfDay: '07:00',
      morning: '08:30',
      afternoon: '14:30',
      evening: '19:30',
      endOfDay: '22:00'
    };
    
    const timezone = user.timezone || DEFAULT_TZ;
    
    const message = `⏰ Your current schedule (Timezone: ${timezone}):\n\n` +
      `🌅 Start of Day: ${sessions.startOfDay || 'Not set'}\n` +
      `☀️ Morning Session: ${sessions.morning || 'Not set'}\n` +
      `🌞 Afternoon Session: ${sessions.afternoon || 'Not set'}\n` +
      `🌙 Evening Session: ${sessions.evening || 'Not set'}\n` +
      `🌌 End of Day: ${sessions.endOfDay || 'Not set'}\n\n` +
      `Use /settime to change these timings. Example:\n` +
      `/settime startOfDay:07:00;morning:08:30;afternoon:14:30;evening:19:30;endOfDay:22:00`;
    
    return bot.sendMessage(chatId, message);
  } catch (err) {
    console.error('/showtimes error', err);
    return bot.sendMessage(chatId, 'Failed to fetch your schedule. Try again later.');
  }
});

//SHOW DEFAULT MANDATORYDAYOFF INTERVAL
bot.onText(/\/showinterval/, async (msg) => {
  const chatId = String(msg.chat.id);
  
  try {
    const { rows } = await pool.query(
      `SELECT mandatory_day_off_interval, last_mandatory_day_off, interval_set_date, timezone FROM users WHERE chat_id = $1`,
      [chatId]
    );
    
    if (!rows.length) {
      return bot.sendMessage(chatId, 'You need to register first using /register <name>');
    }
    
    const user = rows[0];
    const interval = user.mandatory_day_off_interval;
    const lastDayOff = user.last_mandatory_day_off;
    const intervalSetDate = user.interval_set_date;
    const timezone = user.timezone || DEFAULT_TZ;
    
    let message = `📅 Your Mandatory Day Off Settings:\n\n`;
    
    if (interval) {
      message += `🔄 Interval: Every ${interval} days\n`;
      
      let nextOffDate;
      if (lastDayOff) {
        const lastOffDate = dayjs(lastDayOff).tz(timezone).format('YYYY-MM-DD');
        nextOffDate = dayjs(lastDayOff).tz(timezone).add(interval, 'day').format('YYYY-MM-DD');
        const daysUntilNext = interval - dayjs().tz(timezone).diff(dayjs(lastDayOff).tz(timezone), 'day');
        
        message += `📆 Last day off: ${lastOffDate}\n`;
        message += `⏭️ Next day off: ${nextOffDate}\n`;
        message += `📋 Days until next: ${Math.max(0, daysUntilNext)}\n`;
      } else if (intervalSetDate) {
        const startDate = dayjs(intervalSetDate).tz(timezone).format('YYYY-MM-DD');
        nextOffDate = dayjs(intervalSetDate).tz(timezone).add(interval, 'day').format('YYYY-MM-DD');
        const daysUntilNext = interval - dayjs().tz(timezone).diff(dayjs(intervalSetDate).tz(timezone), 'day');
        
        message += `📆 Interval started: ${startDate}\n`;
        message += `⏭️ First day off: ${nextOffDate}\n`;
        message += `📋 Days until first: ${Math.max(0, daysUntilNext)}\n`;
      } else {
        message += `📆 Status: Ready for first day off\n`;
      }
    } else {
      message += `❌ No mandatory day off interval set\n`;
    }
    
    message += `\nUse /setinterval <days> to change your interval. Example:\n/setinterval 15`;
    
    return bot.sendMessage(chatId, message);  
  } catch (err) {
    console.error('/showinterval error', err);
    return bot.sendMessage(chatId, 'Failed to fetch your interval settings. Try again later.');
  }
});  

//DISPLAY TODAY'S TASKS
bot.onText(/\/today/, async (msg) => {
  const chatId = String(msg.chat.id);
  const date = localDateStr(DEFAULT_TZ, 0);
  try {
    const { rows } = await pool.query(`SELECT id, description, completed, reason FROM tasks WHERE chat_id=$1 AND date=$2 ORDER BY id`, [chatId, date]);
    if (!rows.length) return bot.sendMessage(chatId, `No tasks for today (${date}).`);
    const text = rows.map(r => `${r.id}. ${r.description} ${r.completed ? '✅' : '❌'}${r.reason ? ' — ' + r.reason : ''}`).join('\n');
    return bot.sendMessage(chatId, `Tasks for ${date}:\n${text}`);
  } catch (err) {
    console.error('/today error', err);
    return bot.sendMessage(chatId, 'Failed to fetch today tasks.');
  }
});

// Add deleteuser command with confirmation
bot.onText(/\/deleteuser/, async (msg) => {
  const chatId = String(msg.chat.id);
  
  // Send confirmation message with inline keyboard
  const opts = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Yes, delete my account', callback_data: 'deleteuser_confirm' },
          { text: '❌ Cancel', callback_data: 'deleteuser_cancel' }
        ]
      ]
    }
  };
  
  return bot.sendMessage(chatId, '⚠️ Are you sure you want to delete your account and all your data? This action cannot be undone.', opts);
});

// Handle confirmation callback
bot.on('callback_query', async (callbackQuery) => {
  const chatId = String(callbackQuery.message.chat.id);
  const data = callbackQuery.data;

  if (data === 'deleteuser_confirm') {
    try {
      // First delete all tasks for this user
      await pool.query('DELETE FROM tasks WHERE chat_id = $1', [chatId]);
      
      // Then delete the user
      await pool.query('DELETE FROM users WHERE chat_id = $1', [chatId]);
      
      // Clear scheduled jobs
      clearJobs(chatId);
      
      // Answer callback and send confirmation
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Account deleted successfully' });
      return bot.sendMessage(chatId, '✅ Your account and all associated data have been deleted.');
    } catch (err) {
      console.error('/deleteuser error', err);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Error deleting account' });
      return bot.sendMessage(chatId, 'Failed to delete account. Try again later.');
    }
  } else if (data === 'deleteuser_cancel') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Account deletion cancelled' });
    return bot.sendMessage(chatId, 'Account deletion cancelled. Your data is safe.');
  }
  
  // Answer any other callback queries to prevent hanging
  await bot.answerCallbackQuery(callbackQuery.id);
}); 
// === /report COMMAND ===
const lastReports = {}; // cache per user
const reportAwaitingRange = {}; // track who is entering custom range

bot.onText(/\/report/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(chatId, "📊 Select the report range:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📅 Last 7 Days", callback_data: "range_7" }],
        [{ text: "📅 Last 30 Days", callback_data: "range_30" }],
        [{ text: "📅 Full Report", callback_data: "range_full" }],
        [{ text: "📝 Custom Range", callback_data: "range_custom" }],
      ],
    },
  });
});

// === HANDLE RANGE SELECTION ===
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;

  // Step 1: custom range request
  if (query.data === "range_custom") {
    reportAwaitingRange[chatId] = true;
    bot.answerCallbackQuery(query.id);
    return bot.sendMessage(
      chatId,
      "📌 Please enter date range in format:\n`DD-MM-YYYY to DD-MM-YYYY`",
      { parse_mode: "Markdown" }
    );
  }

  // Step 2: handle predefined ranges
  let startDate, endDate;
  if (query.data === "range_7") {
    endDate = new Date();
    startDate = new Date();
    startDate.setDate(endDate.getDate() - 6); // last 7 days
  } else if (query.data === "range_30") {
    endDate = new Date();
    startDate = new Date();
    startDate.setDate(endDate.getDate() - 29); // last 30 days
  } else if (query.data === "range_full") {
    endDate = null; // fetch all
    startDate = null;
  } else {
    return; // not our concern
  }

  bot.answerCallbackQuery(query.id);
  await sendReport(chatId, startDate, endDate);
});

// === HANDLE CUSTOM RANGE TEXT ===
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  if (reportAwaitingRange[chatId]) {
    const input = msg.text.trim();
    const match = input.match(
      /^(\d{2}-\d{2}-\d{4})\s+to\s+(\d{2}-\d{2}-\d{4})$/
    );

    if (!match) {
      return bot.sendMessage(
        chatId,
        "⚠ Invalid format. Please use: `DD-MM-YYYY to DD-MM-YYYY`",
        { parse_mode: "Markdown" }
      );
    }

    const startDate = new Date(match[1].split("-").reverse().join("-"));
    const endDate = new Date(match[2].split("-").reverse().join("-"));
    endDate.setHours(23, 59, 59, 999); // include whole day

    delete reportAwaitingRange[chatId];
    return sendReport(chatId, startDate, endDate);
  }
});

// === REPORT GENERATION FUNCTION ===
async function sendReport(chatId, startDate, endDate) {
  try {
    let query = `SELECT description, completed, reason, created_at
                 FROM tasks 
                 WHERE chat_id = $1`;
    const params = [chatId];

    if (startDate && endDate) {
      query += ` AND created_at BETWEEN $2 AND $3 ORDER BY created_at ASC`;
      params.push(startDate, endDate);
    } else {
      query += ` ORDER BY created_at ASC`;
    }

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return bot.sendMessage(chatId, "No tasks found for this period.");
    }

    // cache
    lastReports[chatId] = result.rows;

    // ask output format
    await bot.sendMessage(chatId, "📊 How would you like the report?", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📝 Text Only", callback_data: "report_text" }],
          [{ text: "📂 CSV Only", callback_data: "report_csv" }],
          [{ text: "📝 + 📂 Both", callback_data: "report_both" }],
        ],
      },
    });
  } catch (err) {
    console.error(err.message);
    bot.sendMessage(chatId, "Error generating report.");
  }
}

// === FINAL OUTPUT HANDLER (Text / CSV / Both) ===
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;

  if (
    query.data === "report_text" ||
    query.data === "report_csv" ||
    query.data === "report_both"
  ) {
    const rows = lastReports[chatId];
    if (!rows) {
      return bot.answerCallbackQuery(query.id, {
        text: "⚠ Please generate a report first.",
      });
    }

    // Group tasks daywise
    const grouped = {};
    rows.forEach((row) => {
      const day = new Date(row.created_at).toLocaleDateString("en-IN", {
        weekday: "long",
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
      if (!grouped[day]) grouped[day] = [];
      grouped[day].push(row);
    });

    // Build text report
    let textReport = "📊 *Your Task Report (Day-wise)* 📊\n\n";
    for (const [day, tasks] of Object.entries(grouped)) {
      textReport += `📅 *${day}*\n`;

      if (tasks.length === 1 && tasks[0].description === "Mandatory Day Off") {
        textReport += `   🌴 Mandatory Day Off\n\n`;
        continue;
      }

      if (tasks.length === 1 && tasks[0].description === "No Tasks Uploaded") {
        textReport += `   ❌ No tasks uploaded\n`;
        textReport += `      ⚠ Reason: ${tasks[0].reason || "Not provided"}\n\n`;
        continue;
      }

      tasks.forEach((row, idx) => {
        const status = row.completed ? "✅" : "❌";
        textReport += `   ${idx + 1}. ${row.description} ${status}\n`;
        if (!row.completed) {
          textReport += `      ⚠ Reason: ${row.reason || "Not provided"}\n`;
        }
      });

      textReport += `\n`;
    }

    // CSV
    const csv = parse(rows, {
      fields: ["description", "completed", "reason", "created_at"],
    });

    // Send depending on choice
    if (query.data === "report_text") {
      await bot.sendMessage(chatId, textReport, { parse_mode: "Markdown" });
    } else if (query.data === "report_csv") {
      await bot.sendDocument(
        chatId,
        Buffer.from(csv),
        {},
        { filename: `report_${chatId}.csv` }
      );
    } else if (query.data === "report_both") {
      await bot.sendMessage(chatId, textReport, { parse_mode: "Markdown" });
      await bot.sendDocument(
        chatId,
        Buffer.from(csv),
        {},
        { filename: `report_${chatId}.csv` }
      );
    }

    bot.answerCallbackQuery(query.id, { text: "Report ready ✅" });
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

/* -------------------------
   Startup sequence
   ------------------------- */

(async function main() {
  try {
    console.log('🚀 Starting Telegram Task Bot...');
    console.log('🔧 Environment:', {
      NODE_ENV: process.env.NODE_ENV,
      FORCE_IPV4: FORCE_IPV4,
      DB_SSL: process.env.DB_SSL !== 'false'
    });
    await testDatabaseConnection();
    await initTables();
    // small delay to ensure DB is ready; then reschedule
    setTimeout(rescheduleAll, 2000);
    console.log('✅ Bot started and polling for Telegram updates.');
  } catch (err) {
    console.error('❌ Startup error', err);
    process.exit(1);
  }
})();
