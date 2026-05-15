'use strict';
/**
 * Memory tool — user-level facts and preferences.
 * Stored as a JSON array. Kept simple; no embedding/RAG — Claude already
 * has full memory in the system prompt context (we pass list on demand).
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.BOT_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'memory.json');

let memory = [];
function _load() {
  try { memory = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!Array.isArray(memory)) memory = []; }
  catch { memory = []; }
}
function _save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(memory, null, 2), 'utf8');
  } catch (e) { console.warn('memory save failed:', e.message); }
}
_load();

async function run({ action, text, index }) {
  switch (action) {
    case 'save': {
      const v = (text || '').trim();
      if (!v) return '❌ חסר טקסט לזכירה';
      if (memory.some(m => m.text === v)) return 'הזיכרון הזה כבר קיים.';
      memory.push({ text: v, date: new Date().toISOString() });
      _save();
      return `✅ זכרתי: "${v}"`;
    }
    case 'list': {
      if (!memory.length) return '📋 אין זיכרונות שמורים עדיין.';
      return '🧠 *מה אני זוכר עליך:*\n' + memory.map((m, i) => `${i + 1}. ${m.text}`).join('\n');
    }
    case 'delete': {
      const i = parseInt(index) - 1;
      if (isNaN(i) || i < 0 || i >= memory.length) return `❌ אינדקס לא תקין. יש ${memory.length} זיכרונות.`;
      const removed = memory.splice(i, 1)[0];
      _save();
      return `✅ נמחק: "${removed.text}"`;
    }
    default:
      return `❌ פעולה לא מוכרת: ${action}`;
  }
}

module.exports = { run };
