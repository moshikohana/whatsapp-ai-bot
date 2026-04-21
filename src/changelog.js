'use strict';

const fs = require('fs');
const path = require('path');

const CHANGELOG_PATH = path.join(__dirname, '..', 'data', 'changelog.json');

/**
 * Load changelog entries from disk.
 * Returns an array sorted newest-first (by date string, ISO-safe).
 */
function loadChangelog() {
  try {
    const raw = fs.readFileSync(CHANGELOG_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Format a single entry for display.
 * Entry shape: { version, date, features: [{ emoji, title, description? }] }
 */
function formatEntry(entry) {
  const dateObj = new Date(entry.date);
  const dateHe = dateObj.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  let out = `━━━━━━━━━━━━━━━━━━━━\n`;
  out += `📅 *${dateHe}  —  גרסה ${entry.version}*\n`;
  out += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const f of (entry.features || [])) {
    out += `${f.emoji || '•'} *${f.title}*`;
    if (f.description) out += `\n  _${f.description}_`;
    out += '\n';
  }
  return out.trimEnd();
}

/**
 * Returns a Hebrew-formatted string of recent changelog entries.
 * @param {number} [limit=3]  How many version entries to include (newest first).
 */
function formatChangelog(limit = 3) {
  const entries = loadChangelog();
  if (!entries.length) {
    return '📭 אין עדכונים רשומים עדיין.';
  }

  // Sort by date descending (ISO strings compare lexicographically)
  const sorted = [...entries].sort((a, b) => (b.date > a.date ? 1 : -1));
  const slice = sorted.slice(0, limit);

  let out = `╭──── *🆕 עדכוני בוטי* ────╮\n╰───────────────────────╯\n\n`;
  out += slice.map(formatEntry).join('\n\n');
  out += `\n\n_רוצה לראות עוד? כתוב "מה חדש בבוט"_ 😊`;
  return out;
}

module.exports = { formatChangelog };
