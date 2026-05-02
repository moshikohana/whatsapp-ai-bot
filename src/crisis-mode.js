'use strict';
/**
 * Crisis War-Room mode.
 *
 * When N or more "critical" keyword alerts fire within a short sliding
 * window (e.g. 3 alerts in 30 min), the bot transitions from sending
 * individual alerts to a consolidated war-room response that includes:
 *   - aggregated scan-group activity on the topic
 *   - web search for context
 *   - a draft spokesperson response (Kellner-style)
 * This is triggered automatically by recordAlert() returning a trigger
 * payload. While crisis is active, individual alerts are suppressed
 * (the war-room thread is the single source of truth).
 *
 * Critical keywords are intentionally narrow — only words that signal
 * breaking news / danger / political-bombshell. The user can edit this
 * list anytime by editing data/crisis-keywords.json (auto-loaded).
 */

const fs = require('fs');
const path = require('path');

const ALERTS_FILE = path.join(__dirname, '..', 'data', 'crisis-recent-alerts.json');
const STATE_FILE = path.join(__dirname, '..', 'data', 'crisis-state.json');
const KEYWORDS_FILE = path.join(__dirname, '..', 'data', 'crisis-keywords.json');

const WINDOW_MINUTES = 30;
const TRIGGER_COUNT = 3;
const CRISIS_TIMEOUT_MINUTES = 60;       // auto-end crisis after 60 min of inactivity

// Built-in critical keywords — overridable by data/crisis-keywords.json
const DEFAULT_CRITICAL_KEYWORDS = [
  'מיידי', 'דרמה', 'ירי', 'התנקשות', 'פיגוע', 'חירום',
  'מתקפה', 'הרוג', 'נפצע', 'נחטף', 'דחוף',
  'בהול', 'משבר', 'קריסה', 'הופלה',
];

function loadCriticalKeywords() {
  try {
    if (fs.existsSync(KEYWORDS_FILE)) {
      const data = JSON.parse(fs.readFileSync(KEYWORDS_FILE, 'utf8'));
      const arr = Array.isArray(data) ? data : (Array.isArray(data?.keywords) ? data.keywords : null);
      if (arr && arr.length) return arr;
    }
  } catch (_) {}
  return DEFAULT_CRITICAL_KEYWORDS;
}

function isCriticalKeyword(keyword) {
  if (!keyword) return false;
  const list = loadCriticalKeywords();
  return list.includes(keyword) || list.some(k => keyword.includes(k));
}

// ── Alerts log (sliding window) ─────────────────────────────────
function loadAlerts() {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    }
  } catch (_) {}
  return [];
}

function saveAlerts(alerts) {
  try {
    if (!fs.existsSync(path.dirname(ALERTS_FILE))) fs.mkdirSync(path.dirname(ALERTS_FILE), { recursive: true });
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
  } catch (_) {}
}

function pruneOldAlerts(alerts) {
  const cutoff = Date.now() - WINDOW_MINUTES * 60 * 1000;
  return alerts.filter(a => a.ts > cutoff);
}

/**
 * Record a critical alert and return a trigger payload if the war-room
 * threshold is crossed (N alerts in the window AND no crisis already
 * active).
 */
function recordAlert({ keyword, group, sender, preview }) {
  if (!isCriticalKeyword(keyword)) return null;

  const all = pruneOldAlerts(loadAlerts());
  const entry = { ts: Date.now(), keyword, group: group || '', sender: sender || '', preview: preview || '' };
  all.push(entry);
  saveAlerts(all);

  if (all.length < TRIGGER_COUNT) return null;
  if (isCrisisActive()) return null; // already in war-room mode

  // Threshold crossed → return trigger data
  return {
    count: all.length,
    alerts: all,
    keywords: [...new Set(all.map(a => a.keyword))],
    groups: [...new Set(all.map(a => a.group).filter(Boolean))],
    spanMinutes: Math.round((all[all.length - 1].ts - all[0].ts) / 60000),
  };
}

// ── Crisis state ─────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function saveState(state) {
  try {
    if (state) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch (_) {}
}

function isCrisisActive() {
  const s = loadState();
  if (!s) return false;
  // Auto-expire if > timeout
  const ageMin = (Date.now() - s.startedAt) / 60000;
  if (ageMin > CRISIS_TIMEOUT_MINUTES) {
    saveState(null);
    return false;
  }
  return true;
}

function startCrisis(triggerData) {
  saveState({
    startedAt: Date.now(),
    triggerCount: triggerData.count,
    triggerKeywords: triggerData.keywords,
    triggerGroups: triggerData.groups,
    spanMinutes: triggerData.spanMinutes,
  });
}

function endCrisis() {
  saveState(null);
}

function getActiveCrisis() {
  return isCrisisActive() ? loadState() : null;
}

module.exports = {
  recordAlert,
  isCriticalKeyword,
  isCrisisActive,
  startCrisis,
  endCrisis,
  getActiveCrisis,
  loadCriticalKeywords,
  // for tests
  WINDOW_MINUTES,
  TRIGGER_COUNT,
};
