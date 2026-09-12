'use strict';
/**
 * 🗞️ מהדורות החדשות בשעה עגולה.
 *
 * הניטור הרגיל דוגם 55 שניות כל 4 דקות, ולכן תופס מהדורה רק במקרה, וחלקית.
 * אבל בכל שעה עגולה כל תחנה פותחת במהדורה — הכותרות של אותו רגע, מסודרות.
 * כאן, בכל שעה עגולה, נקלטות 4 דקות מלאות מכל תחנה, מתומללות, ומודל מוציא
 * מהן את הכותרות.
 *
 * ובעיקר: מה שכבר נאמר לו לא חוזר. כל כותרת נבדקת מול כותרות המהדורות
 * מ-6 השעות האחרונות — כותרת שחוזרת כמו שהיא נשמטת, וכותרת שחוזרת עם פרט
 * חדש מופיעה רק עם מה שחדש.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const FILE = path.join(__dirname, '..', 'data', 'broadcast', 'bulletins.json');
const STATE = path.join(__dirname, '..', 'data', 'broadcast', 'bulletins-state.json');
const CAPTURE_SEC = 240;
const LOOKBACK_MS = 6 * 3600000;
// News stations only — גלגלצ is music.
const BULLETIN_STATIONS = ['glz', '103fm', 'kanbet'];

function _load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } }
function _save(l) { try { fs.writeFileSync(FILE, JSON.stringify(l.slice(0, 200), null, 1)); } catch (_) {} }
function _state() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
const _il = (t = Date.now()) => new Date(new Date(t).toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
const _hhmm = t => { const d = _il(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

const SYSTEM = `אתה עורך חדשות. לפניך תמלול של תחילת מהדורת החדשות בשעה עגולה, מכמה תחנות רדיו, ורשימת כותרות שכבר נאמרו במהדורות הקודמות.
1. חלץ את כותרות המהדורה עצמה — ידיעות חדשותיות בלבד. לא: פרסומות, מזג אוויר, תנועה, ספורט, קדימונים לתכניות, מוזיקה.
2. ידיעה שהופיעה בכמה תחנות — כותרת אחת עם כל התחנות.
3. לכל כותרת החלט מול הכותרות הקודמות: new — לא נאמרה קודם; update — אותו סיפור אבל עם פרט חדש (כתוב רק את מה שחדש); repeat — כבר נאמרה, בלי שום חידוש.
4. כתוב כל כותרת במשפט אחד, בעברית פשוטה, בלי להמציא פרט שלא נשמע בתמלול. התמלול אוטומטי ויש בו טעויות — אל תסיק מעבר למה שברור.
החזר JSON בלבד:
{"headlines":[{"text":"הכותרת","stations":["..."],"status":"new|update|repeat","update":"מה חדש — רק כש-update, אחרת null"}]}`;

async function _captureAll() {
  const bm = require('./broadcast-monitor');
  const stations = bm.STATIONS.filter(s => BULLETIN_STATIONS.includes(s.id));
  logger.info('🗞️ bulletin: capturing ' + stations.map(s => s.name).join(', '));
  const results = await Promise.all(stations.map(async st => {
    const f = await bm.captureChunk(st.url, CAPTURE_SEC);
    if (!f) { logger.warn('🗞️ bulletin: no audio from ' + st.name); return null; }
    try {
      const text = await bm.transcribe(f);
      logger.info('🗞️ bulletin: ' + st.name + ' → ' + (text || '').length + ' chars');
      if (!text) return null;
      // The bulletin is transcript like any other: searchable, and in the digest.
      try { require('./broadcast-digest').recordChunk({ station: st.name, text }); } catch (_) {}
      return { station: st.name, text };
    } finally { try { fs.unlinkSync(f); } catch (_) {} }
  }));
  return results.filter(Boolean);
}

/** מהדורה אחת: קליטה, תמלול, כותרות, וסימון מה חדש. */
async function runHour(hourTs, fromDisk = false) {
  // After a restart mid-bulletin the live audio is gone; what was recorded
  // around the round hour (the regular samples included) is used instead.
  const heard = fromDisk
    ? Object.values(require('./broadcast-digest').chunksBetween(hourTs - 30000, hourTs + 8 * 60000).reduce((m, c) => { (m[c.station] = m[c.station] || { station: c.station, text: '' }).text += ' ' + c.text; return m; }, {}))
    : await _captureAll();
  if (!heard.length) { logger.warn('🗞️ bulletin: nothing captured'); return null; }
  const prev = _load().filter(b => b.hourTs >= hourTs - LOOKBACK_MS && b.hourTs < hourTs)
    .flatMap(b => (b.headlines || []).map(h => `${_hhmm(b.hourTs)}: ${h.text}${h.update ? ` (${h.update})` : ''}`));
  const r = await require('./claude').classifyJSON(
    `מהדורת ${_hhmm(hourTs)}:\n\n` + heard.map(h => `[${h.station}]\n${h.text.substring(0, 5000)}`).join('\n\n') +
    `\n\nכותרות שכבר נאמרו ב-6 השעות האחרונות:\n${prev.length ? prev.slice(-60).join('\n') : '(אין)'}`,
    { system: SYSTEM, maxTokens: 2000 }
  );
  // Sport still slipped through the prompt (a windsurfing medal at 18:00, 12.9).
  const SPORT = /(פרמייר|ליג(?![א-ת])|קבוצתו|קבוצתה|יורוליג|מדליי|אליפות|אולימפ|גמר|ליגה|ליגת|כדורגל|כדורסל|טניס|גלישת רוח|שחייה|ג'ודו|נבחרת|שער|ניצחון על)/;
  const all = Array.isArray(r && r.headlines) ? r.headlines.filter(h => h && h.text && !SPORT.test(h.text)) : [];
  const b = {
    hourTs, label: _hhmm(hourTs), stations: heard.map(h => h.station), ts: Date.now(),
    // Repeats are kept in the record — the next hour compares against them too.
    headlines: all.map(h => ({
      text: String(h.text).substring(0, 240), stations: (h.stations || []).slice(0, 4),
      status: ['new', 'update', 'repeat'].includes(h.status) ? h.status : 'new',
      update: h.status === 'update' && h.update ? String(h.update).substring(0, 240) : null,
    })),
  };
  const list = _load().filter(x => x.hourTs !== hourTs);
  list.unshift(b);
  _save(list);
  const fresh = b.headlines.filter(h => h.status !== 'repeat');
  logger.info(`🗞️ bulletin ${b.label}: ${b.headlines.length} headlines, ${fresh.length} new/updated (${b.stations.join(', ')})`);
  return b;
}

/** המהדורה של שעה מסוימת — מה שהתקציר השעתי מצרף. */
function forHour(hourTs) { return _load().find(b => b.hourTs === hourTs) || null; }
function recent(n = 12) { return _load().slice(0, n); }

/** שורות לתקציר: רק מה שחדש, או שורה אחת שאומרת שהמהדורה חזרה על עצמה. */
function formatForDigest(b) {
  // No headlines at all = no bulletin was heard (a station ran a programme
  // through the hour) — that is not "it repeated itself".
  if (!b || !(b.headlines || []).length) return [];
  const fresh = (b.headlines || []).filter(h => h.status !== 'repeat');
  if (!fresh.length) return ['', `🗞️ _מהדורת ${b.label} חזרה על כותרות שכבר שמעת._`];
  const lines = ['', `🗞️ *מהדורת ${b.label} — מה חדש:*`];
  for (const h of fresh) {
    const st = h.stations && h.stations.length ? ` _(${h.stations.join(', ')})_` : '';
    lines.push(h.status === 'update' ? `• 🔄 ${h.text} — *חדש:* ${h.update}${st}` : `• ${h.text}${st}`);
  }
  const rep = (b.headlines || []).length - fresh.length;
  if (rep > 0) lines.push(`_ועוד ${rep} כותרות שחזרו מהשעות הקודמות — לא חזרתי עליהן._`);
  return lines;
}

// ── Schedule: a few seconds past each round hour, in active hours ────
let _timer = null, _running = false;
function start() {
  if (_timer) return;
  // A bulletin cut off by a restart: finish it from what is on disk.
  setTimeout(async () => {
    try {
      const st = _state();
      if (st.lastHour && !forHour(st.lastHour) && Date.now() - st.lastHour < 40 * 60000 && Date.now() - st.lastHour > 6 * 60000) {
        logger.info('🗞️ bulletin: recovering ' + _hhmm(st.lastHour) + ' from the transcript');
        _running = true; await runHour(st.lastHour, true);
      }
    } catch (e) { logger.warn('🗞️ bulletin recover: ' + (e.message || '').substring(0, 60)); }
    finally { _running = false; }
  }, 45000);
  _timer = setInterval(async () => {
    if (_running) return;
    try {
      const bm = require('./broadcast-monitor');
      if (!bm.isEnabled() || !bm.inActiveHours()) return;
      const d = _il();
      if (d.getMinutes() !== 0 || d.getSeconds() < 10) return;
      const now = new Date(); now.setSeconds(0, 0);
      const hourTs = now.getTime();
      const st = _state();
      if (st.lastHour === hourTs) return;
      fs.writeFileSync(STATE, JSON.stringify({ lastHour: hourTs }));
      _running = true;
      await runHour(hourTs);
    } catch (e) { logger.warn('🗞️ bulletin: ' + (e.message || '').substring(0, 80)); }
    finally { _running = false; }
  }, 15000);
}

module.exports = { start, runHour, forHour, recent, formatForDigest };
