'use strict';
const fs = require('fs');
const path = require('path');
const ALERTS_PATH = path.join(__dirname, '..', 'data', 'keyword-alerts.json');
const LOG_PATH    = path.join(__dirname, '..', 'data', 'keyword-alerts-log.json');

const DEFAULT_KEYWORDS = [
  'קלנר', 'אריאל קלנר', 'ח"כ קלנר',
  'הצבעה', 'בגץ', 'דחוף', 'מיידי',
  'כינוס חירום', 'חדשות אחרונות'
];

function loadConfig() {
  try {
    if (!fs.existsSync(ALERTS_PATH)) {
      const def = { enabled: true, keywords: DEFAULT_KEYWORDS, alertedToday: {} };
      fs.writeFileSync(ALERTS_PATH, JSON.stringify(def, null, 2), 'utf8');
      return def;
    }
    return JSON.parse(fs.readFileSync(ALERTS_PATH, 'utf8'));
  } catch { return { enabled: true, keywords: DEFAULT_KEYWORDS, alertedToday: {} }; }
}

function saveConfig(cfg) {
  fs.writeFileSync(ALERTS_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ── Alert log ────────────────────────────────────────────────────
function loadLog() {
  try {
    if (!fs.existsSync(LOG_PATH)) return { entries: [] };
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  } catch { return { entries: [] }; }
}

function saveLog(log) {
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), 'utf8');
}

/**
 * Log a keyword alert hit.
 * @param {string} keyword  - matched keyword
 * @param {string} group    - group name
 * @param {string} sender   - sender name ('אתה' for owner)
 * @param {string} preview  - first 120 chars of the message
 */
function logAlert(keyword, group, sender, preview) {
  try {
    const log = loadLog();
    log.entries.push({
      keyword,
      group,
      sender,
      preview: preview.substring(0, 120),
      timestamp: Date.now(),
      date: new Date().toLocaleDateString('he-IL'),
      time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
    });
    // Keep last 500 entries
    if (log.entries.length > 500) log.entries = log.entries.slice(-500);
    saveLog(log);
  } catch { /* non-critical */ }
}

/**
 * Returns formatted stats string for the user.
 * Groups by keyword → then by group → with times.
 */
function getStats() {
  const log = loadLog();
  if (!log.entries.length) return '📊 אין עדיין התראות מוקלטות.';

  // Build keyword → group → entries map
  const map = new Map(); // keyword → Map(group → [{time, sender, preview}])
  for (const e of log.entries) {
    if (!map.has(e.keyword)) map.set(e.keyword, new Map());
    const gMap = map.get(e.keyword);
    if (!gMap.has(e.group)) gMap.set(e.group, []);
    gMap.get(e.group).push({ time: e.time, date: e.date, sender: e.sender, preview: e.preview });
  }

  // Sort keywords by total count desc
  const sortedKws = [...map.entries()].sort((a, b) => {
    const totalA = [...a[1].values()].reduce((s, arr) => s + arr.length, 0);
    const totalB = [...b[1].values()].reduce((s, arr) => s + arr.length, 0);
    return totalB - totalA;
  });

  let out = `📊 *דוח התראות מילות מפתח*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const [kw, gMap] of sortedKws) {
    const total = [...gMap.values()].reduce((s, arr) => s + arr.length, 0);
    out += `🔑 *${kw}* — ${total} אזכורים\n`;
    for (const [grp, hits] of [...gMap.entries()].sort((a, b) => b[1].length - a[1].length)) {
      // Show up to 5 most recent times
      const times = hits.slice(-5).map(h => `${h.date} ${h.time} (${h.sender})`).join(', ');
      out += `   📍 ${grp} (${hits.length}): ${times}\n`;
    }
    out += '\n';
  }

  const cfg = loadConfig();
  out += `━━━━━━━━━━━━━━━━━━━━\n`;
  out += `📋 *כל המילות המנוטרות (${cfg.keywords.length}):*\n`;
  out += cfg.keywords.map(k => `• ${k}`).join('\n');

  return out.trim();
}

function checkMessage(text, groupName) {
  const cfg = loadConfig();
  if (!cfg.enabled) return null;
  const lower = text.toLowerCase();
  for (const kw of cfg.keywords) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

function addKeyword(kw) {
  const cfg = loadConfig();
  if (!cfg.keywords.includes(kw)) { cfg.keywords.push(kw); saveConfig(cfg); }
  return cfg.keywords;
}

function removeKeyword(kw) {
  const cfg = loadConfig();
  cfg.keywords = cfg.keywords.filter(k => k !== kw);
  saveConfig(cfg);
  return cfg.keywords;
}

function setEnabled(v) {
  const cfg = loadConfig();
  cfg.enabled = v;
  saveConfig(cfg);
}

function getStatus() {
  return loadConfig();
}

module.exports = { checkMessage, addKeyword, removeKeyword, setEnabled, getStatus, logAlert, getStats };
