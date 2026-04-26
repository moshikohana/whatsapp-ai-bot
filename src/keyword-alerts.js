'use strict';
const fs = require('fs');
const path = require('path');
const ALERTS_PATH = path.join(__dirname, '..', 'data', 'keyword-alerts.json');
const LOG_PATH    = path.join(__dirname, '..', 'data', 'keyword-alerts-log.json');
const BLOCKED_PATH = path.join(__dirname, '..', 'data', 'blocked-groups.json');

const DEFAULT_KEYWORDS = [
  'קלנר', 'אריאל קלנר', 'ח"כ קלנר',
  'הצבעה', 'בגץ', 'דחוף', 'מיידי',
  'כינוס חירום', 'חדשות אחרונות'
];

// ── Blocklist (substring-match on group names) ───────────────────
function loadBlockedPatterns() {
  try {
    if (!fs.existsSync(BLOCKED_PATH)) return [];
    const arr = JSON.parse(fs.readFileSync(BLOCKED_PATH, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function isBlockedGroup(groupName) {
  if (!groupName) return false;
  const patterns = loadBlockedPatterns();
  return patterns.some(p => groupName.includes(p));
}

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
    // Skip blocked groups — don't pollute the alerts log
    if (isBlockedGroup(group)) return;
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

// ── Today's alerts ────────────────────────────────────────────────
/**
 * Returns today's keyword hits as a formatted string, sorted by time.
 */
function getTodayAlerts() {
  const log = loadLog();
  const today = new Date().toLocaleDateString('he-IL');
  const todayEntries = log.entries.filter(e => e.date === today && !isBlockedGroup(e.group));

  if (!todayEntries.length) {
    const cfg = loadConfig();
    return `📊 *אין התראות היום* (${today})\n\n💤 שקט — לא אותרו מילות מפתח\n\n` +
      `🔍 *מנוטר:* ${cfg.keywords.length} מילות מפתח בכל הקבוצות\n` +
      cfg.keywords.map(k => `• ${k}`).join('\n');
  }

  const sorted = [...todayEntries].sort((a, b) => a.timestamp - b.timestamp);

  let out = `🔔 *התראות היום — ${today}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const e of sorted) {
    out += `⏰ *${e.time}*  🔑 "${e.keyword}"\n`;
    out += `   📍 ${e.group}  |  👤 ${e.sender}\n`;
    out += `   💬 _"${e.preview.substring(0, 90)}${e.preview.length > 90 ? '...' : ''}"_\n\n`;
  }

  // Per-group summary
  const byGroup = {};
  for (const e of todayEntries) byGroup[e.group] = (byGroup[e.group] || 0) + 1;
  const groupLines = Object.entries(byGroup)
    .sort((a, b) => b[1] - a[1])
    .map(([g, c]) => `   • ${g} — ${c} התראות`)
    .join('\n');

  // Per-keyword summary
  const byKw = {};
  for (const e of todayEntries) byKw[e.keyword] = (byKw[e.keyword] || 0) + 1;
  const kwLines = Object.entries(byKw)
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => `   • "${k}" — ${c}×`)
    .join('\n');

  out += `━━━━━━━━━━━━━━━━━━━━\n`;
  out += `📊 *סה"כ ${todayEntries.length} התראות היום*\n\n`;
  out += `*📍 פי קבוצה:*\n${groupLines}\n\n`;
  out += `*🔑 פי מילה:*\n${kwLines}`;

  return out.trim();
}

// ── Active groups (from log history) ─────────────────────────────
/**
 * Returns groups that ever had a keyword hit, sorted by most recent.
 */
function getActiveGroups() {
  const log = loadLog();
  if (!log.entries.length) return [];
  const groupMap = new Map();
  for (const e of log.entries) {
    if (isBlockedGroup(e.group)) continue;
    const existing = groupMap.get(e.group);
    if (!existing) {
      groupMap.set(e.group, { name: e.group, lastHit: e.timestamp, lastDate: e.date, lastTime: e.time, count: 1 });
    } else {
      existing.count++;
      if (e.timestamp > existing.lastHit) {
        existing.lastHit = e.timestamp;
        existing.lastDate = e.date;
        existing.lastTime = e.time;
      }
    }
  }
  return [...groupMap.values()].sort((a, b) => b.lastHit - a.lastHit);
}

// ── Rich status display ───────────────────────────────────────────
/**
 * Returns a full formatted status string for display to the user.
 */
function getFullStatus() {
  const cfg = loadConfig();
  const log = loadLog();
  const today = new Date().toLocaleDateString('he-IL');
  const todayCount = log.entries.filter(e => e.date === today && !isBlockedGroup(e.group)).length;
  const activeGroups = getActiveGroups();

  let out = `🚨 *ניטור מילות מפתח*\n━━━━━━━━━━━━━━━━━━━━\n`;
  out += `${cfg.enabled ? '✅ *פעיל*' : '❌ *כבוי*'} | 📊 היום: *${todayCount}* התראות\n`;
  out += `🌐 *פועל בכל הקבוצות שהבוט חלק מהן*\n\n`;

  // Keywords
  out += `🔑 *מילות מפתח (${cfg.keywords.length}):*\n`;
  out += cfg.keywords.map(k => `• ${k}`).join('\n');
  out += '\n\n';

  // Active groups from history
  if (activeGroups.length > 0) {
    out += `📍 *קבוצות שהפעילו התראות בעבר:*\n`;
    out += activeGroups.slice(0, 10).map(g =>
      `• ${g.name} — ${g.count} התראות (אחרונה: ${g.lastDate} ${g.lastTime})`
    ).join('\n');
    if (activeGroups.length > 10) out += `\n_+ עוד ${activeGroups.length - 10} קבוצות_`;
  } else {
    out += `📍 *קבוצות:* עדיין לא נרשמו התראות`;
  }

  out += `\n\n💡 _"התראות היום" — רשימת כל ההתראות של היום_\n`;
  out += `💡 _"דוח התראות" — סטטיסטיקות לפי מילה_`;

  return out.trim();
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
    if (isBlockedGroup(e.group)) continue;
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

// ── Trend detection (today vs yesterday) ─────────────────────────
/**
 * Returns the timestamp of the most recent midnight in Israel local time.
 * Uses the 'he-IL' locale (Asia/Jerusalem) so DST is handled implicitly.
 */
function getIsraelMidnight(daysAgo = 0) {
  const now = new Date();
  // Get Y/M/D components in Israel time
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const y = parseInt(lookup.year, 10);
  const m = parseInt(lookup.month, 10);
  const d = parseInt(lookup.day, 10);
  // Construct a Date at Israel-local midnight. Asia/Jerusalem is UTC+2 (IST) or UTC+3 (IDT).
  // We compute the UTC instant that matches "YYYY-MM-DD 00:00" Israel time by
  // iterating: build a candidate and verify via toLocaleString.
  const candidate = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  // Determine Israel offset at that instant.
  const israelStr = candidate.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour12: false });
  // Parse back the Israel-local "M/D/Y, H:M:S"
  const match = israelStr.match(/(\d+)\/(\d+)\/(\d+),\s*(\d+):(\d+):(\d+)/);
  let offsetMs = 0;
  if (match) {
    const israelHour = parseInt(match[4], 10);
    // If israelHour is not 0 the UTC instant is offset — shift by -israelHour hours.
    offsetMs = israelHour * 3600 * 1000;
  }
  const midnightTs = candidate.getTime() - offsetMs - daysAgo * 24 * 3600 * 1000;
  return midnightTs;
}

/**
 * Compare today vs yesterday's keyword frequencies and return trending keywords.
 * A keyword is "trending" if:
 *   todayCount >= minHits  AND
 *   (todayCount / max(yesterdayCount, 1)) >= minRatio
 * (The `max(..., 1)` ensures a fallback ratio when yesterday=0 and today≥minHits.)
 *
 * @param {{minHits?: number, minRatio?: number}} options
 * @returns {Array<{keyword: string, today: number, yesterday: number, ratio: number, direction: 'up'|'new', groups: string[]}>}
 */
function getTrends({ minHits = 3, minRatio = 2 } = {}) {
  const log = loadLog();
  if (!log.entries.length) return [];

  const todayStart = getIsraelMidnight(0);
  const yesterdayStart = getIsraelMidnight(1);
  // todayEnd is "now" (so we include up to the current moment).
  // yesterdayEnd is todayStart.

  const todayCounts = new Map();    // keyword → count
  const yesterdayCounts = new Map();
  const todayGroups = new Map();    // keyword → Set<group>

  for (const e of log.entries) {
    if (isBlockedGroup(e.group)) continue;
    const ts = e.timestamp;
    if (ts >= todayStart) {
      todayCounts.set(e.keyword, (todayCounts.get(e.keyword) || 0) + 1);
      if (!todayGroups.has(e.keyword)) todayGroups.set(e.keyword, new Set());
      todayGroups.get(e.keyword).add(e.group);
    } else if (ts >= yesterdayStart && ts < todayStart) {
      yesterdayCounts.set(e.keyword, (yesterdayCounts.get(e.keyword) || 0) + 1);
    }
  }

  const trends = [];
  for (const [kw, todayCount] of todayCounts.entries()) {
    if (todayCount < minHits) continue;
    const yesterdayCount = yesterdayCounts.get(kw) || 0;
    const ratio = todayCount / Math.max(yesterdayCount, 1);
    if (ratio < minRatio) continue;
    trends.push({
      keyword: kw,
      today: todayCount,
      yesterday: yesterdayCount,
      ratio,
      direction: yesterdayCount === 0 ? 'new' : 'up',
      groups: [...(todayGroups.get(kw) || new Set())],
    });
  }

  trends.sort((a, b) => b.ratio - a.ratio);
  return trends;
}

/**
 * Format a trends array into a WhatsApp-ready string.
 * @param {Array} trends - output of getTrends()
 * @returns {string}
 */
function formatTrendsMessage(trends) {
  if (!trends || !trends.length) {
    return `📈 *מגמות היום*\n━━━━━━━━━━━━━━━━━━━━\n\n💤 אין מגמות משמעותיות היום\n\n_לא זוהו מילות מפתח עם עלייה חריגה לעומת אתמול._`;
  }

  let out = `📈 *מגמות היום*\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const t of trends) {
    let icon;
    let ratioLabel;
    if (t.direction === 'new') {
      icon = '🆕';
      ratioLabel = 'חדש';
    } else if (t.ratio >= 3) {
      icon = '🚨';
      ratioLabel = `×${Math.round(t.ratio)}`;
    } else {
      icon = '📈';
      ratioLabel = `×${t.ratio.toFixed(1)}`;
    }

    if (t.direction === 'new') {
      out += `${icon} "${t.keyword}" — ${t.today} אזכורים (אתמול: 0) — ${ratioLabel}\n`;
    } else {
      out += `${icon} "${t.keyword}" — ${t.today} אזכורים היום (אתמול: ${t.yesterday}) — ${ratioLabel}\n`;
    }
    if (t.groups && t.groups.length) {
      out += `   📍 ${t.groups.join(', ')}\n`;
    }
    out += '\n';
  }

  return out.trimEnd();
}

module.exports = {
  checkMessage, addKeyword, removeKeyword, setEnabled, getStatus,
  logAlert, getStats, getTodayAlerts, getActiveGroups, getFullStatus,
  isBlockedGroup, loadBlockedPatterns,
  getTrends, formatTrendsMessage,
};
