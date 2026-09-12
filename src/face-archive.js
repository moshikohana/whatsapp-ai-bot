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
// Reference faces live apart from detections: they are what the recogniser is
// built on, not something it produced, and they must not be trimmed by the
// per-person cap that keeps the detection archive small.
const REF_ROOT = path.join(__dirname, '..', 'data', 'face-refs');
const REF_INDEX = path.join(REF_ROOT, 'index.json');
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
// Read fresh each time rather than cached: references change rarely, and a
// stale cache here would show the wrong count right after adding one.
function _loadRef() {
  try { return JSON.parse(fs.readFileSync(REF_INDEX, 'utf8')); } catch { return {}; }
}
function _saveRef(idx) {
  try {
    fs.mkdirSync(REF_ROOT, { recursive: true });
    fs.writeFileSync(REF_INDEX, JSON.stringify(idx, null, 2));
  } catch (e) { logger.warn('face-refs save: ' + (e.message || '').substring(0, 60)); }
}
const _safe = s => String(s || 'unknown').replace(/[^\p{L}\p{N}_-]/gu, '_').substring(0, 40);

/**
 * שומר תמונה שבה זוהה אדם.
 * buffer — עדיף המסומנת (עם המסגרות), כי זה מה שמעניין להסתכל עליו אחר כך.
 */
function record({ name, buffer, group, confidence, candidate = false, ts = Date.now() }) {
  if (!name || !buffer || !buffer.length) return null;
  // Not in a group this person cannot be in (see face-recognition.allowedNames).
  try { if (group && !require('./face-recognition').isAllowed(name, group)) return null; } catch (_) {}
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
      // A candidate scored below the group floor — shown separately so a
      // rejected guess can be confirmed instead of silently discarded.
      candidate: !!candidate,
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
    count: (v.photos || []).filter(p => !p.candidate).length,
    candidates: (v.photos || []).filter(p => p.candidate).length,
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
  let _fr = null; try { _fr = require('./face-recognition'); } catch (_) {}
  return (entry.photos || []).filter(p => !_fr || !p.group || _fr.isAllowed(entry.name || name, p.group)).slice(0, limit).map(p => {
    const out = { ts: p.ts, group: p.group, confidence: p.confidence, kb: p.kb, candidate: !!p.candidate };
    if (withData) {
      try { out.image = fs.readFileSync(path.join(ROOT, key, p.file)).toString('base64'); }
      catch { out.image = null; }
    }
    return out;
  });
}

/**
 * מוחק תמונת זיהוי בודדת מהארכיון.
 *
 * זיהוי הוא רשומה של מה שקרה, לא חלק ממה שהמזהה בנוי עליו — ולכן מחיקה כאן
 * לא נוגעת בווקטורים ולא משנה את איכות הזיהוי. היא רק מנקה את הגלריה.
 */
function removePhoto(name, ts) {
  try {
    const idx = _load();
    const key = _safe(name);
    const entry = idx[key];
    if (!entry || !entry.photos) return { success: false, error: 'לא נמצא' };
    const target = entry.photos.find(p => String(p.ts) === String(ts));
    if (!target) return { success: false, error: 'התמונה כבר לא קיימת' };
    try { fs.unlinkSync(path.join(ROOT, key, target.file)); } catch {}
    entry.photos = entry.photos.filter(p => p !== target);
    _save();
    return { success: true, remaining: entry.photos.length };
  } catch (e) {
    logger.warn('face-archive removePhoto: ' + (e.message || '').substring(0, 60));
    return { success: false, error: (e.message || '').substring(0, 60) };
  }
}

