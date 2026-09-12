'use strict';
/**
 * 🎬 סרטונים — מה עושים עם סרטון ששלח לבוט.
 *
 * עד עכשיו סרטון בשיחה עם הבוט פשוט נבלע: אין לו טקסט, אז אף מסלול לא טיפל
 * בו. עכשיו הבוט שואל: לשמור לצפייה מאוחרת (תיקיית הסרטונים באפליקציה),
 * להפוך ל-MP3 ולשלוח בחזרה, או גם לתמלל.
 *
 * הסרטון יורד מיד כשהוא מגיע — הורדה של הודעה ישנה שבורה בגרסה הזאת של
 * וואטסאפ, אז אחרי שהוא ענה כבר אין ממה להוריד. עד שהוא עונה הקובץ מחכה
 * בתיקייה זמנית, ונמחק אחרי כמה שעות אם לא נבחר כלום.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('./logger');

const DIR = path.join(__dirname, '..', 'data', 'videos');
const TMP = path.join(DIR, 'tmp');
const INDEX = path.join(DIR, 'index.json');
const PENDING_MS = 6 * 3600000;
// The server disk is shared with everything else the bot keeps.
const QUOTA_BYTES = 6 * 1024 ** 3;
const MAX_VIDEO_BYTES = 300 * 1024 ** 2;

fs.mkdirSync(TMP, { recursive: true });

function _load() { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return []; } }
function _save(l) { fs.writeFileSync(INDEX, JSON.stringify(l, null, 1)); }

function _run(cmd, args, timeout = 15 * 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').toString().split('\n').filter(Boolean).slice(-1)[0] || 'ffmpeg failed'));
      resolve(stdout.toString());
    });
  });
}

async function _probe(file) {
  try {
    const out = JSON.parse(await _run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60000));
    const v = (out.streams || []).find(s => s.codec_type === 'video') || {};
    const a = (out.streams || []).find(s => s.codec_type === 'audio');
    return {
      duration: Math.round(parseFloat(out.format?.duration || v.duration || 0)),
      width: v.width || null, height: v.height || null, hasAudio: !!a,
    };
  } catch { return { duration: 0, width: null, height: null, hasAudio: true }; }
}

// ── Pending: downloaded, waiting for his answer ────────────────────
const _pending = new Map();   // id → { id, file, caption, at, info, size, name }

function _sweep() {
  for (const [id, p] of _pending) {
    if (Date.now() - p.at > PENDING_MS) { try { fs.unlinkSync(p.file); } catch (_) {} _pending.delete(id); }
  }
  // Leftovers from before a restart: the map is gone, so the file is orphaned.
  try {
    for (const f of fs.readdirSync(TMP)) {
      const full = path.join(TMP, f);
      const id = f.replace(/\.[^.]+$/, '');
      if (!_pending.has(id) && Date.now() - fs.statSync(full).mtimeMs > PENDING_MS) fs.unlinkSync(full);
    }
  } catch (_) {}
}
setInterval(_sweep, 30 * 60000).unref?.();

/** נקרא כשסרטון מגיע. שומר אותו זמנית ומחזיר את השאלה לשלוח. */
async function receive({ buffer, mimetype, caption, name }) {
  if (buffer.length > MAX_VIDEO_BYTES) throw new Error(`הסרטון גדול מדי (${Math.round(buffer.length / 1024 ** 2)}MB) — עד ${MAX_VIDEO_BYTES / 1024 ** 2}MB`);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const ext = /webm/.test(mimetype || '') ? 'webm' : /quicktime|mov/.test(mimetype || '') ? 'mov' : /3gp/.test(mimetype || '') ? '3gp' : 'mp4';
  const file = path.join(TMP, `${id}.${ext}`);
  fs.writeFileSync(file, buffer);
  const info = await _probe(file);
  const p = { id, file, ext, caption: String(caption || '').substring(0, 300), name: name || null, at: Date.now(), info, size: buffer.length };
  _pending.set(id, p);
  logger.info(`🎬 video received: ${id} (${Math.round(buffer.length / 1024 ** 2)}MB, ${info.duration}s)`);
  return p;
}

function pending(maxAgeMs = PENDING_MS) {
  return [..._pending.values()].filter(p => Date.now() - p.at < maxAgeMs).sort((a, b) => a.at - b.at);
}
function getPending(id) { return _pending.get(id) || null; }
function dropPending(id) {
  const p = _pending.get(id);
  if (p) { try { fs.unlinkSync(p.file); } catch (_) {} _pending.delete(id); }
}

function fmtDur(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}

function menu(list) {
  const one = list.length === 1 ? list[0] : null;
  const head = one
    ? `🎬 *קיבלתי סרטון*${one.info.duration ? ` · ${fmtDur(one.info.duration)} דק׳` : ''} · ${Math.max(1, Math.round(one.size / 1024 ** 2))}MB`
    : `🎬 *קיבלתי ${list.length} סרטונים*`;
  const lines = [head, '', 'מה לעשות איתו?'.replace('איתו', one ? 'איתו' : 'איתם'),
    '1. 💾 לשמור לצפייה מאוחרת — בתיקיית הסרטונים באפליקציה',
    '2. 🎧 להפוך ל-MP3 ולשלוח לך',
    '3. 📝 MP3 + תמלול בטקסט',
    '4. ❌ כלום',
  ];
  if (one && !one.info.hasAudio) lines.push('', '_(בסרטון הזה אין פס קול — MP3 ותמלול לא יעבדו)_');
  lines.push('', '_אפשר גם לשלב, למשל: 1+2_');
  return lines.join('\n');
}

