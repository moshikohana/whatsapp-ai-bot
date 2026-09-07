'use strict';
/**
 * ארכיון תמונות לפי אדם.
 *
 * הבוט זיהה פרצופים בקבוצות מזמן, אבל שמר רק מונים — כמה פעמים מישהו זוהה
 * היום. את התמונה עצמה אף אחד לא שמר, ולכן "תראה לי את התמונות האחרונות של
 * מיה" לא היה שאלה שאפשר לענות עליה. זה מה שחסר.
 *
 * נשמר על הדיסק ולא בזיכרון: זה בדיוק המידע שצריך לשרוד הפעלה מחדש, והבוט
 * הזה מופעל מחדש הרבה.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const ROOT = path.join(__dirname, '..', 'data', 'face-photos');
const INDEX = path.join(ROOT, 'index.json');
const MAX_PER_PERSON = 40;          // enough to scroll, small enough to stay cheap
const MAX_BYTES = 900 * 1024;       // skip anything unreasonably large

let _index = null;

function _load() {
  if (_index) return _index;
  try { _index = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { _index = {}; }
  return _index;
}
function _save() {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(INDEX, JSON.stringify(_index, null, 2));
  } catch (e) { logger.warn('face-archive save: ' + (e.message || '').substring(0, 60)); }
}
const _safe = s => String(s || 'unknown').replace(/[^\p{L}\p{N}_-]/gu, '_').substring(0, 40);

/**
 * שומר תמונה שבה זוהה אדם.
 * buffer — עדיף המסומנת (עם המסגרות), כי זה מה שמעניין להסתכל עליו אחר כך.
 */
function record({ name, buffer, group, confidence, ts = Date.now() }) {
  if (!name || !buffer || !buffer.length) return null;
  if (buffer.length > MAX_BYTES) return null;
  try {
    const idx = _load();
    const key = _safe(name);
    const dir = path.join(ROOT, key);
    fs.mkdirSync(dir, { recursive: true });

    const file = `${ts}.jpg`;
    fs.writeFileSync(path.join(dir, file), buffer);

    if (!idx[key]) idx[key] = { name, photos: [] };
    idx[key].name = name;                       // keep the display form
    idx[key].photos.push({
      file, ts,
      group: String(group || '').substring(0, 80),
      confidence: confidence != null ? Math.round(confidence) : null,
      kb: Math.round(buffer.length / 1024),
    });

    // Trim oldest beyond the cap, and delete their files — an archive that
    // only grows becomes the disk problem that took this bot down before.
    if (idx[key].photos.length > MAX_PER_PERSON) {
      const drop = idx[key].photos
        .sort((a, b) => a.ts - b.ts)
        .slice(0, idx[key].photos.length - MAX_PER_PERSON);
      for (const d of drop) {
        try { fs.unlinkSync(path.join(dir, d.file)); } catch {}
      }
      idx[key].photos = idx[key].photos.filter(p => !drop.includes(p));
    }
    idx[key].photos.sort((a, b) => b.ts - a.ts);
    _save();
    return { key, file };
  } catch (e) {
    logger.warn('face-archive record: ' + (e.message || '').substring(0, 70));
    return null;
  }
}

/** מי במעקב, כמה תמונות יש לכל אחד, ומתי נראה לאחרונה. */
function people() {
  const idx = _load();
  return Object.entries(idx).map(([key, v]) => ({
    key,
    name: v.name || key,
    count: (v.photos || []).length,
    lastSeen: (v.photos || []).length ? Math.max(...v.photos.map(p => p.ts)) : null,
    lastGroup: (v.photos && v.photos[0]) ? v.photos[0].group : null,
  })).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

/** התמונות האחרונות של אדם, עם התוכן עצמו כ-base64 להצגה באפליקציה. */
function photos(name, limit = 20, withData = true) {
  const idx = _load();
  const key = _safe(name);
  const entry = idx[key];
  if (!entry) return [];
  return (entry.photos || []).slice(0, limit).map(p => {
    const out = { ts: p.ts, group: p.group, confidence: p.confidence, kb: p.kb };
    if (withData) {
      try { out.image = fs.readFileSync(path.join(ROOT, key, p.file)).toString('base64'); }
      catch { out.image = null; }
    }
    return out;
  });
}

function totalCount() {
  const idx = _load();
  return Object.values(idx).reduce((s, v) => s + (v.photos || []).length, 0);
}

module.exports = { record, people, photos, totalCount };
