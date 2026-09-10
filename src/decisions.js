'use strict';
/**
 * תור הספקות — מה שהבוט לא ידע להכריע.
 *
 * עד עכשיו לבוט היו שתי אפשרויות כשלא היה בטוח: לנחש, או לשתוק. שתיהן
 * בלתי נראות. ב-8.9 מיה עמדה בתמונה, הבוט חישב 0.349 מולה ו-0.359 מול שי,
 * לא ידע להכריע — ומחק אותה. איש לא ידע שזה קרה.
 *
 * כאן הספק נשמר במקום להיזרק, נשלח לטלפון כשאלה עם כפתורים, והתשובה חוזרת
 * ומשנה את הבוט לצמיתות. אי־הוודאות הופכת ממצב כישלון שקט לפריט עבודה.
 *
 * מודול נפרד מ-jarvis-api בכוונה: מסלול ההתראות עובד היום, ואין סיבה
 * שתור חדש יוכל לשבור אותו.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA, 'jarvis-decisions.json');
// Images live beside the record rather than inside it: a queue file that
// carries base64 photos becomes megabytes and is rewritten on every answer.
const IMG_DIR = path.join(DATA, 'decision-images');

const MAX_OPEN = 60;
const TTL_MS = 14 * 24 * 60 * 60 * 1000;   // a question nobody answered in two weeks is stale

let _q = null;

function _load() {
  if (_q) return _q;
  try { _q = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { _q = []; }
  return _q;
}
function _save() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(_q, null, 2));
  } catch (e) {
    logger.warn('decisions save: ' + (e.message || '').substring(0, 60));
  }
}

/**
 * מוסיף ספק לתור.
 *
 * dedupeKey מונע את מצב הכפילות שכבר קרה עם ההתראות: הגן שולח שלושים
 * תמונות של אותו אירוע, ובלעדיו היו נערמות שלושים שאלות זהות.
 */
function ask({ kind, question, hint = '', options, context = {}, image = null, dedupeKey = null }) {
  if (!kind || !question || !Array.isArray(options) || !options.length) return null;
  const q = _load();

  if (dedupeKey) {
    const open = q.find(d => d.dedupeKey === dedupeKey && !d.answered);
    if (open) {
      // Seen again — worth knowing how often, but not worth asking twice.
      open.seen = (open.seen || 1) + 1;
      open.lastSeen = Date.now();
      _save();
      return open;
    }
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let imageFile = null;
  if (image && image.length) {
    try {
      fs.mkdirSync(IMG_DIR, { recursive: true });
      imageFile = `${id}.jpg`;
      fs.writeFileSync(path.join(IMG_DIR, imageFile), image);
    } catch (e) {
      logger.warn('decisions image: ' + (e.message || '').substring(0, 50));
      imageFile = null;
    }
  }

  const item = {
    id, kind, question,
    hint: String(hint || '').substring(0, 300),
    // [{ label, value }] — label is what the button says, value is what the
    // handler receives. Kept apart so wording can change without breaking
    // an answer already queued on a phone.
    options: options.slice(0, 5),
    context, imageFile, dedupeKey,
    ts: Date.now(), seen: 1, lastSeen: Date.now(),
    answered: false, answer: null, answeredAt: null, outcome: null,
  };
  q.push(item);

  const cutoff = Date.now() - TTL_MS;
  _q = q.filter(d => d.ts >= cutoff || d.answered).slice(-MAX_OPEN * 3);
  _save();
  logger.info(`❓ Decision queued [${kind}]: ${question.substring(0, 60)}`);
  return item;
}

/** השאלות הפתוחות, החדשות קודם. */
function open(limit = MAX_OPEN, withImages = true) {
  return _load()
    .filter(d => !d.answered)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map(d => {
      const out = { ...d };
      delete out.imageFile;
      if (withImages && d.imageFile) {
        try { out.image = fs.readFileSync(path.join(IMG_DIR, d.imageFile)).toString('base64'); }
        catch { out.image = null; }
      }
      return out;
    });
}

function openCount() {
  return _load().filter(d => !d.answered).length;
}

/**
 * רושם תשובה. ה-handler הוא מי שבאמת משנה משהו — כאן רק נשמר מה נענה.
 * מוחזר outcome כדי שהאפליקציה תוכל להראות מה קרה בעקבות הלחיצה.
 */
function answer(id, value, outcome = null) {
  const q = _load();
  const item = q.find(d => d.id === id);
  if (!item) return null;
  if (item.answered) return item;        // idempotent: a double tap is harmless
  item.answered = true;
  item.answer = value;
  item.answeredAt = Date.now();
  item.outcome = outcome;
  // The image has done its job; keeping it would grow the disk for nothing.
  if (item.imageFile) {
    try { fs.unlinkSync(path.join(IMG_DIR, item.imageFile)); } catch {}
    item.imageFile = null;
  }
  _save();
  logger.info(`✅ Decision answered [${item.kind}]: ${value}`);
  return item;
}

/** כמה נענו ומתי — לחישוב "כמה השתפרת" באפליקציה. */
function stats() {
  const q = _load();
  const answered = q.filter(d => d.answered);
  return {
    open: q.filter(d => !d.answered).length,
    answered: answered.length,
    lastAnsweredAt: answered.length ? Math.max(...answered.map(d => d.answeredAt || 0)) : null,
  };
}

module.exports = { ask, open, openCount, answer, stats };