/** "1", "1+2", "שמור", "mp3", "תמלל", "כלום" → { save, mp3, text, none } או null */
function parseChoice(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 40) return null;
  const c = { save: false, mp3: false, text: false, none: false };
  // Digits need something between them: "1+2", "1 2" — but "12" is not an answer.
  if (/^[1-4]((\s*(\+|,|ו-?|-|וגם|גם)\s*|\s+)[1-4])*\.?$/.test(t)) {
    for (const d of t.match(/[1-4]/g)) { if (d === '1') c.save = true; if (d === '2') c.mp3 = true; if (d === '3') { c.mp3 = true; c.text = true; } if (d === '4') c.none = true; }
    return c;
  }
  if (/^(כלום|ביטול|לא צריך|תמחק|מחק|אל תשמור)[.!]?$/.test(t)) { c.none = true; return c; }
  if (/(שמור|לשמור|תשמור|לצפייה|אחר כך|מאוחר)/.test(t)) c.save = true;
  if (/(mp3|אמ ?פי|אודיו|שמע|להפוך)/.test(t)) c.mp3 = true;
  if (/(תמלל|תמלול|לתמלל|טקסט)/.test(t)) { c.mp3 = true; c.text = true; }
  return (c.save || c.mp3 || c.text) ? c : null;
}

// ── Saved library ──────────────────────────────────────────────────
function _used() { return _load().reduce((a, v) => a + (v.size || 0), 0); }

async function save(id) {
  const p = _pending.get(id);
  if (!p) throw new Error('הסרטון כבר לא ממתין — שלח אותו שוב');
  if (_used() + p.size > QUOTA_BYTES) throw new Error('תיקיית הסרטונים מלאה (6GB) — מחק כמה סרטונים שכבר ראית באפליקציה');
  const file = path.join(DIR, `${id}.${p.ext}`);
  fs.copyFileSync(p.file, file);
  const thumb = path.join(DIR, `${id}.jpg`);
  try {
    const at = p.info.duration > 3 ? '1' : '0';
    await _run('ffmpeg', ['-y', '-v', 'error', '-ss', at, '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumb], 60000);
  } catch (e) { logger.warn('video thumb: ' + e.message.substring(0, 60)); }
  const l = _load();
  const item = {
    id, ts: p.at, caption: p.caption, file: path.basename(file), ext: p.ext,
    size: p.size, duration: p.info.duration, width: p.info.width, height: p.info.height,
    thumb: fs.existsSync(thumb) ? path.basename(thumb) : null, watched: false,
  };
  l.unshift(item);
  _save(l);
  logger.info(`🎬 video saved: ${id}`);
  return item;
}

/** MP3 להאזנה — 96kbps: סביר לדיבור ולמוזיקה, וקטן מספיק לשלוח בוואטסאפ. */
async function toMp3(id) {
  const p = _pending.get(id);
  const src = p ? p.file : (() => { const v = _load().find(x => x.id === id); return v ? path.join(DIR, v.file) : null; })();
  if (!src || !fs.existsSync(src)) throw new Error('הסרטון כבר לא ממתין — שלח אותו שוב');
  const out = path.join(TMP, `${id}.mp3`);
  await _run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '96k', out]);
  return out;
}

/**
 * Whisper takes up to 25MB. Speech at 16kHz mono 32kbps is ~14MB an hour;
 * longer videos are cut into 20-minute pieces and joined back.
 */
async function transcribe(id, transcribeAudio) {
  const p = _pending.get(id);
  const src = p ? p.file : (() => { const v = _load().find(x => x.id === id); return v ? path.join(DIR, v.file) : null; })();
  if (!src || !fs.existsSync(src)) throw new Error('הסרטון כבר לא ממתין');
  const base = path.join(TMP, `${id}-stt`);
  await _run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k',
    '-f', 'segment', '-segment_time', '1200', `${base}-%03d.mp3`]);
  const parts = fs.readdirSync(TMP).filter(f => f.startsWith(`${id}-stt-`)).sort();
  const texts = [];
  try {
    for (const f of parts) {
      const t = await transcribeAudio(fs.readFileSync(path.join(TMP, f)), 'audio/mpeg', f);
      if (t) texts.push(t);
    }
  } finally {
    for (const f of parts) { try { fs.unlinkSync(path.join(TMP, f)); } catch (_) {} }
  }
  return texts.join('\n\n').trim();
}

function list() { return _load(); }
function find(id) { return _load().find(v => v.id === id) || null; }
function filePath(id) { const v = find(id); return v ? path.join(DIR, v.file) : null; }
function thumbPath(id) { const v = find(id); return v && v.thumb ? path.join(DIR, v.thumb) : null; }

function setWatched(id, watched = true) {
  const l = _load(); const v = l.find(x => x.id === id);
  if (!v) return false;
  v.watched = !!watched; v.watchedAt = watched ? Date.now() : null; _save(l);
  return true;
}

function remove(id) {
  const l = _load(); const v = l.find(x => x.id === id);
  if (!v) return false;
  for (const f of [v.file, v.thumb]) if (f) { try { fs.unlinkSync(path.join(DIR, f)); } catch (_) {} }
  _save(l.filter(x => x.id !== id));
  return true;
}

function stats() {
  const l = _load();
  return { count: l.length, unwatched: l.filter(v => !v.watched).length, usedMB: Math.round(_used() / 1024 ** 2), quotaMB: QUOTA_BYTES / 1024 ** 2 };
}

module.exports = {
  receive, pending, getPending, dropPending, menu, parseChoice,
  save, toMp3, transcribe, list, find, filePath, thumbPath, setWatched, remove, stats, fmtDur,
};