/** מוחק אדם מהארכיון — התמונות בלבד. הווקטורים נמחקים בנפרד. */
function removePerson(name) {
  try {
    const idx = _load();
    const key = _safe(name);
    let removed = 0;
    if (idx[key]) {
      removed = (idx[key].photos || []).length;
      for (const p of idx[key].photos || []) {
        try { fs.unlinkSync(path.join(ROOT, key, p.file)); } catch {}
      }
      delete idx[key];
      _save();
    }
    // References live in their own tree and index.
    const ridx = _loadRef();
    if (ridx[key]) {
      for (const p of ridx[key].photos || []) {
        try { fs.unlinkSync(path.join(REF_ROOT, key, p.file)); } catch {}
      }
      delete ridx[key];
      _saveRef(ridx);
    }
    try { fs.rmdirSync(path.join(ROOT, key)); } catch {}
    try { fs.rmdirSync(path.join(REF_ROOT, key)); } catch {}
    return { success: true, removed };
  } catch (e) {
    logger.warn('face-archive removePerson: ' + (e.message || '').substring(0, 60));
    return { success: false, error: (e.message || '').substring(0, 60) };
  }
}

// ── יומן בדיקות ─────────────────────────────────────────────────
/**
 * כל תמונה שהבוט בדק — גם כשלא זוהה אף אחד.
 *
 * עד עכשיו נשמרו רק תמונות שבהן היה זיהוי. תמונה שנבדקה ולא נמצא בה אף אחד
 * פשוט נעלמה, ולכן על השאלה "שלחו 40 תמונות בגן, הבוט בכלל הסתכל?" לא הייתה
 * שום דרך לענות — לא היה הבדל נראה לעין בין "בדק ולא מצא" לבין "לא בדק".
 *
 * נשמרות שתי גרסאות: ממוזערת (400px) לרצועה, ומלאה (עד 1600px) לצופה.
 * הממוזערת לבדה הספיקה כדי לדעת איזו תמונה זו, אבל לא כדי למספר 13 פרצופים
 * בתמונת גן ולהחליט אם אחד מהם הוא שי — ובשביל זה בדיוק פותחים אותה.
 */
const CHECK_ROOT = path.join(__dirname, '..', 'data', 'face-checks');
const CHECK_INDEX = path.join(CHECK_ROOT, 'index.json');
const MAX_CHECKS = 80;
const CHECK_TTL_MS = 48 * 60 * 60 * 1000;

function _loadChecks() {
  try { return JSON.parse(fs.readFileSync(CHECK_INDEX, 'utf8')); } catch { return []; }
}
function _saveChecks(list) {
  try {
    fs.mkdirSync(CHECK_ROOT, { recursive: true });
    fs.writeFileSync(CHECK_INDEX, JSON.stringify(list, null, 2));
  } catch (e) { logger.warn('face-checks save: ' + (e.message || '').substring(0, 60)); }
}

/**
 * @param outcome match | candidate | ambiguous | nomatch | nofaces
 */
function _thumbOf(buffer) {
  return require('sharp')(buffer).rotate()
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70 }).toBuffer();
}
function _fullOf(buffer) {
  return require('sharp')(buffer).rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
}

// Signatures of the photos he confirmed (album, source 'confirm'), cached by file.
const _confSig = new Map();
async function _confirmedAlready(buffer) {
  try {
    const sharp = require('sharp');
    const sig = b => sharp(b).rotate().resize(16, 16, { fit: 'fill' }).greyscale().raw().toBuffer();
    const diff = (x, y) => { let s = 0; for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]); return s / x.length; };
    const ALB = path.join(__dirname, '..', 'data', 'album');
    const idx = JSON.parse(fs.readFileSync(path.join(ALB, 'index.json'), 'utf8'));
    const since = Date.now() - 30 * 24 * 3600000;
    const s0 = await sig(buffer);
    for (const [name, v] of Object.entries(idx)) for (const p of v.photos || []) {
      if (p.source !== 'confirm' || p.ts < since) continue;
      const f = path.join(ALB, name, p.month || '', p.file);
      let s = _confSig.get(f);
      if (!s) { try { s = await sig(fs.readFileSync(f)); _confSig.set(f, s); } catch { continue; } }
      if (diff(s0, s) < 8) return name;
    }
  } catch {}
  return null;
}

