'use strict';
/**
 * ניטור שידורים חיים — live Hebrew radio monitoring.
 *
 * Samples live Israeli radio, transcribes it with Groq Whisper, and alerts the
 * owner the moment a watched term (Kellner, his topics, rivals) is said on air.
 * For a spokesperson this is the difference between hearing about a mention
 * hours later and answering it while the programme is still running.
 *
 * Verified from the (Helsinki) server: ffmpeg can pull גלי צה"ל / גלגלצ / 103FM,
 * and Whisper turbo transcribes a 25s Hebrew chunk in ~0.3s. Several other
 * Israeli streams are geo-blocked — keep `STATIONS` to ones proven reachable.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('./logger');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'broadcast-monitor.json');

// Only streams verified to work from this server.
const STATIONS = [
  { id: 'glz', name: 'גלי צה"ל', url: 'https://glzwizzlv.bynetcdn.com/glz_mp3' },
  { id: '103fm', name: '103FM', url: 'https://cdn.cybercdn.live/103FM/Live/icecast.audio' },
  { id: 'glglz', name: 'גלגלצ', url: 'https://glzwizzlv.bynetcdn.com/glglz_mp3' },
  // Kan's own servers refuse this server (TLS alert); the StreamTheWorld relay
  // plays — checked 12.9 with a transcribed sample of the live programme.
  { id: 'kanbet', name: 'כאן ב', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/KAN_BET.mp3' },
];

const DEFAULTS = {
  enabled: false,
  stations: ['glz', '103fm', 'kanbet'],
  intervalMin: 4,        // how often each station is sampled
  chunkSec: 55,          // how much audio per sample
  activeFrom: 6,         // Israel hours — outside this window we don't spend
  activeTo: 23,
  terms: ['קלנר', 'אריאל קלנר'],
};

// 🎵 A station playing only music is not sampled for a while: a sample is
// 55 seconds of the daily transcription allowance, and a song has no headline.
// Two music samples in a row → 15 minutes' rest, then one look again.
const QUIET_MIN = 15;
const _quiet = {};   // station id → { n, until }
/** תחנות שמנגנות עכשיו מוזיקה ולא נדגמות — לאפליקציה. */
function quietStations() {
  const now = Date.now();
  return STATIONS.filter(s => (_quiet[s.id] || {}).until > now).map(s => ({ station: s.name, until: _quiet[s.id].until }));
}

let cfg = null;
let recent = [];         // { station, ts, text } — rolling transcript memory
let alerted = {};        // dedupHash → ts, so one mention isn't reported twice

function loadConfig() {
  if (cfg) return cfg;
  try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { cfg = { ...DEFAULTS }; }
  return cfg;
}
function saveConfig(next) {
  cfg = { ...loadConfig(), ...(next || {}) };
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {}
  return cfg;
}

function inActiveHours(d = new Date()) {
  const c = loadConfig();
  const h = +new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })).getHours();
  return h >= c.activeFrom && h < c.activeTo;
}

