'use strict';
/**
 * 🎞️ השבוע של מיה ושי — סרטון שבועי מהאלבום.
 *
 * עד 10 תמונות מ-7 הימים האחרונים, מפוזרות על פני השבוע: קודם מה שהוא
 * אישר בעצמו, אחר כך מה שזוהה בביטחון הכי גבוה. כל תמונה עם השם, היום
 * והשעה שבה נקלטה. עד 30 שניות (remotion/compositions/WeekOfGirls.jsx).
 *
 * אותה תמונה באלבום של שתיהן — פעם אחת, עם שני השמות.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const ALBUM = path.join(__dirname, '..', 'data', 'album');
const OUT = path.join(__dirname, '..', 'output', 'weekly');
const MAX_PHOTOS = 10;
const INDEX = path.join(OUT, 'index.json');
// Kevin MacLeod (incompetech.com), CC BY 4.0 — credited at the end of the film.
const TRACKS = {
  'carefree.mp3': 'Carefree',
  'life-of-riley.mp3': 'Life of Riley',
  'pleasant-porridge.mp3': 'Pleasant Porridge',
  'wholesome.mp3': 'Wholesome',
};
const DEFAULT_TRACK = 'carefree.mp3';

function _loadIndex() { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return []; } }
function _saveIndex(list) { try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(INDEX, JSON.stringify(list.slice(0, 30), null, 1)); } catch (_) {} }
/** הסרטונים שנבנו, מהחדש לישן — לאפליקציה. */
function list() { return _loadIndex().filter(v => fs.existsSync(path.join(OUT, v.file))); }
/** נשלח לוואטסאפ — מתי. */
function markSent(file) { const l = _loadIndex(); const v = l.find(x => x.file === path.basename(file)); if (v) { v.sentAt = Date.now(); _saveIndex(l); } }
function filePath(name) { const n = path.basename(String(name || '')); if (!/^week-[\w-]+\.(mp4|jpg)$/.test(n)) return null; const p = path.join(OUT, n); return fs.existsSync(p) ? p : null; }

const _diff = (x, y) => { let s = 0; for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]); return s / x.length; };
const _day = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

// A difference hash: which of two neighbouring pixels is brighter, 16x16 — the
// same photo at another size or compression gives nearly the same bits.
// 8x8: coarse on purpose — two shots a second apart of the same moment
// (a burst, sent twice) are one picture as far as the film is concerned.
async function _dhash(file) {
  const px = await require('sharp')(file).rotate().resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer();
  const bits = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(px[y * 9 + x] > px[y * 9 + x + 1] ? 1 : 0);
  return bits;
}
const _ham = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

/**
 * התמונה נשמרה עם מסגרת הזיהוי הירוקה (אישור מהאפליקציה על עותק מסומן).
 * נבדק לפי קווים ישרים של ירוק רווי — צבע שלא קיים כמעט בתמונה אמיתית.
 */