async function recordCheck({ buffer, group, outcome, detail = '', faces = 0, ts = Date.now() }) {
  if (!buffer || !buffer.length) return null;
  // Sent again after he already said who is in it: nothing to check.
  const known = await _confirmedAlready(buffer);
  if (known) { logger.info(`🧹 face-checks: a photo already confirmed as ${known} — not listed again`); return null; }
  try {
    fs.mkdirSync(CHECK_ROOT, { recursive: true });
    const thumb = await _thumbOf(buffer);

    const file = `${ts}-${Math.random().toString(36).slice(2, 6)}.jpg`;
    fs.writeFileSync(path.join(CHECK_ROOT, file), thumb);
    let full = null;
    try {
      full = file.replace(/\.jpg$/, '-full.jpg');
      fs.writeFileSync(path.join(CHECK_ROOT, full), await _fullOf(buffer));
    } catch { full = null; }

    let list = _loadChecks();
    list.unshift({
      ts, file, full,
      group: String(group || '').substring(0, 80),
      outcome, detail: String(detail || '').substring(0, 120),
      faces,
    });

    // Trimmed by both age and count, and the files go with the entries — a
    // log that only grows is the disk problem this bot has had before.
    const cutoff = Date.now() - CHECK_TTL_MS;
    const keep = [], drop = [];
    for (const c of list) ((c.ts >= cutoff && keep.length < MAX_CHECKS) ? keep : drop).push(c);
    for (const d of drop) {
      try { fs.unlinkSync(path.join(CHECK_ROOT, d.file)); } catch {}
      if (d.full) { try { fs.unlinkSync(path.join(CHECK_ROOT, d.full)); } catch {} }
    }
    _saveChecks(keep);
    return { file };
  } catch (e) {
    logger.warn('face-archive recordCheck: ' + (e.message || '').substring(0, 60));
    return null;
  }
}

function checks(limit = 30, withData = true) {
  return _loadChecks().slice(0, limit).map(c => {
    const out = { ts: c.ts, group: c.group, outcome: c.outcome, detail: c.detail, faces: c.faces, hasFull: !!c.full };
    if (withData) {
      try { out.image = fs.readFileSync(path.join(CHECK_ROOT, c.file)).toString('base64'); }
      catch { out.image = null; }
    }
    return out;
  });
}

/**
 * מחיקה מ"נבדקו לאחרונה" — תמונה אחת (ts), או כל מה שיצא בתוצאה מסוימת
 * ("אין פנים", "לא זוהה"). הקבצים הולכים עם הרשומה: זה כל הטעם — מקום.
 * @returns { removed, freedMB }
 */
function removeChecks({ ts = null, outcomes = null } = {}) {
  const list = _loadChecks();
  const keep = [], drop = [];
  for (const c of list) {
    const hit = (ts != null && c.ts === ts) || (Array.isArray(outcomes) && outcomes.includes(c.outcome));
    (hit ? drop : keep).push(c);
  }
  let bytes = 0;
  for (const d of drop) {
    for (const f of [d.file, d.full]) {
      if (!f) continue;
      const p = path.join(CHECK_ROOT, f);
      try { bytes += fs.statSync(p).size; fs.unlinkSync(p); } catch {}
    }
  }
  if (drop.length) _saveChecks(keep);
  return { removed: drop.length, freedMB: Math.round(bytes / 1024 / 1024 * 10) / 10 };
}

/**
 * התמונה בגודל מלא, לצופה. לבדיקות מלפני שהגרסה המלאה נשמרה — הממוזערת,
 * עם סימון, כדי שהאפליקציה תגיד את זה במקום להציג תמונה קטנה כאילו היא המקור.
 */
function checkFull(ts) {
  const c = _loadChecks().find(x => x.ts === ts);
  if (!c) return null;
  if (c.full) {
    try { return { image: fs.readFileSync(path.join(CHECK_ROOT, c.full)).toString('base64'), full: true }; } catch {}
  }
  // Checks from before full copies were kept: a filtered-out candidate was
  // also filed, full size and with its face marked, under the person it was
  // suspected to be — within moments of the check. Those are exactly the
  // photos worth a second look.
  // Both are written in the same synchronous step, so they sit milliseconds
  // apart; photos arrive about one a second, so a looser window would hand
  // back the neighbouring photo (a 5s window returned one photo for twelve).
  if (c.outcome === 'candidate') {
    let best = null;
    for (const [key, v] of Object.entries(_load())) {
      for (const x of v.photos || []) {
        if (!x.candidate || (c.group && x.group !== c.group)) continue;
        const d = Math.abs(x.ts - c.ts);
        if (d < 1000 && (!best || d < best.d)) best = { d, key, file: x.file };
      }
    }
    if (best) {
      try { return { image: fs.readFileSync(path.join(ROOT, best.key, best.file)).toString('base64'), full: true }; } catch {}
    }
  }
  try { return { image: fs.readFileSync(path.join(CHECK_ROOT, c.file)).toString('base64'), full: false }; } catch {}
  return null;
}

