'use strict';
/**
 * Reminders — local, file-backed. The bot fires the timer in-process so it
 * works only while the Electron app is running. Auto-start at boot is the
 * user's safety net.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.BOT_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'reminders.json');

let reminders = [];
let _idCounter = 1;
const _timers = new Map();
let _ownerChat = null;  // wired up by run() — chat to send reminders to

function _load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    reminders = Array.isArray(raw.items) ? raw.items : [];
    _idCounter = raw.nextId || (reminders.reduce((m, r) => Math.max(m, r.id), 0) + 1);
  } catch { reminders = []; _idCounter = 1; }
}
function _save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ nextId: _idCounter, items: reminders }, null, 2), 'utf8');
  } catch (e) { console.warn('reminder save failed:', e.message); }
}
_load();

function _scheduleAll() {
  // Clear existing timers, then re-schedule based on current `reminders` array
  for (const t of _timers.values()) clearTimeout(t);
  _timers.clear();
  const now = Date.now();
  for (const r of reminders) {
    const ms = r.fireAt - now;
    if (ms <= 0) {
      // Already passed while bot was off — fire immediately with a "missed" note
      setImmediate(() => _fire(r, true));
      continue;
    }
    const tid = setTimeout(() => _fire(r, false), ms);
    _timers.set(r.id, tid);
  }
}

async function _fire(rem, missed) {
  try {
    if (_ownerChat) {
      const prefix = missed ? '⏰ *תזכורת (איחור — הבוט היה כבוי בזמן):*\n' : '⏰ *תזכורת:*\n';
      await _ownerChat.sendMessage(prefix + rem.text + '​​​');
    }
    // Remove fired reminder
    reminders = reminders.filter(r => r.id !== rem.id);
    _timers.delete(rem.id);
    _save();
  } catch (e) {
    console.warn('reminder fire failed:', e.message);
  }
}

async function run({ action, text, when_minutes, index }, context) {
  // Update ownerChat each invocation so it always reflects current chat
  if (context?.ownerChat) _ownerChat = context.ownerChat;

  switch (action) {
    case 'add': {
      if (!text) return '❌ חסר טקסט לתזכורת';
      if (!when_minutes || when_minutes <= 0) return '❌ חסר when_minutes (מספר חיובי)';
      const id = _idCounter++;
      const fireAt = Date.now() + when_minutes * 60 * 1000;
      reminders.push({ id, text, fireAt, createdAt: Date.now() });
      _save();
      _scheduleAll();
      const when = new Date(fireAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `✅ תזכורת #${id} נקבעה: "${text}" — ${when}`;
    }
    case 'list': {
      if (!reminders.length) return '📋 אין תזכורות פעילות.';
      return '📋 *תזכורות:*\n' + reminders.map(r => {
        const w = new Date(r.fireAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        return `#${r.id} — ${r.text} (${w})`;
      }).join('\n');
    }
    case 'delete': {
      const id = parseInt(index);
      if (!id) return '❌ חסר index';
      const before = reminders.length;
      reminders = reminders.filter(r => r.id !== id);
      if (reminders.length === before) return `❌ לא נמצאה תזכורת #${id}`;
      _save();
      _scheduleAll();
      return `✅ תזכורת #${id} נמחקה.`;
    }
    default:
      return `❌ פעולה לא מוכרת: ${action}`;
  }
}

// Kick off scheduling on module load
_scheduleAll();

module.exports = { run };
