'use strict';
/**
 * גשר JARVIS — the phone app and the WhatsApp bot, one brain.
 *
 * Today they are two assistants that share nothing: JARVIS has its own Claude
 * key and its own memory file on the phone, the bot has its own on the server,
 * and neither knows what the other was told. This is the seam between them.
 *
 * HTTP rather than a socket, deliberately. The desktop agent holds a socket
 * because it sits on a machine that is always awake; a phone does not. Android
 * suspends background sockets under Doze, and a dropped socket that looks
 * connected is worse than no socket at all. Short polls survive that, need no
 * new Gradle dependency on the app side (HttpURLConnection, the same way the
 * app already calls Claude), and every endpoint here can be exercised with
 * curl — which is how they were tested.
 *
 * Three capabilities, in the order the owner asked for them:
 *   1. the bot pushes alerts to the phone          → GET  /api/jarvis/pull
 *   2. bot commands run from inside JARVIS         → POST /api/jarvis/command
 *   3. one memory both of them read and write      → GET/POST /api/jarvis/memory
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA = path.join(__dirname, '..', 'data');
const MEM_FILE = path.join(DATA, 'shared-memory.json');
const ALERT_FILE = path.join(DATA, 'jarvis-alerts.json');
const MAX_ALERTS = 200;
const ALERT_TTL_MS = 48 * 60 * 60 * 1000;

let _alerts = null;
let _mem = null;
let _lastSeen = 0;          // when the phone last polled

function _load(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function _save(file, val) {
  try { fs.writeFileSync(file, JSON.stringify(val, null, 2)); } catch (e) {
    logger.warn('jarvis save failed: ' + (e.message || '').substring(0, 60));
  }
}
function alerts() { if (!_alerts) _alerts = _load(ALERT_FILE, []); return _alerts; }
function memory() { if (!_mem) _mem = _load(MEM_FILE, { facts: [], updated: 0 }); return _mem; }

// ── 1. Alerts the bot wants on the phone ─────────────────────────
// Called from wherever the bot already decides something is worth the owner's
// attention. Queued rather than sent, because the phone may be asleep; it
// collects whatever accumulated the next time it polls.
function pushAlert({ title, body, kind = 'info', urgency = 'normal', link = null }) {
  const list = alerts();
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    title: String(title || '').substring(0, 120),
    body: String(body || '').substring(0, 600),
    kind, urgency, link,
    delivered: false,
  };
  list.push(item);
  // Drop what the phone will never show anyway.
  const cutoff = Date.now() - ALERT_TTL_MS;
  _alerts = list.filter(a => a.ts >= cutoff).slice(-MAX_ALERTS);
  _save(ALERT_FILE, _alerts);
  return item;
}

function pullAlerts(sinceTs = 0, markDelivered = true) {
  const list = alerts().filter(a => a.ts > sinceTs);
  if (markDelivered) {
    for (const a of list) a.delivered = true;
    _save(ALERT_FILE, _alerts);
  }
  return list;
}

// ── 3. Shared memory ─────────────────────────────────────────────
// Deliberately a flat list of short facts, not a transcript. Both sides inject
// it into their prompt, so it has to stay small enough to carry on every call.
function addFact(text, source = 'unknown') {
  const m = memory();
  const clean = String(text || '').trim().substring(0, 300);
  if (!clean) return m;
  // Same fact from both sides shouldn't be stored twice.
  const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  if (m.facts.some(f => norm(f.text) === norm(clean))) return m;
  m.facts.push({ text: clean, source, ts: Date.now() });
  if (m.facts.length > 120) m.facts = m.facts.slice(-120);
  m.updated = Date.now();
  _save(MEM_FILE, m);
  return m;
}
function removeFact(idx) {
  const m = memory();
  if (idx >= 0 && idx < m.facts.length) { m.facts.splice(idx, 1); m.updated = Date.now(); _save(MEM_FILE, m); }
  return m;
}
// What the bot injects into its own prompt.
function memoryForPrompt() {
  const m = memory();
  if (!m.facts.length) return '';
  return 'מה שידוע עליו (זיכרון משותף עם ג׳רביס בטלפון):\n' +
    m.facts.slice(-40).map(f => `• ${f.text}`).join('\n');
}

function status() {
  const m = memory();
  const pending = alerts().filter(a => !a.delivered).length;
  return {
    ok: true,
    alerts_total: alerts().length,
    alerts_pending: pending,
    facts: m.facts.length,
    memory_updated: m.updated,
    phone_last_seen: _lastSeen,
    server_time: Date.now(),
  };
}

// The buttons the app shows. Kept here, next to the bot, so renaming a
// command updates the app without shipping a new APK.
const ACTION_CATALOGUE = [
  {
    title: 'סריקות', icon: '🔍',
    items: [
      { label: 'סריקת קבוצות', cmd: 'סריקה', hint: 'מה קרה בקבוצות מאז אתמול' },
      { label: 'סקירה', cmd: 'סקירה', hint: 'סקירה מרוכזת' },
      { label: 'מוקד', cmd: 'מוקד', hint: 'מה דורש אותך עכשיו' },
      { label: 'נרטיבים', cmd: 'נרטיבים', hint: 'איך הנושא מסופר ברשת' },
    ],
  },
  {
    title: 'קלנר', icon: '🎙️',
    items: [
      { label: 'סטטוס שידורים', cmd: 'שידורים', hint: 'ניטור רדיו חי' },
      { label: 'בדוק שידורים עכשיו', cmd: 'שידורים בדוק', hint: 'דגימה מיידית' },
      { label: 'יריבים', cmd: 'יריבים', hint: 'מה הצד השני אומר' },
    ],
  },
  {
    title: 'מצב הבוט', icon: '🩺',
    items: [
      { label: 'מה חדש', cmd: 'מה חדש', hint: 'עדכוני גרסה' },
      { label: 'למה נכשל', cmd: 'למה', hint: 'הסבר על התקלה האחרונה' },
      { label: 'תקלות', cmd: 'תקלות', hint: 'היסטוריית תקלות' },
      { label: 'סטטוס', cmd: 'סטטוס', hint: 'מצב כללי' },
    ],
  },
];

// ── HTTP surface ─────────────────────────────────────────────────
function attach(app, deps = {}) {
  const secret = () => process.env.JARVIS_SECRET || '';
  function authed(req) {
    const want = secret();
    if (!want) return false;                       // unset → the bridge is closed
    const got = req.get('x-jarvis-key') || req.query.key || '';
    return got === want;
  }
  // 404 rather than 401: an unauthenticated caller learns nothing about
  // whether this endpoint exists.
  const guard = (req, res, next) => (authed(req) ? next() : res.status(404).json({ error: 'not found' }));

  app.use('/api/jarvis', (req, res, next) => { if (authed(req)) _lastSeen = Date.now(); next(); });

  app.get('/api/jarvis/hello', guard, (req, res) => {
    res.json({
      ...status(),
      capabilities: ['alerts', 'command', 'memory'],
      bot: deps.botName ? deps.botName() : 'בוטי',
    });
  });

  // 1. Alerts waiting for the phone.
  app.get('/api/jarvis/pull', guard, (req, res) => {
    const since = parseInt(req.query.since, 10) || 0;
    const list = pullAlerts(since);
    res.json({ ok: true, now: Date.now(), count: list.length, alerts: list });
  });

  // 2. Run a bot command as the owner and return what it would have replied.
  //    Reuses route() rather than reimplementing anything: JARVIS gets the
  //    whole command surface — scans, digests, reports — for free.
  app.post('/api/jarvis/command', guard, async (req, res) => {
    const text = String((req.body && req.body.text) || req.query.text || '').trim();
    if (!text) return res.status(400).json({ error: 'no text' });
    if (!deps.runCommand) return res.status(503).json({ error: 'command bridge not wired' });
    try {
      const reply = await deps.runCommand(text);
      res.json({ ok: true, text: reply });
    } catch (e) {
      logger.warn('jarvis command failed: ' + (e.message || '').substring(0, 80));
      res.status(500).json({ error: (e.message || 'failed').substring(0, 200) });
    }
  });

  // ── Faces ──────────────────────────────────────────────────────
  // The phone is where the photos already are, so making him route them
  // through WhatsApp to reach the recogniser was the long way round.
  app.post('/api/jarvis/face/reference', guard, async (req, res) => {
    const { name, image, force, chooseIndex } = req.body || {};
    if (!name || !image) return res.status(400).json({ error: 'צריך שם ותמונה' });
    try {
      const fr = require('./face-recognition');
      const buf = Buffer.from(String(image), 'base64');
      const r = await fr.addReference(String(name).trim(), buf, {
        force: !!force,
        chooseIndex: chooseIndex != null ? parseInt(chooseIndex, 10) : null,
      });
      res.json({ ok: true, result: r, total: fr.getReferenceCount(String(name).trim()) });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 200) });
    }
  });

  app.post('/api/jarvis/face/identify', guard, async (req, res) => {
    const { image } = req.body || {};
    if (!image) return res.status(400).json({ error: 'צריך תמונה' });
    try {
      const fr = require('./face-recognition');
      const buf = Buffer.from(String(image), 'base64');
      const matches = await fr.findMatches(buf);
      // The array carries extra properties (detections, frameBuffer) that must
      // not be serialised — frameBuffer alone is the whole image again.
      res.json({
        ok: true,
        faces: (matches.detections || []).length,
        matches: Array.from(matches).map(m => ({
          name: m.name,
          confidence: m.confidence != null ? Math.round(m.confidence * 100) / 100 : null,
          distance: m.distance != null ? Math.round(m.distance * 1000) / 1000 : null,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 200) });
    }
  });

  // Numbered overlay, so the app can show which face is which before he
  // picks one to attach a name to.
  app.post('/api/jarvis/face/number', guard, async (req, res) => {
    const { image } = req.body || {};
    if (!image) return res.status(400).json({ error: 'צריך תמונה' });
    try {
      const fr = require('./face-recognition');
      const out = await fr.numberFaces(Buffer.from(String(image), 'base64'));
      if (!out || !out.buffer) return res.json({ ok: true, faces: 0, image: null });
      res.json({ ok: true, faces: out.count != null ? out.count : 0, image: out.buffer.toString('base64') });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 200) });
    }
  });

  app.get('/api/jarvis/face/people', guard, (_req, res) => {
    try {
      const fr = require('./face-recognition');
      const st = fr.getStatus ? fr.getStatus() : {};
      res.json({ ok: true, status: st });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 120) });
    }
  });

  // ── The command catalogue ──────────────────────────────────────
  // Sent to the app so its buttons come from the bot rather than from a list
  // hardcoded in the app that drifts the moment a command is renamed.
  app.get('/api/jarvis/actions', guard, (_req, res) => {
    res.json({ ok: true, groups: ACTION_CATALOGUE });
  });

  // 3. Shared memory, both directions.
  app.get('/api/jarvis/memory', guard, (_req, res) => res.json({ ok: true, ...memory() }));
  app.post('/api/jarvis/memory', guard, (req, res) => {
    const body = req.body || {};
    if (Array.isArray(body.facts)) for (const f of body.facts) addFact(f, 'jarvis');
    else if (body.text) addFact(body.text, body.source || 'jarvis');
    else return res.status(400).json({ error: 'nothing to store' });
    res.json({ ok: true, ...memory() });
  });

  logger.info(`🤝 JARVIS bridge ${secret() ? 'ready' : 'DISABLED (no JARVIS_SECRET)'}`);
}

module.exports = { attach, pushAlert, pullAlerts, addFact, removeFact, memory, memoryForPrompt, status };
