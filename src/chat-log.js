'use strict';
const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');
const MAX_TEXT_LEN = 1000;

// ── Helpers ──────────────────────────────────────────────────────
function ensureLogsDir() {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  } catch { /* non-critical */ }
}

/**
 * Returns local Israel date as 'YYYY-MM-DD'.
 * Uses Asia/Jerusalem timezone regardless of server locale.
 */
function israelDateStr(d) {
  const date = d || new Date();
  try {
    // en-CA gives ISO-like 'YYYY-MM-DD' formatting
    return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  } catch {
    // Fallback to local date if timezone lookup fails
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

function logFilePathFor(dateStr) {
  return path.join(LOGS_DIR, `chat-${dateStr}.log`);
}

function truncateText(text) {
  if (typeof text !== 'string') return '';
  if (text.length <= MAX_TEXT_LEN) return text;
  const truncatedCount = text.length - MAX_TEXT_LEN;
  return text.substring(0, MAX_TEXT_LEN) + `...[truncated ${truncatedCount} chars]`;
}

// ── Public API ───────────────────────────────────────────────────
/**
 * Append a chat-log entry for a single user↔bot message.
 * @param {object}   opts
 * @param {string}   opts.from       sender name ('מושיקו' or 'בוטי')
 * @param {string}   opts.text       message content (may be long)
 * @param {string}   opts.direction  'in' (user→bot) or 'out' (bot→user)
 * @param {string}  [opts.chatId]    WhatsApp chat ID (e.g. '972524243250@c.us')
 * @param {object}  [opts.extra]     optional metadata (toolCalls, errors, etc.)
 */
function appendChatLog({ from, text, direction, chatId, extra } = {}) {
  try {
    ensureLogsDir();
    const now = new Date();
    const entry = {
      ts: now.toISOString(),
      from: from || '',
      dir: direction || '',
      chatId: chatId || '',
      text: truncateText(text == null ? '' : String(text)),
    };
    if (extra && typeof extra === 'object') entry.extra = extra;

    const line = JSON.stringify(entry) + '\n';
    const filePath = logFilePathFor(israelDateStr(now));
    fs.appendFileSync(filePath, line, 'utf8');
  } catch { /* non-critical — never throw */ }
}

/**
 * Read all chat-log entries for the given date.
 * @param {string} date 'YYYY-MM-DD'
 * @returns {Array<object>} parsed entries, or [] if file is missing.
 *                          Invalid lines are skipped silently.
 */
function readChatLog(date) {
  try {
    if (!date || typeof date !== 'string') return [];
    const filePath = logFilePathFor(date);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const entries = [];
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch { /* skip invalid line */ }
    }
    return entries;
  } catch {
    return [];
  }
}

module.exports = {
  appendChatLog,
  readChatLog,
};
