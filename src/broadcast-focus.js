'use strict';
/**
 * 🎧 האזנה רציפה לראיון חי.
 *
 * הדגימה הרגילה היא 55 שניות כל 4 דקות — שלושה רבעים מכל ראיון נופלים בין
 * הדגימות. כשהוא אומר "האזן לכאן ב" (או "ב-17:00 ל-30 דק׳"), תחנה אחת
 * מוקלטת ברצף: קטע של דקה אחרי קטע של דקה, כל אחד מתומלל מיד ועובר באותו
 * מסלול כותרות — כך שציטוט חם מגיע אליו תוך דקה-שתיים.
 * בסוף: הקלטה מלאה אחת, ותקציר — כותרות וקטעים חזקים, כל ציטוט נבדק מילה
 * במילה מול התמלול (17.9, ראיון איזנקוט בכאן ב/כאן 11).
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('./logger');

const DIR = path.join(__dirname, '..', 'data', 'broadcast', 'focus');
const STATE = path.join(DIR, 'state.json');
const CHUNK_SEC = 60;
const MAX_MIN = 90;

// What he says → which station.
const ALIASES = [
  [/כאן\s*(ב|בית|11|חדשות)?|kan/i, 'kanbet'],
  [/103|מאה ושלוש|103fm/i, '103fm'],
  [/גל[יי]?\s*צה"?ל|גלצ|גלי\s*צ|glz/i, 'glz'],
];

let _state = null;
let _running = false;
const _out = [];   // headlines waiting to be sent

function _load() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } }
function _save() { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(_state)); } catch (_) {} }
_state = _load();

function stationOf(text) {
  for (const [re, id] of ALIASES) if (re.test(String(text || ''))) return id;
  return null;
}

/**
 * "האזן לכאן ב", "האזן ל-103 ב-17:00 ל-45 דק׳", "הקלט את גלי צה"ל עכשיו חצי שעה".
 * Returns { stationId, from, minutes } or null when it is not such a request.
 */
function parse(text) {
  const t = String(text || '').trim();
  // Not \b: it does not see Hebrew letters as word characters.
  if (!/^(האזן|תאזין|הקלט|תקליט|האזנה)(?=\s|$)/.test(t)) return null;
  const stationId = stationOf(t);
  if (!stationId) return { error: 'לאיזו תחנה? כאן ב, 103FM או גלי צה"ל' };
  let from = Date.now();
  const hm = t.match(/(?:ב-?|בשעה\s*)(\d{1,2}):(\d{2})/);
  if (hm) {
    const il = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const offset = Date.now() - il.getTime();
    il.setHours(+hm[1], +hm[2], 0, 0);
    from = il.getTime() + offset;
    // A time already passed today by more than the interview itself is tomorrow's.
    if (from < Date.now() - 60 * 60000) from += 86400000;
  }
  let minutes = 30;
  const mm = t.match(/(\d{1,3})\s*(?:דק|ד׳|ד')/);
  if (mm) minutes = +mm[1];
  else if (/שעה וחצי/.test(t)) minutes = 90;
  else if (/חצי שעה/.test(t)) minutes = 30;
  else if (/רבע שעה/.test(t)) minutes = 15;
  else if (/שעה/.test(t)) minutes = 60;
  minutes = Math.max(5, Math.min(MAX_MIN, minutes));
  return { stationId, from, minutes };
}

function _station(id) { return require('./broadcast-monitor').STATIONS.find(s => s.id === id); }
const _hhmm = t => new Date(t).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });

function start({ stationId, from = Date.now(), minutes = 30, reason = '' }) {
  const st = _station(stationId);
  if (!st) return { error: 'תחנה לא מוכרת' };
  if (_state && !_state.done) return { error: `כבר מאזין ל${_state.station} עד ${_hhmm(_state.until)} — "עצור האזנה" קודם` };
  const id = `${from}-${stationId}`;
  _state = {
    id, stationId, station: st.name, from, until: from + minutes * 60000, reason: String(reason || '').substring(0, 120),
    chunks: [], done: false, created: Date.now(),
    // "ראיון איזנקוט", "עם בנט" — what to listen for; bare "האזן לכאן ב" has none.
    subject: /ריאיון|ראיון|שיחה|נאום|עם /.test(String(reason || '')) ? String(reason).substring(0, 120) : '',
  };
  _save();
  logger.info(`🎧 focus: ${st.name} ${_hhmm(from)}–${_hhmm(_state.until)}${reason ? ' — ' + reason : ''}`);
  setImmediate(tick);
  return { ok: true, ..._public() };
}