/** כמה נבדקו ומה יצא — לשורת סיכום. */
function checkStats() {
  const l = _loadChecks();
  const day = Date.now() - 24 * 3600 * 1000;
  const today = l.filter(c => c.ts >= day);
  const by = {};
  for (const c of today) by[c.outcome] = (by[c.outcome] || 0) + 1;
  return { total: l.length, last24h: today.length, byOutcome: by };
}

// ── תמונות ייחוס ────────────────────────────────────────────────
/**
 * שומר את פרצוף הייחוס עצמו.
 *
 * עד עכשיו נשמר רק הווקטור בן 128 המספרים, והתמונה נזרקה — ולכן על 22
 * הייחוסים הקיימים אי אפשר היה להסתכל, רק לסמוך עליהם. חיתוך הפרצוף ולא
 * התמונה המלאה: זה מה שהמזהה באמת משתמש בו, וזה מה שמראה אם נשמר הילד הנכון.
 */
async function recordReference({ name, buffer, box, ts = Date.now() }) {
  if (!name || !buffer || !buffer.length) return null;
  try {
    const sharp = require('sharp');
    const key = _safe(name);
    const dir = path.join(REF_ROOT, key);
    fs.mkdirSync(dir, { recursive: true });

    // Materialised before measuring: metadata() on a rotate() pipeline still
    // reports the pre-rotation dimensions, so an EXIF-rotated phone photo
    // would be measured with width and height the wrong way round.
    const rotated = await sharp(buffer).rotate().toBuffer();
    let img = sharp(rotated);

    if (box && box.width > 0 && box.height > 0) {
      const meta = await sharp(rotated).metadata();
      // Detection runs on an image capped at 1280px on the long edge, so the
      // box is in THAT coordinate space, not the original's. Cropping the
      // full-size original at those raw numbers put the crop up and to the
      // left of the face — a 2040px photo was off by a factor of 1.6.
      const DETECT_MAX_DIM = 1280;
      const ratio = Math.min(
        DETECT_MAX_DIM / (meta.width || DETECT_MAX_DIM),
        DETECT_MAX_DIM / (meta.height || DETECT_MAX_DIM),
        1
      );
      const scale = 1 / ratio;
      const bx = box.x * scale, by = box.y * scale;
      const bw = box.width * scale, bh = box.height * scale;

      // 40% padding — a box cropped tight to the detection loses the hairline
      // and chin, which is exactly what makes a face recognisable to a person.
      const pad = 0.4;
      const left = Math.max(0, Math.round(bx - bw * pad));
      const top = Math.max(0, Math.round(by - bh * pad));
      const width = Math.min((meta.width || 0) - left, Math.round(bw * (1 + pad * 2)));
      const height = Math.min((meta.height || 0) - top, Math.round(bh * (1 + pad * 2)));
      if (width > 20 && height > 20) img = img.extract({ left, top, width, height });
    }
    const out = await img.resize(280, 280, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();

    const file = `${ts}.jpg`;
    fs.writeFileSync(path.join(dir, file), out);

    const idx = _loadRef();
    if (!idx[key]) idx[key] = { name, photos: [] };
    idx[key].name = name;
    idx[key].photos.push({ file, ts, kb: Math.round(out.length / 1024) });
    idx[key].photos.sort((a, b) => b.ts - a.ts);
    _saveRef(idx);
    return { key, file };
  } catch (e) {
    // Never block adding a reference because its picture could not be saved —
    // the descriptor is the part that matters for recognition.
    logger.warn('face-archive recordReference: ' + (e.message || '').substring(0, 70));
    return null;
  }
}

/** תמונות הייחוס השמורות של אדם. */
function references(name, withData = true) {
  const idx = _loadRef();
  const key = _safe(name);
  const entry = idx[key];
  if (!entry) return [];
  return (entry.photos || []).map(p => {
    const out = { ts: p.ts, kb: p.kb };
    if (withData) {
      try { out.image = fs.readFileSync(path.join(REF_ROOT, key, p.file)).toString('base64'); }
      catch { out.image = null; }
    }
    return out;
  });
}

/**
 * מוחק תמונת ייחוס לפי סדר ההוספה.
 *
 * הווקטורים נשמרים בסדר שבו נוספו, ולכן האינדקס כאן חייב להימדד באותו סדר —
 * הרשימה מוצגת מהחדש לישן, ומחיקה לפי סדר התצוגה הייתה מוחקת את התמונה
 * ההפוכה בדיוק.
 */
function removeReferenceAt(name, index) {
  try {
    const idx = _loadRef();
    const key = _safe(name);
    const entry = idx[key];
    if (!entry || !entry.photos || !entry.photos.length) return false;
    const byAge = [...entry.photos].sort((a, b) => a.ts - b.ts);
    const target = byAge[index];
    if (!target) return false;
    try { fs.unlinkSync(path.join(REF_ROOT, key, target.file)); } catch {}
    entry.photos = entry.photos.filter(p => p.file !== target.file);
    _saveRef(idx);
    return true;
  } catch (e) {
    logger.warn('face-refs remove: ' + (e.message || '').substring(0, 60));
    return false;
  }
}

/** כמה תמונות ייחוס שמורות לכל אדם. */
function referenceCount(name) {
  const idx = _loadRef();
  const entry = idx[_safe(name)];
  return entry ? (entry.photos || []).length : 0;
}

function totalCount() {
  const idx = _load();
  return Object.values(idx).reduce((s, v) => s + (v.photos || []).length, 0);
}

/**
 * אותה תמונה שנשלחה כמה פעמים — כל שליחה היא בדיקה נפרדת. כשאחת הוכרעה,
 * גם העותקים האחרים יוצאים (12.9: אישר את מיה על הספה, והעותק מ-19:00
 * נשאר "לא זוהה" — נראה כאילו האפליקציה לא התעדכנה).
 */
async function settleSame(buffer, { since = Date.now() - 72 * 3600000 } = {}) {
  const sharp = require('sharp');
  const sig = b => sharp(b).rotate().resize(16, 16, { fit: 'fill' }).greyscale().raw().toBuffer();
  const diff = (x, y) => { let s = 0; for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]); return s / x.length; };
  let s0;
  try { s0 = await sig(buffer); } catch { return 0; }
  // All outcomes: a copy the bot called "זוהה" stayed in the list after he
  // had confirmed the same photo (12.9, ten of 22 were copies).
  const same = [];
  for (const c of _loadChecks()) {
    if (c.ts < since) continue;
    try {
      const s = await sig(fs.readFileSync(path.join(CHECK_ROOT, c.full || c.file)));
      if (diff(s0, s) < 8) same.push(c.ts);
    } catch {}
  }
  for (const ts of same) removeChecks({ ts });
  if (same.length) logger.info(`🧹 face-checks: ${same.length} more cop${same.length === 1 ? 'y' : 'ies'} of the same photo settled`);
  return same.length;
}

/** התמונה של בדיקה (המלאה אם יש) — לפני שמוחקים אותה. */
function checkBuffer(ts) {
  const c = _loadChecks().find(x => x.ts === ts);
  if (!c) return null;
  try { return fs.readFileSync(path.join(CHECK_ROOT, c.full || c.file)); } catch { return null; }
}

module.exports = {
  settleSame, checkBuffer,
  record, people, photos, totalCount,
  recordReference, references, referenceCount, removeReferenceAt,
  removePhoto, removePerson,
  recordCheck, checks, checkStats, checkFull, removeChecks,
};