// ── Capture a chunk of live audio ────────────────────────────────
function captureChunk(url, seconds) {
  const out = path.join(os.tmpdir(), `bc-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  return new Promise((resolve) => {
    execFile('ffmpeg',
      ['-y', '-i', url, '-t', String(seconds), '-vn', '-acodec', 'libmp3lame',
       '-ar', '16000', '-ac', '1', '-b:a', '48k', out],
      { timeout: (seconds + 25) * 1000 },
      (err) => {
        if (err || !fs.existsSync(out)) { try { fs.unlinkSync(out); } catch {} return resolve(null); }
        resolve(out);
      });
  });
}

// ── Transcribe with Groq Whisper — within the daily allowance ────
// Groq allows 28,800 seconds of audio a day per model. Sampling three stations
// every four minutes is ~40,000 — by the evening the allowance was gone, and
// the 19:00 and 20:00 bulletins came back empty with no word in the log (13.9).
// Now: the turbo model first; a second model (its own allowance) when turbo is
// spent — for the bulletins always, for routine samples only while enough of
// it is left for bulletins and his voice notes (which use that model).
const ASR_DAY = 28800;
const ASR_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'];
const ASR_RESERVE = { 'whisper-large-v3-turbo': 0, 'whisper-large-v3': 9000 };
const ASR_FILE = path.join(__dirname, '..', 'data', 'broadcast', 'asr-usage.json');
// model → until ts. Kept on disk: after a restart the app said "15 hours left"
// while the main allowance was spent (13.9).
const _asrBlocked = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "broadcast", "asr-usage.json"), "utf8")).__blocked || {}; } catch (_) { return {}; } })();
let _asrWarned = 0;
function _asrUsage() {
  let u = {};
  try { u = JSON.parse(fs.readFileSync(ASR_FILE, 'utf8')); } catch (_) {}
  const since = Date.now() - 86400000;
  delete u.__blocked;
  for (const m of Object.keys(u)) u[m] = (u[m] || []).filter(e => e[0] > since);
  return u;
}
function _asrUsed(u, model) { return (u[model] || []).reduce((s, e) => s + e[1], 0); }
function _asrRecord(model, sec, exact = null) {
  const u = _asrUsage();
  // Groq said how much is used: replace the estimate with its number.
  if (exact != null) u[model] = [[Date.now(), exact]];
  else (u[model] = u[model] || []).push([Date.now(), Math.round(sec)]);
  try { fs.mkdirSync(path.dirname(ASR_FILE), { recursive: true }); fs.writeFileSync(ASR_FILE, JSON.stringify({ ...u, __blocked: _asrBlocked })); } catch (_) {}
}
/** כמה נשאר היום לכל מודל — ללוג ולאפליקציה. */
function asrStatus() {
  const u = _asrUsage();
  return ASR_MODELS.map(m => ({ model: m, used: _asrUsed(u, m), left: Math.max(0, ASR_DAY - _asrUsed(u, m)), blockedUntil: _asrBlocked[m] || null }));
}

async function transcribe(file, { priority = 'low' } = {}) {
  if (!process.env.GROQ_API_KEY) return '';
  let buf;
  try { buf = fs.readFileSync(file); } catch (_) { return ''; }
  const sec = Math.max(1, buf.length / 6000);   // 48 kbps
  const u = _asrUsage();
  for (const model of ASR_MODELS) {
    if ((_asrBlocked[model] || 0) > Date.now()) continue;
    // Routine samples leave the second model's last hours to what matters.
    if (priority !== 'high' && _asrUsed(u, model) + sec > ASR_DAY - (ASR_RESERVE[model] || 0)) continue;
    try {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'chunk.mp3');
      fd.append('model', model);
      fd.append('language', 'he');
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
        body: fd,
      });
      const j = await r.json().catch(() => ({}));
      if (j && j.error) {
        const msg = String(j.error.message || '');
        if (j.error.code === 'rate_limit_exceeded') {
          const w = msg.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/);
          const wait = w ? ((+w[1] || 0) * 3600 + (+w[2] || 0) * 60 + (+w[3] || 0)) * 1000 : 10 * 60000;
          _asrBlocked[model] = Date.now() + Math.max(wait, 60000);
          _asrRecord(model, 0);   // saves the block with the usage
          if (Date.now() - _asrWarned > 20 * 60000) {
            _asrWarned = Date.now();
            logger.warn(`🎙️ Groq ${model}: daily audio allowance reached — ${ASR_MODELS[ASR_MODELS.indexOf(model) + 1] ? 'moving to ' + ASR_MODELS[ASR_MODELS.indexOf(model) + 1] : 'nothing left'} (${msg.substring(0, 90)})`);
          }
          continue;
        }
        logger.warn('broadcast transcribe: ' + msg.substring(0, 100));
        return '';
      }
      _asrRecord(model, sec);
      return (j && j.text) ? j.text.trim() : '';
    } catch (e) {
      logger.warn?.('broadcast transcribe: ' + (e.message || '').substring(0, 70));
      return '';
    }
  }
  // Every model spent, and this was a bulletin: he hears of it, once in a while —
  // not by finding an empty digest.
  if (priority === 'high' && Date.now() - _asrAlerted > 6 * 3600000) {
    _asrAlerted = Date.now();
    const back = Math.min(...ASR_MODELS.map(m => _asrBlocked[m] || Date.now()));
    const at = new Date(back).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
    try {
      require('./jarvis-api').pushAlert({
        title: '⚠️ מכסת התמלול היומית נגמרה',
        summary: `מהדורת החדשות לא תומללה. התמלול יחזור בהדרגה מ-${at}`,
        body: `שירות התמלול (Groq) מאפשר כמות שמע מוגבלת ביום, והיא נגמרה בשני המודלים. מהדורות ודגימות מהרדיו לא יתומללו עד שהמכסה תתחדש — בהדרגה, החל מ-${at}. הודעות קוליות שלך עלולות להיכשל גם הן.`,
        kind: 'quota', urgency: 'normal', supersedes: 'quota',
      });
    } catch (_) {}
  }
  return '';
}
let _asrAlerted = 0;

// Pull the sentence around a hit so the alert carries context, not a bare word.
function _sentenceAround(text, term) {
  const i = text.indexOf(term);
  if (i < 0) return text.substring(0, 200);
  const start = Math.max(0, text.lastIndexOf('.', i) + 1);
  let end = text.indexOf('.', i + term.length);
  if (end < 0) end = Math.min(text.length, i + 160);
  return text.slice(start, end + 1).trim().substring(0, 260);
}

// ── One sampling pass over the enabled stations ──────────────────
// Returns [{ station, term, quote, text, ts }] for fresh hits only.
async function checkOnce() {
  const c = loadConfig();
  const hits = [];
  const headlines = [];
  hits.headlines = headlines;
  const terms = (c.terms || []).filter(Boolean);
  if (!terms.length) return hits;

  for (const st of STATIONS.filter(s => (c.stations || []).includes(s.id))) {
    if ((_quiet[st.id] || {}).until > Date.now()) continue;
    const file = await captureChunk(st.url, c.chunkSec);
    if (!file) { logger.warn?.(`broadcast: capture failed for ${st.name}`); continue; }
    const text = await transcribe(file);
    const _ts = Date.now();
    if (!text) { try { fs.unlinkSync(file); } catch {} continue; }
    const hlm = require('./broadcast-headlines');
    // 📢 An advert is not kept — neither its text nor its audio ("לא צריך
    // פרסומות, חבל על הזיכרון", 14.9). Its kind is still noted for the app.
    if (hlm.isAd(text)) {
      try { fs.unlinkSync(file); } catch {}
      try { await hlm.onChunk({ station: st.name, text, ts: _ts }); } catch (_) {}
      continue;
    }

    recent.push({ station: st.name, ts: _ts, text });
    if (recent.length > 60) recent = recent.slice(-60);

    // Checked for a headline right away, not at the next hourly digest. The
    // Ohana interview was in the transcript at 08:15 and only reached him as
    // half a sentence in the 09:00 summary — after WhatsApp had it. The same
    // check says what the sample is; a song or an advert is not stored.
    let _kindNow = null;
    try {
      const hs = await hlm.onChunk({ station: st.name, text, ts: _ts });
      for (const h of (Array.isArray(hs) ? hs : (hs ? [hs] : []))) headlines.push(h);
      const k0 = hlm.lastKind(st.name);
      if (k0 && k0.ts === _ts) _kindNow = k0.kind;
    } catch (_) {}
    const _keep = _kindNow !== 'music' && _kindNow !== 'ads';
    let _audio = null;
    if (_keep) { try { _audio = require('./broadcast-digest').keepAudio(file, st.id, _ts); } catch (_) {} }
    try { fs.unlinkSync(file); } catch {}

    // Kept on disk as well as in memory. `recent` is 60 chunks that vanish on
    // every restart, so until now the only transcript that survived was the
    // sentence around a keyword — the rest was transcribed, paid for, and
    // dropped. The hourly digest reads from the file, not from this array.
    if (_keep) { try { require('./broadcast-digest').recordChunk({ station: st.name, text, ts: _ts, audio: _audio }); } catch (_) {} }

    try {
      const k = hlm.lastKind(st.name);
      if (k && k.ts === _ts) {
        const q = _quiet[st.id] || (_quiet[st.id] = { n: 0, until: 0 });
        if (k.kind === 'music') {
          q.n++;
          if (q.n >= 2) { q.until = Date.now() + QUIET_MIN * 60000; logger.info(`🎵 ${st.name}: music — not sampled for ${QUIET_MIN} min`); }
        } else if (k.kind === 'news' || k.kind === 'talk') q.n = 0;
      }
    } catch (_) {}

    for (const term of terms) {
      if (!text.includes(term)) continue;
      const quote = _sentenceAround(text, term);
      // Dedup: same station + same quote within 30 min is the same mention.
      const key = st.id + '|' + quote.replace(/\s+/g, '').substring(0, 60);
      const now = Date.now();
      for (const [k, t] of Object.entries(alerted)) if (now - t > 30 * 60 * 1000) delete alerted[k];
      if (alerted[key]) continue;
      alerted[key] = now;
      hits.push({ station: st.name, term, quote, text, ts: now });
      break; // one alert per chunk is enough
    }
  }
  return hits;
}

function formatHit(h) {
  const time = new Date(h.ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
  return `📻 *נאמר עכשיו בשידור*\n\n🎙️ *${h.station}* · 🕐 ${time}\n🔑 _${h.term}_\n\n"${h.quote}"\n\n_✍️ לניסוח תגובה: שלח *תגובה על ${h.term}*_`;
}

function getStatus() {
  const c = loadConfig();
  const names = STATIONS.filter(s => (c.stations || []).includes(s.id)).map(s => s.name);
  return `📻 *ניטור שידורים* — ${c.enabled ? '🟢 פעיל' : '🔴 כבוי'}\n\n` +
    `🎙️ תחנות: ${names.join(' · ') || '—'}\n` +
    `🔑 מילים: ${(c.terms || []).join(' · ') || '—'}\n` +
    `⏱️ דגימה: ${c.chunkSec}ש׳ כל ${c.intervalMin} דק׳\n` +
    `🕐 שעות פעילות: ${c.activeFrom}:00–${c.activeTo}:00\n\n` +
    `_פקודות:_ *שידורים הפעל* · *שידורים כבה* · *שידורים מילה <מילה>* · *שידורים תחנות*`;
}

function listStations() {
  const c = loadConfig();
  return `🎙️ *תחנות זמינות* (נבדקו מהשרת):\n` +
    STATIONS.map(s => `${(c.stations || []).includes(s.id) ? '✅' : '⬜'} *${s.name}* — \`${s.id}\``).join('\n') +
    `\n\n_להוסיף/להסיר:_ *שידורים תחנה <id>*`;
}

function toggleStation(id) {
  const c = loadConfig();
  const list = new Set(c.stations || []);
  if (!STATIONS.some(s => s.id === id)) return null;
  list.has(id) ? list.delete(id) : list.add(id);
  saveConfig({ stations: [...list] });
  return [...list];
}
function addTerm(t) {
  const c = loadConfig();
  const terms = new Set(c.terms || []);
  terms.add(t.trim());
  saveConfig({ terms: [...terms] });
  return [...terms];
}
function removeTerm(t) {
  const c = loadConfig();
  const terms = (c.terms || []).filter(x => x !== t.trim());
  saveConfig({ terms });
  return terms;
}
function setEnabled(v) { return saveConfig({ enabled: !!v }); }
function isEnabled() { return !!loadConfig().enabled; }
function getRecent(n = 5) { return recent.slice(-n); }

module.exports = {
  asrStatus, quietStations,
  STATIONS, checkOnce, formatHit, getStatus, listStations, toggleStation,
  addTerm, removeTerm, setEnabled, isEnabled, inActiveHours, loadConfig,
  saveConfig, getRecent, captureChunk, transcribe,
};