function stop() {
  if (!_state || _state.done) return { error: 'אין האזנה פעילה' };
  _state.until = Math.min(_state.until, Date.now());
  _save();
  setImmediate(tick);
  return { ok: true, ..._public() };
}

function _public() {
  if (!_state) return { active: false };
  return {
    active: !_state.done, station: _state.station, stationId: _state.stationId,
    from: _state.from, until: _state.until, chunks: (_state.chunks || []).length, waiting: Date.now() < _state.from,
  };
}
function status() { return _public(); }

/** הסטיישן שמוקלט עכשיו ברצף — הדגימה הרגילה מדלגת עליו. */
function busyStation() {
  return _state && !_state.done && Date.now() >= _state.from && Date.now() < _state.until ? _state.stationId : null;
}

function drainHeadlines() { return _out.splice(0, _out.length); }

/** Called every few seconds. One chunk at a time; the loop is its own pace. */
async function tick() {
  if (_running || !_state || _state.done) return;
  if (Date.now() < _state.from) return;
  _running = true;
  try {
    while (_state && !_state.done && Date.now() < _state.until) {
      await _oneChunk();
    }
    if (_state && !_state.done && Date.now() >= _state.until) await _finish();
  } catch (e) { logger.warn('🎧 focus: ' + (e.message || '').substring(0, 80)); }
  finally { _running = false; }
}

async function _oneChunk() {
  const bm = require('./broadcast-monitor');
  const st = _station(_state.stationId);
  const left = Math.round((_state.until - Date.now()) / 1000);
  const sec = Math.max(10, Math.min(CHUNK_SEC, left));
  const ts = Date.now();
  const file = await bm.captureChunk(st.url, sec);
  if (!file) { logger.warn(`🎧 focus: capture failed (${st.name})`); await new Promise(r => setTimeout(r, 5000)); return; }
  // The full recording is built from these.
  const dir = path.join(DIR, _state.id);
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, `${String((_state.chunks || []).length).padStart(3, '0')}.mp3`);
  try { fs.copyFileSync(file, part); } catch (_) {}
  const text = await bm.transcribe(file, { priority: 'high' });
  _state.chunks.push({ ts, file: path.basename(part), text: text || '' });
  _save();
  if (text) {
    const hl = require('./broadcast-headlines');
    const bd = require('./broadcast-digest');
    let audio = null;
    try { audio = bd.keepAudio(file, st.id, ts); } catch (_) {}
    try { bd.recordChunk({ station: st.name, text, ts, audio }); } catch (_) {}
    try {
      const hs = await hl.onChunk({ station: st.name, text, ts, guest: _state.subject || null, wait: true });
      for (const h of (Array.isArray(hs) ? hs : (hs ? [hs] : []))) _out.push(h);
    } catch (e) { logger.warn('🎧 focus headline: ' + (e.message || '').substring(0, 60)); }
  }
  try { fs.unlinkSync(file); } catch (_) {}
  await _checkEnd();
}

