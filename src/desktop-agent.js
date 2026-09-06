'use strict';
/**
 * סוכן שולחני — the bridge between WhatsApp and the owner's own computer.
 *
 * A tiny agent runs on his PC and connects OUT to this server over the
 * existing socket.io endpoint (no port forwarding, no inbound firewall hole).
 * The bot can then ask it to do things *as him*, on his machine, with his
 * already-logged-in browser — which is the whole point: server-side APIs for
 * X / Meta / TikTok are blocked or paid, his browser is already authenticated.
 *
 * THIS IS THE SKELETON. Publishing is deliberately NOT wired up — the owner
 * isn't posting for Kellner yet. What exists here is the transport, the auth,
 * the action whitelist, and the ACCOUNTS interface he'll pick a target with
 * when publishing is switched on later.
 *
 * Safety model (these accounts belong to a sitting MK):
 *   • the agent authenticates with a shared secret (AGENT_SECRET in .env);
 *   • only whitelisted, named actions can run — never arbitrary shell;
 *   • every action is logged with who asked and when;
 *   • anything public-facing must go through an explicit approval step.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'desktop-agent.json');
const LOG_FILE = path.join(__dirname, '..', 'data', 'desktop-agent-log.json');

// Actions the agent is permitted to perform. Anything not listed is refused
// by BOTH sides — the server won't send it and the agent won't run it.
const ACTIONS = {
  ping:       { desc: 'בדיקת חיבור', publicFacing: false },
  screenshot: { desc: 'צילום מסך', publicFacing: false },
  open_url:   { desc: 'פתיחת קישור בדפדפן', publicFacing: false },
  notify:     { desc: 'התראה על המסך', publicFacing: false },
  clip_set:   { desc: 'העתקה ללוח של המחשב', publicFacing: false },
  clip_get:   { desc: 'קריאת הלוח מהמחשב', publicFacing: false },
  lock:       { desc: 'נעילת המחשב', publicFacing: false },
  windows:    { desc: 'מה פתוח עכשיו', publicFacing: false },
  downloads:  { desc: 'הורדות אחרונות', publicFacing: false },
  // Reserved for when publishing is enabled — declared so the interface can
  // show them, but the handler refuses until `publishing.enabled` is true.
  publish:    { desc: 'פרסום לרשת (מושבת)', publicFacing: true },
};

const DEFAULTS = {
  publishing: { enabled: false },   // master switch — off until he says otherwise
  activeAccount: null,
  accounts: [],                     // { id, label, platform, note }
};

let cfg = null;
let agents = new Map();             // socketId → { name, connectedAt, socket }
const pending = new Map();          // requestId → { resolve, timer }

function loadConfig() {
  if (cfg) return cfg;
  try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { cfg = JSON.parse(JSON.stringify(DEFAULTS)); }
  return cfg;
}
function saveConfig(next) {
  cfg = { ...loadConfig(), ...(next || {}) };
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {}
  return cfg;
}
function _log(entry) {
  try {
    let log = [];
    try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
    log.push({ ...entry, ts: Date.now() });
    fs.writeFileSync(LOG_FILE, JSON.stringify(log.slice(-300), null, 2));
  } catch {}
}

// ── Transport ────────────────────────────────────────────────────
// Called once from index.js with the live socket.io server.
function attach(io) {
  io.on('connection', (socket) => {
    // A desktop agent identifies itself; browsers using the same socket.io
    // endpoint for the QR page simply never send this event.
    socket.on('agent:hello', (payload = {}, ack) => {
      const secret = process.env.AGENT_SECRET || '';
      if (!secret || payload.secret !== secret) {
        logger.warn('🖥️ agent rejected — bad secret');
        if (typeof ack === 'function') ack({ ok: false, error: 'bad secret' });
        return;
      }
      const name = String(payload.name || 'PC').substring(0, 40);
      agents.set(socket.id, { name, connectedAt: Date.now(), socket });
      logger.info(`🖥️ Desktop agent connected: ${name}`);
      _log({ event: 'connect', agent: name });
      if (typeof ack === 'function') ack({ ok: true, actions: Object.keys(ACTIONS) });
    });

    socket.on('agent:result', (res = {}) => {
      const p = pending.get(res.requestId);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(res.requestId);
      p.resolve(res);
    });

    socket.on('disconnect', () => {
      const a = agents.get(socket.id);
      if (a) { logger.info(`🖥️ Desktop agent disconnected: ${a.name}`); _log({ event: 'disconnect', agent: a.name }); }
      agents.delete(socket.id);
    });
  });
}

function connected() { return [...agents.values()].map(a => ({ name: a.name, connectedAt: a.connectedAt })); }
function isConnected() { return agents.size > 0; }

// Send a whitelisted action to the agent and wait for its reply.
function run(action, params = {}, timeoutMs = 45000) {
  return new Promise((resolve) => {
    if (!ACTIONS[action]) return resolve({ ok: false, error: `פעולה לא מוכרת: ${action}` });
    if (!agents.size) return resolve({ ok: false, error: 'אין סוכן מחובר' });
    if (ACTIONS[action].publicFacing && !loadConfig().publishing.enabled) {
      return resolve({ ok: false, error: 'פרסום מושבת — הפעל אותו במפורש לפני שימוש' });
    }
    const entry = [...agents.values()][0];
    const requestId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, error: 'הסוכן לא הגיב בזמן' });
    }, timeoutMs);
    pending.set(requestId, { resolve, timer });
    _log({ event: 'action', action, params: Object.keys(params) });
    entry.socket.emit('agent:action', { requestId, action, params });
  });
}

// ── Accounts interface (for future publishing) ───────────────────
function addAccount(label, platform) {
  const c = loadConfig();
  const id = crypto.randomBytes(3).toString('hex');
  c.accounts.push({ id, label: label.trim(), platform: (platform || '').trim() || 'general' });
  if (!c.activeAccount) c.activeAccount = id;
  saveConfig(c);
  return c.accounts;
}
function removeAccount(id) {
  const c = loadConfig();
  c.accounts = c.accounts.filter(a => a.id !== id);
  if (c.activeAccount === id) c.activeAccount = c.accounts[0]?.id || null;
  saveConfig(c);
  return c.accounts;
}
function setActiveAccount(id) {
  const c = loadConfig();
  if (!c.accounts.some(a => a.id === id)) return null;
  saveConfig({ activeAccount: id });
  return c.accounts.find(a => a.id === id);
}
function setPublishing(on) { return saveConfig({ publishing: { enabled: !!on } }); }

function getStatus() {
  const c = loadConfig();
  const list = connected();
  const active = c.accounts.find(a => a.id === c.activeAccount);
  let out = `🖥️ *סוכן שולחני* — ${list.length ? '🟢 מחובר' : '🔴 לא מחובר'}\n`;
  if (list.length) {
    out += list.map(a => `   💻 *${a.name}* · מחובר מ-${new Date(a.connectedAt).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' })}`).join('\n') + '\n';
  }
  out += `\n📤 פרסום: ${c.publishing.enabled ? '🟢 מופעל' : '🔴 מושבת (כרגע לא מפרסמים)'}\n`;
  out += `👤 חשבון פעיל: ${active ? `*${active.label}* (${active.platform})` : '— לא נבחר'}\n`;
  out += `📋 חשבונות מוגדרים: ${c.accounts.length}\n`;
  out += `\n⚡ *פעולות זמינות:*\n` +
    Object.entries(ACTIONS).map(([k, v]) => `   ${v.publicFacing && !c.publishing.enabled ? '🔒' : '•'} \`${k}\` — ${v.desc}`).join('\n');
  out += `\n\n_פקודות:_ *סוכן צלם* · *סוכן פתח <קישור>* · *סוכן חשבונות* · *סוכן בדיקה*`;
  return out;
}


// Full command reference — the owner asked to always have this at hand.
function getHelp() {
  const c = loadConfig();
  const on = connected().length;
  return `🖥️ *פקודות הסוכן השולחני*
` +
    `_מצב: ${on ? '🟢 מחובר' : '🔴 המחשב לא מחובר — הפעל start-agent.bat'}_
` +
    `${'━'.repeat(18)}

` +
    `👁️ *לראות מה קורה במחשב*
` +
    `• *סוכן צלם* — צילום מסך מלא (נשלח כקובץ, ללא דחיסה)
` +
    `• *סוכן חלונות* — אילו תוכנות פתוחות עכשיו
` +
    `• *סוכן הורדות* — 10 הקבצים האחרונים שהורדת

` +
    `📋 *להעביר טקסט בין הטלפון למחשב*
` +
    `• *סוכן העתק <טקסט>* — שולח ללוח של המחשב (Ctrl+V שם)
` +
    `• *סוכן לוח* — מביא לך מה שמועתק במחשב

` +
    `⚡ *לבצע פעולות*
` +
    `• *סוכן פתח <קישור>* — פותח בדפדפן (בלי https גם עובד)
` +
    `• *סוכן התראה <טקסט>* — התראה קופצת על המסך
` +
    `• *סוכן נעל* — נועל את המחשב

` +
    `🔧 *ניהול*
` +
    `• *סוכן* — סטטוס
` +
    `• *סוכן בדיקה* — האם המחשב מחובר
` +
    `• *סוכן חשבונות* — רשימת חשבונות
` +
    `• *סוכן הוסף חשבון <שם> | <פלטפורמה>*
` +
    `• *סוכן חשבון <id>* — לבחור חשבון פעיל
` +
    `• *סוכן פרסום הפעל/כבה* — ${c.publishing.enabled ? '🟢 מופעל' : '🔴 מושבת'}

` +
    `💡 _טיפ:_ *סוכן העתק* הכי שימושי — מכין הפצה בוואטסאפ, שולח ללוח, ומדביק במחשב.`;
}

function listAccounts() {
  const c = loadConfig();
  if (!c.accounts.length) {
    return `👤 *אין חשבונות מוגדרים.*\n\nלהוסיף: *סוכן הוסף חשבון <שם> | <פלטפורמה>*\n_דוגמה:_ סוכן הוסף חשבון קלנר רשמי | facebook`;
  }
  return `👤 *חשבונות*\n\n` +
    c.accounts.map(a => `${a.id === c.activeAccount ? '✅' : '⬜'} *${a.label}* — ${a.platform} \`${a.id}\``).join('\n') +
    `\n\n_לבחור:_ *סוכן חשבון <id>* · _להסיר:_ *סוכן הסר חשבון <id>*`;
}

module.exports = {
  attach, run, connected, isConnected, getStatus, getHelp, listAccounts,
  addAccount, removeAccount, setActiveAccount, setPublishing, loadConfig, ACTIONS,
};
