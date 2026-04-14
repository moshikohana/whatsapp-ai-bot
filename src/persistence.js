'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');
const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled.json');
const DAILY_FILE = path.join(DATA_DIR, 'daily.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Safe JSON read/write ──────────────────────────────────────
function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`⚠️ Failed to read ${path.basename(file)}:`, err.message);
  }
  return fallback;
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`⚠️ Failed to write ${path.basename(file)}:`, err.message);
  }
}

// ─── Conversations ─────────────────────────────────────────────
// Save only last N messages per chat, debounced to avoid disk thrashing

let conversationsCache = null;
let saveTimer = null;
const SAVE_DEBOUNCE = 5000; // 5 seconds

function loadConversations() {
  if (!conversationsCache) {
    const raw = readJSON(CONVERSATIONS_FILE, {});
    conversationsCache = new Map(Object.entries(raw));
  }
  return conversationsCache;
}

function saveConversations(conversations) {
  // Convert Map to plain object for JSON
  const obj = {};
  for (const [k, v] of conversations) {
    // Only save last 14 messages per chat (7 turns)
    obj[k] = v.slice(-14);
  }
  conversationsCache = conversations;

  // Debounce writes
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeJSON(CONVERSATIONS_FILE, obj);
  }, SAVE_DEBOUNCE);
}

// Force save (call on shutdown)
function flushConversations() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (conversationsCache) {
    const obj = {};
    for (const [k, v] of conversationsCache) {
      obj[k] = v.slice(-14);
    }
    writeJSON(CONVERSATIONS_FILE, obj);
  }
}

// ─── Scheduled Tasks ───────────────────────────────────────────
// Save scheduled task metadata (not the timer itself — recreated on load)

function loadScheduledTasks() {
  return readJSON(SCHEDULED_FILE, []);
}

function saveScheduledTasks(scheduledMap) {
  const arr = [];
  for (const [id, s] of scheduledMap) {
    arr.push({
      id,
      type: s.type,
      target: s.target,
      message: s.message,
      subject: s.subject || null,
      sendAt: s.sendAt instanceof Date ? s.sendAt.toISOString() : s.sendAt,
      label: s.label,
    });
  }
  writeJSON(SCHEDULED_FILE, arr);
}

// ─── Daily Tasks ───────────────────────────────────────────────

function loadDailyTasks() {
  return readJSON(DAILY_FILE, []);
}

function saveDailyTasks(dailyMap) {
  const arr = [];
  for (const [id, d] of dailyMap) {
    arr.push({
      id,
      time: d.time,
      action: d.action,
      params: d.params,
      label: d.label,
    });
  }
  writeJSON(DAILY_FILE, arr);
}

module.exports = {
  loadConversations, saveConversations, flushConversations,
  loadScheduledTasks, saveScheduledTasks,
  loadDailyTasks, saveDailyTasks,
};