// ── Is the interview still on? ─────────────────────────────────────
// "לא צריך 50 דקות… תשים לב מתי הוא נגמר" (17.9). After each minute a small
// model looks at the last two: still the interview, or something else now.
// Two minutes in a row without it, once it began — stop. Never began within
// START_WAIT minutes — stop too, and say so.
const END_AFTER = 2;
const START_WAIT = 8;
async function _checkEnd() {
  const s = _state;
  if (!s || s.done) return;
  const last = (s.chunks || []).slice(-2).map(c => c.text).filter(Boolean);
  if (!last.length) return;
  const about = s.subject || '';
  let r = null;
  try {
    r = await require('./claude').classifyJSON(
      `מה מקליטים: ${about || 'הראיון או השיחה שהיו בשידור כשההקלטה התחילה'}\n\n` +
      (!about && s.chunks[0] ? `הדקה הראשונה של ההקלטה:\n${String(s.chunks[0].text).substring(0, 600)}\n\n` : '') +
      `שתי הדקות האחרונות:\n${last.map(t => t.substring(0, 900)).join('\n---\n')}`,
      {
        system: 'אתה מאזין לרדיו. האם בדקה האחרונה משודר הראיון או השיחה שמקליטים — המרואיין עצמו מדבר, או שהמראיינים משוחחים איתו? ' +
          'פרומו, הקדמה ("בעוד רגע", "הקלטנו ראיון שיעלה היום"), חדשות, פרסומות, שיר, או ראיון עם מישהו אחר — לא. ' +
          'החזר JSON בלבד: {"on": true|false, "why": "חצי משפט"}',
        maxTokens: 60, model: 'claude-haiku-4-5-20251001', temperature: 0,
      });
  } catch (_) { return; }
  if (!r || typeof r.on !== 'boolean') return;
  const cur = s.chunks[s.chunks.length - 1];
  if (cur) cur.on = r.on;
  if (r.on) { s.seenOn = true; s.offRun = 0; }
  else s.offRun = (s.offRun || 0) + 1;
  _save();
  logger.info(`🎧 focus: ${r.on ? 'on air' : 'not on'} — ${String(r.why || '').substring(0, 60)}`);
  if (s.seenOn && s.offRun >= END_AFTER) {
    s.endReason = 'הראיון נגמר';
    s.until = Date.now();
    _save();
  } else if (!s.seenOn && s.chunks.length >= START_WAIT) {
    s.endReason = `הראיון לא עלה לשידור ב-${START_WAIT} הדקות הראשונות`;
    s.until = Date.now();
    _save();
  }
}

// ── At the end: one recording, and what mattered in it ──────────────
const SUMMARY_SYSTEM = `אתה עורך חדשות פוליטי. לפניך תמלול רציף של קטע רדיו (דקה אחרי דקה, עם שעה לכל קטע). התמלול אוטומטי ויש בו שיבושי מילים.
החזר JSON בלבד:
{"who":"מי התראיין ובאיזו תוכנית, רק אם נאמר בתמלול, אחרת null",
 "headlines":[{"time":"HH:MM","headline":"כותרת חדשותית קצרה — מי אמר מה","quote":"ציטוט מדויק מילה במילה מהתמלול, 6-30 מילים"}],
 "strong":[{"time":"HH:MM","what":"משפט אחד: על מה דובר","quote":"ציטוט מדויק מילה במילה מהתמלול"}],
 "summary":"3-5 משפטים: מה עלה בראיון, לפי הסדר"}
כללים:
- כותרת = אמירה חדשותית: עמדה חדשה, התחייבות, התקפה על אדם או מפלגה, חשיפה, הכחשה. לא שאלות של המראיין ולא דברי מנחה.
- עד 8 כותרות ועד 6 קטעים חזקים, מהחשוב לפחות חשוב.
- ציטוט חייב להיות רצף מילים שמופיע בתמלול כמו שהוא. אל תתקן, אל תקצר באמצע, אל תחבר שני משפטים.
- שם של אדם — רק כפי שנאמר בתמלול. אל תנחש מי מדבר.`;