async function _isFramed(file) {
  try {
    const { data, info } = await require('sharp')(file).resize(360, 360, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    const green = (x, y) => { const i = (y * W + x) * 3; const r = data[i], g = data[i + 1], b = data[i + 2]; return g > 170 && r < 100 && b < 150 && g - r > 100; };
    // A frame is straight lines of that green, across and down — even a small
    // one around a face in a group photo (a ~20px box at this size).
    const run = (len, at) => { let best = 0, cur = 0; for (let k = 0; k < len; k++) { if (at(k)) { cur++; if (cur > best) best = cur; } else cur = 0; } return best; };
    let rows = 0, cols = 0;
    for (let y = 0; y < H; y++) if (run(W, x => green(x, y)) >= 14) rows++;
    for (let x = 0; x < W; x++) if (run(H, y => green(x, y)) >= 14) cols++;
    if (rows >= 1 && cols >= 1) return true;
  } catch (_) {}
  return false;
}

/** התמונות של השבוע, מוכנות לסרטון. */
async function pickPhotos(days = 7) {
  const idx = JSON.parse(fs.readFileSync(path.join(ALBUM, 'index.json'), 'utf8'));
  const since = Date.now() - days * 86400000;
  const all = [];
  for (const [key, v] of Object.entries(idx)) {
    for (const p of v.photos || []) {
      if (p.ts < since) continue;
      const file = path.join(ALBUM, key, p.month || '', p.file);
      if (!fs.existsSync(file)) continue;
      if (await _isFramed(file)) continue;
      // Measured here, not taken from the album: old entries have none, and
      // the same photo sent twice sat in the film twice (13.9).
      let sig = null;
      try { sig = await _dhash(file); } catch (_) {}
      all.push({ name: v.name || key, ts: p.ts, file, sig, score: (p.source === 'confirm' ? 200 : 0) + (p.confidence || 50) });
    }
  }
  // One photo, both girls: merged.
  const uniq = [];
  for (const p of all.sort((a, b) => b.score - a.score)) {
    // The same photo — or a shot a second apart from the same moment.
    const twin = uniq.find(u => (p.sig && u.sig && _ham(u.sig, p.sig) <= 16) || (Math.abs(u.ts - p.ts) < 1500 && (!u.sig || !p.sig)));
    if (twin) { if (!twin.names.includes(p.name)) twin.names.push(p.name); continue; }
    uniq.push({ ...p, names: [p.name] });
  }
  // Each girl's photos spread over the week (the best of each day first),
  // then the two taken in turns — nine of one and one of the other is not
  // "the week of both" (the first pick, 13.9).
  const spread = list => {
    const byDay = new Map();
    for (const p of list) { const d = _day(p.ts); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(p); }
    const out = [];
    for (let round = 0; round < 20; round++) {
      let any = false;
      for (const l of byDay.values()) if (l[round]) { out.push(l[round]); any = true; }
      if (!any) break;
    }
    return out;
  };
  const girls = {};
  for (const p of uniq) for (const n of p.names) (girls[n] = girls[n] || []).push(p);
  const lists = Object.values(girls).map(spread);
  const chosen = [];
  for (let i = 0; chosen.length < MAX_PHOTOS && lists.some(l => l.length > i); i++) {
    for (const l of lists) {
      const p = l[i];
      if (p && !chosen.includes(p) && chosen.length < MAX_PHOTOS) chosen.push(p);
    }
  }
  return chosen.sort((a, b) => a.ts - b.ts);
}

function _when(ts) {
  const d = new Date(ts);
  const day = d.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long' });
  const date = d.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long' });
  const time = d.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
  return `${day}, ${date} · ${time}`;
}

function _range(photos) {
  if (!photos.length) return '';
  const f = ts => new Date(ts).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long' });
  const a = f(photos[0].ts), b = f(photos[photos.length - 1].ts);
  return a === b ? a : `${a} – ${b}`;
}

let _bundle = null;
async function _getBundle() {
  if (_bundle) return _bundle;
  const { bundle } = require('@remotion/bundler');
  _bundle = await bundle({
    entryPoint: path.resolve(__dirname, '..', 'remotion', 'index.jsx'),
    publicDir: path.resolve(__dirname, '..', 'remotion', 'public'),
    webpackOverride: c => c,
  });
  return _bundle;
}

let _busy = false;
/**
 * בונה את הסרטון. מחזיר { video, still, photos } — נתיבים לקבצים.
 * onProgress(0..1) — לדיווח התקדמות.
 */
async function render({ days = 7, onProgress, music = DEFAULT_TRACK } = {}) {
  if (_busy) throw new Error('סרטון כבר בהכנה');
  _busy = true;
  try {
    const picked = await pickPhotos(days);
    if (picked.length < 3) throw new Error(`רק ${picked.length} תמונות השבוע — צריך לפחות 3`);
    const sharp = require('sharp');
    const photos = [];
    for (const p of picked) {
      const buf = await sharp(fs.readFileSync(p.file)).rotate().resize(1000, 1400, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      photos.push({ src: 'data:image/jpeg;base64,' + buf.toString('base64'), names: p.names, when: _when(p.ts) });
    }
    const counts = ['מיה', 'שי'].map(n => ({ name: n, n: picked.filter(p => p.names.includes(n)).length })).filter(c => c.n > 0);
    const isFriday = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' }) === 'Fri';
    const track = TRACKS[music] ? music : DEFAULT_TRACK;
    const props = {
      photos, range: _range(picked), names: counts.map(c => c.name), counts, sign: isFriday ? 'שבת שלום' : 'שבוע טוב',
      music: track, credit: `Music: "${TRACKS[track]}" Kevin MacLeod (incompetech.com) · CC BY 4.0`,
    };

    const { selectComposition, renderMedia, renderStill } = require('@remotion/renderer');
    const serveUrl = await _getBundle();
    const composition = await selectComposition({ serveUrl, id: 'WeekOfGirls', inputProps: props });
    fs.mkdirSync(OUT, { recursive: true });
    // One file per film (a second one the same day does not overwrite the first).
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const video = path.join(OUT, `week-${stamp}.mp4`);
    const still = path.join(OUT, `week-${stamp}.jpg`);
    // One at a time: the server is small and the bot must keep answering.
    await renderMedia({
      composition, serveUrl, codec: 'h264', outputLocation: video, inputProps: props,
      concurrency: 1, crf: 22, jpegQuality: 88,
      onProgress: ({ progress }) => { try { onProgress && onProgress(progress); } catch (_) {} },
    });
    // The preview: the first photo, mid-way — card, name and date in view.
    await renderStill({ composition, serveUrl, output: still, inputProps: props, frame: 75 + 30, imageFormat: 'jpeg', jpegQuality: 90 });
    logger.info(`🎞️ weekly video: ${picked.length} photos, ${(composition.durationInFrames / 30).toFixed(1)}s → ${video}`);
    const idx = _loadIndex();
    idx.unshift({ file: path.basename(video), still: path.basename(still), ts: Date.now(), photos: picked.length, seconds: composition.durationInFrames / 30, range: props.range, music: TRACKS[track], sentAt: null });
    _saveIndex(idx);
    return { video, still, photos: picked.length, seconds: composition.durationInFrames / 30 };
  } finally { _busy = false; }
}

/** 🗑️ מוחק סרטון (והתמונה שלו) — הוא ביקש. */
function remove(name) {
  const n = path.basename(String(name || ''));
  const l = _loadIndex(); const v = l.find(x => x.file === n);
  if (!v) return false;
  for (const f of [v.file, v.still]) { try { fs.unlinkSync(path.join(OUT, f)); } catch (_) {} }
  _saveIndex(l.filter(x => x !== v));
  logger.info('🎞️ weekly video removed: ' + n);
  return true;
}

module.exports = { render, pickPhotos, list, markSent, filePath, remove, TRACKS };
