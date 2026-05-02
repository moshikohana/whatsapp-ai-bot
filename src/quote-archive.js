'use strict';
/**
 * Quote Archive — every approved Kellner spokesperson quote / press
 * pitch / public response gets stored here with rich metadata so we can
 * later answer questions like:
 *   "What did we say to Daniel Beshakh about בג"ץ in the past 90 days?"
 *   "Was there a similar response to this topic before?"
 *
 * Stored as a JSON array (not JSONL — small dataset, easy to inspect).
 * Each entry:
 * {
 *   id: "Q-2026-05-02-001",
 *   date: "2026-05-02T13:30:00.000Z",
 *   topic: "בג\"ץ — קריסת ועדת חקירה",
 *   type: "תגובה דוברות" | "פנייה לתקשורת" | "ציוץ X" | "טיוטה",
 *   channel: "ערוץ 14 — דניאל בשך" | null,
 *   text: "ח\"כ קלנר (ליכוד): ...",
 *   tags: ["בג\"ץ", "חקיקה", "ועדת חקירה"],
 *   result: "פורסם 30.4 בכותרת" | null,
 * }
 */

const fs = require('fs');
const path = require('path');

const ARCHIVE_FILE = path.join(__dirname, '..', 'data', 'quote-archive.json');

function load() {
  try {
    if (!fs.existsSync(ARCHIVE_FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function save(items) {
  try {
    if (!fs.existsSync(path.dirname(ARCHIVE_FILE))) fs.mkdirSync(path.dirname(ARCHIVE_FILE), { recursive: true });
    fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(items, null, 2));
  } catch (_) {}
}

function makeId(date) {
  const d = date.toISOString().slice(0, 10);
  const items = load();
  const sameDay = items.filter(it => it.id?.includes(d)).length;
  return `Q-${d}-${String(sameDay + 1).padStart(3, '0')}`;
}

// Hebrew-aware normalization (same approach as findChatByName)
function normalizeHe(s) {
  return (s || '')
    .normalize('NFC')
    .replace(/[֑-ׇ]/g, '')
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/["״]/g, '')
    .replace(/['׳]/g, '')
    .toLowerCase();
}

/**
 * Add a quote to the archive.
 * @param {object} entry - { topic, type, channel?, text, tags?, result? }
 * @returns {object} the saved entry with generated id+date
 */
function addQuote(entry) {
  if (!entry?.text || !entry?.topic) {
    throw new Error('addQuote requires {text, topic}');
  }
  const date = new Date();
  const saved = {
    id: makeId(date),
    date: date.toISOString(),
    topic: entry.topic,
    type: entry.type || 'טיוטה',
    channel: entry.channel || null,
    text: entry.text,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    result: entry.result || null,
  };
  const items = load();
  items.unshift(saved);  // newest first for natural ordering
  save(items);
  return saved;
}

/**
 * Update an existing quote's `result` field (e.g. when we learn it was
 * published or got a response).
 */
function updateQuoteResult(id, result) {
  const items = load();
  const idx = items.findIndex(it => it.id === id);
  if (idx === -1) return null;
  items[idx].result = result;
  save(items);
  return items[idx];
}

/**
 * Search the archive.
 * @param {object} filters - { channel?, topic?, sinceDays?, type?, tag?, query? }
 * @returns {Array} matching entries (newest first)
 */
function searchQuotes(filters = {}) {
  const items = load();
  const sinceTs = filters.sinceDays ? Date.now() - filters.sinceDays * 86400000 : 0;
  const ch = normalizeHe(filters.channel || '');
  const tp = normalizeHe(filters.type || '');
  const tg = normalizeHe(filters.tag || '');
  const tpc = normalizeHe(filters.topic || '');
  const q = normalizeHe(filters.query || '');

  return items.filter(it => {
    if (sinceTs && new Date(it.date).getTime() < sinceTs) return false;
    if (ch && !normalizeHe(it.channel || '').includes(ch)) return false;
    if (tp && !normalizeHe(it.type || '').includes(tp)) return false;
    if (tg && !(it.tags || []).some(t => normalizeHe(t).includes(tg))) return false;
    if (tpc && !normalizeHe(it.topic).includes(tpc)) return false;
    if (q) {
      const haystack = normalizeHe([it.topic, it.text, it.channel || '', (it.tags || []).join(' ')].join(' '));
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Find quotes similar to a given topic in the recent past.
 * Used to warn before drafting a duplicate response.
 */
function findSimilar(topic, recentDays = 90) {
  if (!topic) return [];
  const sinceTs = Date.now() - recentDays * 86400000;
  const tn = normalizeHe(topic);
  const items = load();
  return items.filter(it => {
    if (new Date(it.date).getTime() < sinceTs) return false;
    const tn2 = normalizeHe(it.topic);
    // Loose token overlap — at least 1 token of 3+ chars in common
    const tokens1 = new Set(tn.split(/\s+/).filter(t => t.length >= 3));
    const tokens2 = tn2.split(/\s+/).filter(t => t.length >= 3);
    return tokens2.some(t => tokens1.has(t));
  });
}

/** Format an array of quotes as a compact human-readable list */
function formatQuotesList(items, opts = {}) {
  if (!items.length) return '🗄️ לא נמצאו ציטוטים בארכיון.';
  const limit = opts.limit || 10;
  const slice = items.slice(0, limit);
  const lines = [`🗄️ *${items.length} ציטוטים בארכיון${items.length > limit ? ` (מציג ${limit})` : ''}:*`, ''];
  for (const it of slice) {
    const dateShort = new Date(it.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
    const channel = it.channel ? ` · ${it.channel}` : '';
    const result = it.result ? ` · ✅ ${it.result.substring(0, 30)}` : '';
    const preview = it.text.length > 80 ? it.text.substring(0, 80) + '...' : it.text;
    lines.push(`*${it.id}* · ${dateShort}${channel}${result}`);
    lines.push(`📂 ${it.topic}`);
    lines.push(`💬 ${preview}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function getStats() {
  const items = load();
  if (!items.length) return { total: 0 };
  const byType = {};
  const byChannel = {};
  for (const it of items) {
    byType[it.type] = (byType[it.type] || 0) + 1;
    if (it.channel) byChannel[it.channel] = (byChannel[it.channel] || 0) + 1;
  }
  return {
    total: items.length,
    byType,
    byChannel,
    oldest: items[items.length - 1]?.date,
    newest: items[0]?.date,
  };
}

module.exports = {
  addQuote,
  updateQuoteResult,
  searchQuotes,
  findSimilar,
  formatQuotesList,
  getStats,
};