function _norm(s) { return String(s || '').replace(/["'״׳“”„]/g, '').replace(/[.,!?:;()\-–—]/g, ' ').replace(/\s+/g, ' ').trim(); }
function _inText(quote, all) {
  const q = _norm(quote);
  return q.split(' ').length >= 4 && _norm(all).includes(q);
}

async function _finish() {
  const s = _state;
  s.done = true;
  _save();
  let chunks = (s.chunks || []).filter(c => c.file);
  if (s.endReason && !s.seenOn) {
    _notify(`🎧 ${s.station}: ${s.endReason} — עצרתי ולא שמרתי הקלטה.`, null);
    return;
  }
  const firstOn = chunks.findIndex(c => c.on === true);
  let lastOn = -1; chunks.forEach((c, i) => { if (c.on === true) lastOn = i; });
  if (firstOn >= 0) chunks = chunks.slice(Math.max(0, firstOn - 1), lastOn + 1);
  const dir = path.join(DIR, s.id);
  logger.info(`🎧 focus done: ${s.station}, ${chunks.length} chunks`);
  if (!chunks.length) { _notify(`🎧 ההאזנה ל${s.station} הסתיימה — לא הצלחתי להקליט.`, null); return; }

  // One mp3.
  let full = null;
  try {
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, chunks.map(c => `file '${path.join(dir, c.file)}'`).join('\n'));
    full = path.join(dir, `${s.station.replace(/[^\p{L}\p{N}]+/gu, '')}-${_hhmm(s.from).replace(':', '')}.mp3`);
    await new Promise((res, rej) => execFile('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', full],
      { timeout: 120000 }, e => (e ? rej(e) : res())));
  } catch (e) { logger.warn('🎧 concat: ' + (e.message || '').substring(0, 60)); full = null; }

  // What mattered.
  const transcript = chunks.filter(c => c.text).map(c => `[${_hhmm(c.ts)}] ${c.text}`).join('\n');
  const all = chunks.map(c => c.text).join(' ');
  let out = null;
  if (transcript.length > 200) {
    try {
      out = await require('./claude').classifyJSON(transcript.substring(0, 60000), {
        system: SUMMARY_SYSTEM, maxTokens: 3000, model: 'claude-sonnet-4-6', temperature: 0,
      });
    } catch (e) { logger.warn('🎧 summary: ' + (e.message || '').substring(0, 60)); }
  }
  // Only quotes really in the transcript.
  let dropped = 0;
  const keep = arr => (Array.isArray(arr) ? arr : []).filter(x => {
    if (!x || !x.quote) return true;
    if (_inText(x.quote, all)) return true;
    dropped++; return false;
  });
  const heads = out ? keep(out.headlines) : [];
  const strong = out ? keep(out.strong) : [];
  if (dropped) logger.info(`🎧 focus: ${dropped} quote(s) not found word for word — left out`);

  const lines = [`🎧 *האזנה רציפה — ${s.station}* · ${_hhmm(s.from)}–${_hhmm(chunks[chunks.length - 1].ts + CHUNK_SEC * 1000)}`];
  if (s.endReason) lines.push(`⏹️ ${s.endReason} — ההקלטה נעצרה לבד`);
  if (out && out.who) lines.push(`🎙️ ${out.who}`);
  if (out && out.summary) lines.push('', out.summary);
  if (heads.length) {
    lines.push('', '🗞️ *כותרות*');
    for (const h of heads) lines.push(`• ${h.time ? h.time + ' · ' : ''}*${h.headline}*${h.quote ? `\n  "${h.quote}"` : ''}`);
  }
  if (strong.length) {
    lines.push('', '💪 *קטעים חזקים*');
    for (const x of strong) lines.push(`• ${x.time ? x.time + ' · ' : ''}${x.what || ''}${x.quote ? `\n  "${x.quote}"` : ''}`);
  }
  if (!out) lines.push('', '⚠️ לא הצלחתי לסכם — ההקלטה המלאה מצורפת.');
  lines.push('', '_כל ציטוט נבדק מילה במילה מול התמלול._');
  try { fs.writeFileSync(path.join(dir, 'transcript.txt'), transcript); } catch (_) {}
  s.summary = { heads, strong, who: out && out.who, text: lines.join('\n') };
  s.full = full ? path.basename(full) : null;
  _save();
  _notify(lines.join('\n'), full);
}

let _sender = null;   // index.js: async (text, file) => …
function setSender(fn) { _sender = fn; }
function _notify(text, file) {
  if (!_sender) { logger.warn('🎧 focus: no sender'); return; }
  Promise.resolve(_sender(text, file)).catch(e => logger.warn('🎧 send: ' + (e.message || '').substring(0, 60)));
}

module.exports = { parse, start, stop, status, tick, busyStation, drainHeadlines, setSender, stationOf };
