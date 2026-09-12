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

// ── Transcribe with Groq Whisper ─────────────────────────────────
async function transcribe(file) {
  if (!process.env.GROQ_API_KEY) return '';
  try {
    const buf = fs.readFileSync(file);
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'chunk.mp3');
    fd.append('model', 'whisper-large-v3-turbo');
    fd.append('language', 'he');
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
      body: fd,
    });
    const j = await r.json();
    return (j && j.text) ? j.text.trim() : '';
  } catch (e) {
    logger.warn?.('broadcast transcribe: ' + (e.message || '').substring(0, 70));
    return '';
  }
}

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
    const file = await captureChunk(st.url, c.chunkSec);
    if (!file) { logger.warn?.(`broadcast: capture failed for ${st.name}`); continue; }
    const text = await transcribe(file);
    try { fs.unlinkSync(file); } catch {}
    if (!text) continue;

    recent.push({ station: st.name, ts: Date.now(), text });
    if (recent.length > 60) recent = recent.slice(-60);

    // Kept on disk as well as in memory. `recent` is 60 chunks that vanish on
    // every restart, so until now the only transcript that survived was the
    // sentence around a keyword — the rest was transcribed, paid for, and
    // dropped. The hourly digest reads from the file, not from this array.
    try { require('./broadcast-digest').recordChunk({ station: st.name, text }); } catch (_) {}

    // Checked for a headline right away, not at the next hourly digest. The
    // Ohana interview was in the transcript at 08:15 and only reached him as
    // half a sentence in the 09:00 summary — after WhatsApp had it.
    try {
      const h = await require('./broadcast-headlines').onChunk({ station: st.name, text });
      if (h) headlines.push(h);
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
  STATIONS, checkOnce, formatHit, getStatus, listStations, toggleStation,
  addTerm, removeTerm, setEnabled, isEnabled, inActiveHours, loadConfig,
  saveConfig, getRecent, captureChunk, transcribe,
};
