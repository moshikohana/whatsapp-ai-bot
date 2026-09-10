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
function pushAlert({ title, body, summary = '', kind = 'info', urgency = 'normal', link = null, supersedes = null }) {
  let list = alerts();

  // A digest is a snapshot of "what needs you right now", not an event that
  // happened. Nine of them queued overnight would buzz the phone nine times
  // to say eight things, eight of those descriptions already stale. When a
  // new one arrives, undelivered older ones of the same kind are dropped —
  // the phone gets the current picture, once.
  if (supersedes) {
    const before = list.length;
    list = list.filter(a => a.delivered || a.kind !== supersedes);
    if (list.length !== before) {
      logger.info(`🔕 JARVIS: superseded ${before - list.length} undelivered "${supersedes}" alert(s)`);
    }
  }

  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    title: String(title || '').substring(0, 120),
    // Room for the surrounding messages; 600 cut the context off mid-quote.
    body: String(body || '').substring(0, 1800),
    // The one-line form for the notification shade. The full body, with
    // its surrounding messages, stays for the app to render.
    summary: String(summary || '').substring(0, 200),
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

/**
 * מראה: כל התראה שהבוט שולח בוואטסאפ מגיעה גם לאפליקציה.
 *
 * הצ׳אט הפרטי בוואטסאפ לא מצפצף אצלו, ולכן ההתראות שנשלחו לשם היו בפועל
 * בלתי־נראות. אותו תוכן נשלח לכאן במקביל — בלי לשנות דבר בצד של וואטסאפ.
 *
 * כל התראה נושאת מאיפה, ממי, ומתי *ההודעה נשלחה* (לא מתי הבוט הבחין בה),
 * ואת ההודעות שמסביב — כי "מישהו כתב משהו על קלנר" בלי מה שנאמר לפני ואחרי
 * הוא בדיוק סוג ההתראה שגורמת לפתוח את וואטסאפ ולחפש ידנית.
 */
function mirrorAlert({ title, body, summary = '', kind = 'info', urgency = 'normal', group, sender, msgTs, context, link }) {
  const parts = [];
  if (group) parts.push(`📍 ${group}`);
  if (sender) parts.push(`👤 ${sender}`);
  if (msgTs) {
    try {
      parts.push(`🕐 ${new Date(msgTs).toLocaleString('he-IL', {
        timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit',
      })}`);
    } catch {}
  }
  let full = String(body || '');
  if (parts.length) full = `${parts.join('  ·  ')}\n\n${full}`;
  if (context && context.length) {
    full += `\n\n— מה נאמר סביב —\n` + context.map(c => {
      const t = c.ts ? new Date(c.ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }) : '';
      return `${t} ${c.from || ''}: ${String(c.text || '').substring(0, 140)}`.trim();
    }).join('\n');
  }
  // Falls back to group + the first line of the body — enough to know
  // whether it is worth opening, which is all a notification must do.
  const short = summary
    || [group, String(body || '').split(/\n/).find(Boolean)].filter(Boolean).join(' · ');
  return pushAlert({ title, body: full, summary: short, kind, urgency, link: link || null });
}

/**
 * ההודעות שמסביב להודעה שהפעילה התראה.
 * קריאה בלבד — fetchMessages לא מסמן כנקרא ולא נוגע במצב הצ׳אט שלו.
 */
async function fetchContext(chat, msgId, span = 3) {
  try {
    const msgs = await chat.fetchMessages({ limit: 25 });
    const idx = msgs.findIndex(m => (m.id && m.id._serialized) === msgId);
    const slice = idx >= 0
      ? msgs.slice(Math.max(0, idx - span), idx + span + 1)
      : msgs.slice(-span * 2);
    return slice
      .filter(m => m.body && m.body.trim())
      .map(m => ({
        ts: (m.timestamp || 0) * 1000,
        from: m._data?.notifyName || (m.fromMe ? 'אתה' : ''),
        text: m.body,
      }));
  } catch {
    return [];
  }
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
      // Fully specified in one line on purpose. /command is stateless, so a
      // scan that answers with "which groups?" and then "how far back?" can
      // never be completed from the app — there is nobody to reply.
      { label: 'סריקת 11 הקבוצות', cmd: 'סרוק את 11 הקבוצות הפוליטיות 24 שעות אחרונות', hint: '24 שעות אחרונות' },
      { label: 'סריקה — 6 שעות', cmd: 'סרוק את 11 הקבוצות הפוליטיות 6 שעות אחרונות', hint: 'חלון קצר' },
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

// Today's keyword hits as structured records, newest first.
function _todayHits(limit = 120) {
  try {
    const log = JSON.parse(fs.readFileSync(path.join(DATA, 'keyword-alerts-log.json'), 'utf8'));
    const today = new Date().toLocaleDateString('he-IL');
    return (log.entries || [])
      .filter(e => e.date === today)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit)
      .map(e => ({
        keyword: e.keyword || '',
        group: e.group || '',
        sender: e.sender || '',
        preview: e.preview || '',
        time: e.time || '',
        date: e.date || '',
        ts: e.timestamp || 0,
      }));
  } catch { return []; }
}

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

  // Every call from the phone is logged, authenticated or not. Without this
  // there was no way to answer "is the app even reaching the bot?" — the
  // first thing asked when the buttons appeared to do nothing.
  app.use('/api/jarvis', (req, res, next) => {
    const ok = authed(req);
    if (ok) _lastSeen = Date.now();
    const started = Date.now();
    res.on('finish', () => {
      // The source tag separates a background poll from the app being opened.
      // Without it, "the phone is polling" and "he happened to open the app"
      // looked identical in this log, and the difference is the whole question.
      const src = req.query && req.query.src ? ` [${String(req.query.src).substring(0, 12)}]` : '';
      logger.info(`📱 JARVIS ${req.method} ${req.path}${src} → ${res.statusCode} ` +
        `(${Date.now() - started}ms${ok ? '' : ', BAD KEY'})`);
      // What he did in the app, for the activity tab. Background polling is
      // filtered out inside, so this only keeps actions he actually took.
      if (ok) {
        try { require('./activity-log').recordApp(req.method, req.path, req.body, res.statusCode); } catch (_) {}
      }
    });
    next();
  });

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

  // ── הסריקה האחרונה ─────────────────────────────────────────────
  // Kept here rather than read from scan-history, because the path that
  // actually answers a scan request through the API never writes there —
  // history stayed empty while real scans were being produced. Storing the
  // result as it passes through is the only place that sees all of them.
  app.get('/api/jarvis/scan/last', guard, (_req, res) => {
    let last = null;
    try { last = JSON.parse(fs.readFileSync(path.join(DATA, 'jarvis-last-scan.json'), 'utf8')); } catch {}
    res.json({ ok: true, scan: last });
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
      // A scan is expensive and worth keeping. Menu replies ("אילו קבוצות
      // לסרוק?") are explicitly not stored — a stored prompt would show up
      // later as "your last scan" and be worse than nothing.
      if (/סרוק|סריקה|סקירה/.test(text) && reply && reply.length > 400 && !/^אילו|כמה זמן אחורה/.test(reply.trim())) {
        try {
          // The window is recorded separately from the run time. "Scanned 20
          // minutes ago" and "covers the last 24 hours" are different facts,
          // and without the second one there is no way to tell how old the
          // news inside actually is.
          const wm = text.match(/(\d+)\s*שעות/);
          fs.writeFileSync(path.join(DATA, 'jarvis-last-scan.json'), JSON.stringify({
            ts: Date.now(),
            request: text,
            windowHours: wm ? parseInt(wm[1], 10) : null,
            coversFrom: wm ? Date.now() - parseInt(wm[1], 10) * 3600 * 1000 : null,
            text: reply,
          }, null, 2));
        } catch {}
      }
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
    const { name, image, force, chooseIndex, album } = req.body || {};
    if (!name || !image) return res.status(400).json({ error: 'צריך שם ותמונה' });
    try {
      const fr = require('./face-recognition');
      const buf = Buffer.from(String(image), 'base64');
      const r = await fr.addReference(String(name).trim(), buf, {
        force: !!force,
        chooseIndex: chooseIndex != null ? parseInt(chooseIndex, 10) : null,
      });
      // "✅ זו שי" on a checked photo is also "keep this one" — the album.
      if (album && r && r.success) {
        require('./album').add({ name: String(name).trim(), buffer: buf, group: String(req.body.group || ''), source: 'confirm' }).catch(() => {});
      }
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
    const { image, group } = req.body || {};
    if (!image) return res.status(400).json({ error: 'צריך תמונה' });
    try {
      const fr = require('./face-recognition');
      // The photo's group, when the app knows it: only the people allowed
      // there are offered as names.
      const out = await fr.numberFaces(Buffer.from(String(image), 'base64'), null, fr.allowedNames(String(group || '')));
      if (!out || !out.buffer) return res.json({ ok: true, faces: 0, image: null, details: [] });
      res.json({
        ok: true,
        // `faces` stays a count: an app already in his pocket reads it that
        // way, and changing its type would break that build.
        faces: out.count != null ? out.count : 0,
        image: out.buffer.toString('base64'),
        // Per-face labels, so the app can offer the same two corrections
        // WhatsApp offers — name a face, or delete the reference that
        // mislabelled it.
        details: (out.faces || []).map(f => ({
          n: f.n, matchedName: f.matchedName, nearest: f.nearest,
          confidence: f.confidence, isMatch: !!f.isMatch,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 200) });
    }
  });

  /**
   * מוחק את הייחוס שגרם לזיהוי שגוי — המקבילה של "2 לא זוהה" בוואטסאפ.
   *
   * אותה פונקציה בדיוק שמשרתת את וואטסאפ, כדי ששתי הדרכים יתנהגו זהה ולא
   * ייווצר הבדל שקט בין מה שקורה בטלפון לבין מה שקורה בצ׳אט.
   */
  app.post('/api/jarvis/face/unteach', guard, async (req, res) => {
    const { name, image, faceIndex } = req.body || {};
    if (!name || !image) return res.status(400).json({ error: 'צריך שם ותמונה' });
    try {
      const fr = require('./face-recognition');
      const r = await fr.removeReferenceNear(
        String(name).trim(),
        Buffer.from(String(image), 'base64'),
        parseInt(faceIndex, 10) || 0
      );
      res.json({ ok: !!r.success, result: r, separation: fr.separation() });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 200) });
    }
  });

  /**
   * מוחק תמונת זיהוי מהארכיון.
   *
   * לא נוגע בווקטורים: זיהוי הוא רשומה של מה שקרה, לא חלק ממה שהמזהה בנוי
   * עליו. מחיקה כאן מנקה את הגלריה ולא משנה את איכות הזיהוי.
   */
  app.post('/api/jarvis/face/photo/delete', guard, (req, res) => {
    const { name, ts } = req.body || {};
    if (!name || !ts) return res.status(400).json({ error: 'צריך שם וזמן' });
    try {
      const r = require('./face-archive').removePhoto(String(name).trim(), ts);
      res.json({ ok: !!r.success, result: r });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 200) });
    }
  });

  /**
   * מוחק אדם לגמרי — ווקטורים, ייחוסים, וכל התמונות.
   *
   * דורש confirm מפורש בגוף הבקשה. זו הפעולה היחידה כאן שאי אפשר לבטל,
   * ולחיצה אחת שגויה על טלפון מוחקת 17 ייחוסים שנאספו לאורך שבועות.
   */
  app.post('/api/jarvis/face/person/delete', guard, (req, res) => {
    const { name, confirm } = req.body || {};
    if (!name) return res.status(400).json({ error: 'צריך שם' });
    if (confirm !== true) return res.status(400).json({ error: 'חסר אישור מפורש' });
    try {
      const fr = require('./face-recognition');
      const before = fr.getReferenceCount(String(name).trim());
      fr.clearReferences(String(name).trim());
      const a = require('./face-archive').removePerson(String(name).trim());
      logger.info(`🗑️ Person deleted from app: "${name}" — ${before} refs, ${a.removed || 0} photos`);
      res.json({ ok: true, removedRefs: before, removedPhotos: a.removed || 0, separation: fr.separation() });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 200) });
    }
  });

  /** מוחק תמונת ייחוס ספציפית לפי הזמן שלה — לעריכה ישירה מהטאב. */
  app.post('/api/jarvis/face/reference/delete', guard, async (req, res) => {
    const { name, ts } = req.body || {};
    if (!name || !ts) return res.status(400).json({ error: 'צריך שם וזמן' });
    try {
      const fr = require('./face-recognition');
      const arch = require('./face-archive');
      const list = arch.references(String(name).trim(), false);
      // Ordered oldest-first, because that is the order the descriptors were
      // appended in — the display order is newest-first and would delete the
      // opposite photo.
      const byAge = [...list].sort((a, b) => a.ts - b.ts);
      const idx = byAge.findIndex(p => String(p.ts) === String(ts));
      if (idx < 0) return res.status(404).json({ error: 'לא נמצאה תמונת ייחוס כזו' });

      const cfg = fr.getStatus();
      const entry = (cfg.references || []).find(r => r.name === String(name).trim());
      if (entry && entry.count <= 1) {
        return res.status(400).json({ error: `ל-${name} יש ייחוס אחד בלבד — מחיקה תבטל את הזיהוי לגמרי.` });
      }
      const r = fr.removeReferenceIndex
        ? fr.removeReferenceIndex(String(name).trim(), idx)
        : { success: false, error: 'לא נתמך' };
      res.json({ ok: !!r.success, result: r, separation: fr.separation() });
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

  // ── מעקב תמונות: מי במעקב, ומה נשלח עליו לאחרונה ───────────────
  app.get('/api/jarvis/faces/tracked', guard, (_req, res) => {
    try {
      const arch = require('./face-archive');
      const fr = require('./face-recognition');
      const st = fr.getStatus ? fr.getStatus() : {};

      // Merged from both sides on purpose. The archive only knows people it has
      // detected, so someone with references but no sighting yet was missing
      // from the tab entirely — which reads as "not tracked" when the truth is
      // "tracked, never seen". Two different counts, kept apart:
      //   refs      — descriptors the recogniser matches against
      //   refPhotos — how many of those we can actually show a picture for
      const byName = new Map();
      for (const p of arch.people()) byName.set(p.name, { ...p });
      for (const r of (st.references || [])) {
        const cur = byName.get(r.name) || {
          key: r.name, name: r.name, count: 0, candidates: 0, lastSeen: null, lastGroup: null,
        };
        cur.refs = r.count;
        byName.set(r.name, cur);
      }
      const people = [...byName.values()].map(p => ({
        ...p,
        refs: p.refs || 0,
        refPhotos: arch.referenceCount(p.name),
      })).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

      res.json({
        ok: true,
        people,
        totalPhotos: arch.totalCount(),
        groups: st.monitoredGroups || [],
        enabled: st.enabled !== false,
      });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // ── פריסטים של סריקה ─────────────────────────────────────────
  /**
   * הרשימה האמיתית של הפריסטים השמורים.
   *
   * האפליקציה שלחה עד עכשיו מחרוזת קשיחה — "סרוק את 11 הקבוצות הפוליטיות" —
   * שלא נגעה באף אחד מתשעת הפריסטים שהוא בנה, ולא כללה טלגרם בכלל. בוואטסאפ
   * הוא בוחר פריסט ומקבל 54 מקורות; באפליקציה קיבל 11 קבוצות שמישהו קידד
   * לתוך כפתור. זה הפער שהוא תיאר כ"בוואטסאפ מצוין, בבוט פחות".
   */
  app.get('/api/jarvis/scan/presets', guard, (_req, res) => {
    try {
      const p = require('./scan-presets');
      const list = p.list().map(x => ({
        id: x.id,
        name: x.name,
        total: (x.sources || []).length,
        wa: (x.sources || []).filter(s => s.source === 'wa').length,
        tg: (x.sources || []).filter(s => s.source === 'tg').length,
        groups: (x.sources || []).filter(s => s.type === 'group').length,
        channels: (x.sources || []).filter(s => s.type === 'channel').length,
        createdAt: x.createdAt || null,
      })).filter(x => x.total > 0);
      res.json({ ok: true, presets: list });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  /** מריץ סריקה על פריסט שמור — בדיוק אותו מסלול שהאשף בוואטסאפ מפעיל. */
  app.post('/api/jarvis/scan/preset', guard, async (req, res) => {
    const { id, hours } = req.body || {};
    if (!id) return res.status(400).json({ error: 'צריך מזהה פריסט' });
    if (!deps.runScanPreset) return res.status(503).json({ error: 'גשר הסריקה לא מחובר' });
    try {
      const h = Math.min(Math.max(parseInt(hours, 10) || 24, 1), 168);
      const out = await deps.runScanPreset(String(id), h);
      res.json({ ok: true, text: out || 'בוצע.' });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 200) });
    }
  });

  // ── יומן פעילות — אפליקציה + וואטסאפ, לציר זמן אחד ─────────────
  app.get('/api/jarvis/activity', guard, (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 3, 1), 14);
      res.json({ ok: true, ...require('./activity-log').timeline(days, 250) });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // ── חדר מלחמה — מצב החירום, מה מפעיל אותו, והסקירה האחרונה ──────
  app.get('/api/jarvis/warroom', guard, (req, res) => {
    try {
      const cm = require('./crisis-mode');
      const active = cm.getActiveCrisis();
      let recent = [];
      try {
        const cutoff = Date.now() - (cm.WINDOW_MINUTES || 30) * 60000;
        recent = JSON.parse(fs.readFileSync(path.join(DATA, 'crisis-recent-alerts.json'), 'utf8'))
          .filter(a => a && a.ts >= cutoff)
          .map(a => ({ ts: a.ts, keyword: a.keyword, group: a.group, preview: String(a.preview || '').substring(0, 220) }));
      } catch (_) {}
      let last = null;
      try { last = JSON.parse(fs.readFileSync(path.join(DATA, 'warroom-last.json'), 'utf8')); } catch (_) {}
      res.json({
        ok: true,
        active: active ? {
          since: active.startedAt, count: active.triggerCount,
          keywords: active.triggerKeywords || [], groups: active.triggerGroups || [],
          spanMinutes: active.spanMinutes,
        } : null,
        trigger: { count: cm.TRIGGER_COUNT, windowMinutes: cm.WINDOW_MINUTES },
        keywords: cm.loadCriticalKeywords(),
        recent,
        last,
      });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });
  app.post('/api/jarvis/warroom/end', guard, (req, res) => {
    try {
      const cm = require('./crisis-mode');
      const was = cm.isCrisisActive();
      cm.endCrisis();
      res.json({ ok: true, text: was ? 'מצב החירום הסתיים. חוזרים להתראות רגילות.' : 'לא היה מצב חירום פעיל.' });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // ── 🎞️ אלבום — לפי אדם וחודש ─────────────────────────────────
  app.get('/api/jarvis/album', guard, (req, res) => {
    try { res.json({ ok: true, people: require('./album').summary() }); }
    catch (e) { res.status(500).json({ error: (e.message || 'failed').substring(0, 150) }); }
  });
  app.get('/api/jarvis/album/month', guard, (req, res) => {
    const name = String(req.query.name || ''), month = String(req.query.month || '');
    if (!name || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'צריך שם וחודש' });
    try { res.json({ ok: true, photos: require('./album').month(name, month) }); }
    catch (e) { res.status(500).json({ error: (e.message || 'failed').substring(0, 150) }); }
  });
  app.get('/api/jarvis/album/photo', guard, (req, res) => {
    const img = require('./album').photo(String(req.query.name || ''), parseInt(req.query.ts, 10));
    if (!img) return res.status(404).json({ error: 'התמונה לא נמצאה' });
    res.json({ ok: true, image: img });
  });
  app.post('/api/jarvis/album/remove', guard, (req, res) => {
    const { name, ts } = req.body || {};
    const ok = require('./album').remove(String(name || ''), parseInt(ts, 10));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'התמונה לא נמצאה' });
  });

  // ── מד היתרון — כמה הקדמנו את הקבוצות ──────────────────────────
  app.get('/api/jarvis/lead-radar', guard, (req, res) => {
    try {
      const lr = require('./lead-radar');
      res.json({ ok: true, week: lr.stats(7), today: lr.stats(1) });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // ── "מה חדש" — לכרטיס בדף הבית של האפליקציה ─────────────────────
  app.get('/api/jarvis/changelog', guard, (req, res) => {
    try {
      const n = Math.min(Math.max(parseInt(req.query.n, 10) || 2, 1), 6);
      res.json({ ok: true, versions: require('./changelog').loadChangelog().slice(0, n) });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // ── השיחה בוואטסאפ, לטאב השיחה באפליקציה ────────────────────────
  app.get('/api/jarvis/wa-thread', guard, (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 80);
      res.json({ ok: true, messages: require('./activity-log').waThread(limit, 2) });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // ── דיווחי שגיאה מהאפליקציה ──────────────────────────────────
  // הטלפון מדווח בעצמו במקום שהוא יתאר לי מה קרה מהזיכרון.
  app.post('/api/jarvis/report', guard, async (req, res) => {
    try {
      const rep = require('./app-reports');
      const item = rep.record(req.body || {});
      // Relayed immediately when the desktop agent is up; otherwise it waits
      // in the queue and goes out on the next sweep. Never blocks the phone.
      rep.relay(item).catch(() => {});
      res.json({ ok: true, id: item && item.id });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  app.get('/api/jarvis/reports', guard, (_req, res) => {
    try {
      const rep = require('./app-reports');
      res.json({ ok: true, reports: rep.recent(30), stats: rep.stats() });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // ── שידורים: מה נאמר, מתי, ובאיזו תכנית ──────────────────────
  app.get('/api/jarvis/broadcast', guard, (req, res) => {
    try {
      const bd = require('./broadcast-digest');
      const bm = require('./broadcast-monitor');
      const limit = Math.min(parseInt(req.query.limit, 10) || 12, 48);
      const c = bm.loadConfig();
      res.json({
        ok: true,
        enabled: !!c.enabled,
        stations: (c.stations || []),
        terms: (c.terms || []),
        activeFrom: c.activeFrom, activeTo: c.activeTo,
        digests: bd.recentDigests(limit),
        // The live tail, minus adverts. Most of what "נקלט עכשיו" showed was
        // promotions — phone numbers and sales — which is noise to him.
        live: (() => {
          const hl = require('./broadcast-headlines');
          return bd.recentChunks(40).filter(c => !hl.isAd(c.text)).slice(0, 20);
        })(),
        // The headlines, which are what the monitor is actually for.
        headlines: require('./broadcast-headlines').recent(20),
      });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  /**
   * הוספה והסרה של מילות מעקב בשידורים.
   *
   * עד עכשיו זה היה אפשרי רק דרך פקודת וואטסאפ ("שידורים מילה X"), כלומר
   * הרשימה הוצגה באפליקציה אבל לא ניתן היה לגעת בה משם.
   */
  app.post('/api/jarvis/broadcast/terms', guard, (req, res) => {
    const { action, term } = req.body || {};
    const t = String(term || '').trim();
    if (!t || t.length < 2) return res.status(400).json({ error: 'מילה קצרה מדי' });
    try {
      const bm = require('./broadcast-monitor');
      const terms = action === 'remove' ? bm.removeTerm(t) : bm.addTerm(t);
      res.json({ ok: true, terms });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  /**
   * התמלול סביב רגע — "פתח הקשר" על כותרת או ציטוט.
   *
   * התמלול נשמר ממילא; עד עכשיו לא הייתה דרך להגיע אליו מתוך ידיעה. כותרת היא
   * שורה אחת, ולפעמים צריך את חצי הדקה שלפניה כדי להבין אם זו התקפה, ציטוט
   * של מישהו אחר או תשובה לשאלה.
   */
  app.get('/api/jarvis/broadcast/context', guard, (req, res) => {
    const ts = parseInt(req.query.ts, 10);
    if (!ts) return res.status(400).json({ error: 'צריך זמן' });
    try {
      const hl = require('./broadcast-headlines');
      const station = req.query.station ? String(req.query.station) : null;
      const minutes = Math.min(Math.max(parseInt(req.query.minutes, 10) || 12, 4), 40);
      const chunks = hl.contextAround(ts, station, minutes);
      res.json({ ok: true, chunks });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // "הרחב" על כותרת — מי אמר מה, מתוך התמלול סביבה.
  app.post('/api/jarvis/broadcast/expand', guard, async (req, res) => {
    const id = String((req.body || {}).id || '');
    if (!id) return res.status(400).json({ error: 'צריך כותרת' });
    try {
      const expansion = await require('./broadcast-headlines').expand(id);
      res.json({ ok: true, expansion });
    } catch (e) {
      const msg = {
        NOT_FOUND: 'הכותרת כבר לא שמורה',
        NO_TRANSCRIPT: 'אין מספיק תמלול סביב הרגע הזה',
        ANALYSIS_FAILED: 'הניתוח לא הצליח — נסה שוב',
      }[e.code] || (e.message || 'failed').substring(0, 150);
      res.status(e.code === 'NOT_FOUND' ? 404 : 500).json({ error: msg });
    }
  });

  // מריץ ניתוח על טווח שהאפליקציה מבקשת — בלי לחכות לשעה העגולה.
  app.post('/api/jarvis/broadcast/analyse', guard, async (req, res) => {
    try {
      const hours = Math.min(Math.max(parseInt((req.body || {}).hours, 10) || 1, 1), 6);
      const bd = require('./broadcast-digest');
      const to = Date.now();
      const d = await bd.analyseHour({ fromTs: to - hours * 3600 * 1000, toTs: to });
      res.json({
        ok: true,
        digest: d,
        message: d ? null : 'אין מספיק תמלול בטווח הזה עדיין',
      });
    } catch (e) {
      // The two failures look identical from the phone but mean opposite
      // things: one is "wait", the other is "something broke". Saying "not
      // enough transcript" for a model failure hid a real bug for a day.
      if (e && e.code === 'ANALYSIS_FAILED') {
        return res.json({ ok: false, digest: null, message: 'הניתוח נכשל — התמלול קיים אבל המודל לא החזיר תשובה תקינה. נסה שוב.' });
      }
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // ── תור הספקות ───────────────────────────────────────────────
  // מה שהבוט לא ידע להכריע, כשאלות עם כפתורים.
  app.get('/api/jarvis/decisions', guard, (_req, res) => {
    try {
      const dec = require('./decisions');
      const fr = require('./face-recognition');
      res.json({
        ok: true,
        decisions: dec.open(),
        stats: dec.stats(),
        // The confidence meter: how well each pair can actually be told apart.
        // Shown next to the questions because answering them is what moves it.
        separation: fr.separation ? fr.separation() : [],
      });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  /**
   * תשובה על ספק — וכאן זה גם באמת משנה משהו.
   *
   * ההבדל בין הפיצ׳ר הזה לסקר דעת קהל הוא השורה שמפעילה את התוצאה: תשובה על
   * פרצוף נכנסת מיד לסט הייחוסים, ולכן ההכרעה הבאה כבר תהיה אחרת.
   */
  app.post('/api/jarvis/decisions/answer', guard, async (req, res) => {
    const { id, value } = req.body || {};
    if (!id || value === undefined) return res.status(400).json({ error: 'צריך id ו-value' });
    try {
      const dec = require('./decisions');
      const item = dec.open(200, false).find(d => d.id === id);
      if (!item) return res.status(404).json({ error: 'השאלה כבר נענתה או לא קיימת' });

      let outcome = 'נרשם';
      if (item.kind === 'face' && value !== '__none__' && value !== '__skip__') {
        // The image was stored with the question, so the answer can be turned
        // into a reference without asking him to find the photo again.
        const p = path.join(DATA, 'decision-images', `${id}.jpg`);
        if (fs.existsSync(p)) {
          const buf = fs.readFileSync(p);
          const fr = require('./face-recognition');
          // force: he just looked at the photo and named the child. The
          // cross-person guard exists to catch a mislabel made blind, and
          // here it would reject exactly the correction that fixes the
          // overlap it is complaining about.
          // The face the question was about. Without this the reference was
          // taken from whichever face the detector ranked first — in a class
          // photo, quite possibly a different child, now filed under her name.
          let chooseIndex = null;
          const want = item.context && item.context.face;
          if (want) {
            try {
              const dets = await fr.detectFaces(buf);
              let best = Infinity;
              for (let i = 0; i < dets.length; i++) {
                const g = await fr.faceGeometry(buf, dets[i]);
                const d = Math.hypot((g.x + g.w / 2) / g.width - want.cx, (g.y + g.h / 2) / g.height - want.cy);
                if (d < best) { best = d; chooseIndex = i; }
              }
              if (best > 0.08) chooseIndex = null;   // not the same face — fall back
            } catch (_) { chooseIndex = null; }
          }
          const r = await fr.addReference(value, buf, { force: true, chooseIndex });
          outcome = r && r.success
            ? `נוסף לייחוס של ${value} — עכשיו ${r.totalReferences} תמונות`
            : `לא נוסף: ${(r && r.error) || 'שגיאה'}`;
        } else {
          outcome = 'התמונה כבר לא זמינה — נרשם בלבד';
        }
      }

      const saved = dec.answer(id, value, outcome);
      const fr2 = require('./face-recognition');
      res.json({
        ok: true, outcome, decision: saved,
        stats: dec.stats(),
        separation: fr2.separation ? fr2.separation() : [],
      });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // יומן הבדיקות — כל תמונה שהבוט הסתכל עליה, כולל כשלא מצא כלום.
  app.get('/api/jarvis/faces/checks', guard, (req, res) => {
    try {
      const arch = require('./face-archive');
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 80);
      res.json({ ok: true, checks: arch.checks(limit), stats: arch.checkStats() });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // תמונה שנבדקה — בגודל מלא, לצופה ולמספור.
  app.get('/api/jarvis/faces/check/full', guard, (req, res) => {
    const ts = parseInt(req.query.ts, 10);
    if (!ts) return res.status(400).json({ error: 'צריך זמן' });
    const r = require('./face-archive').checkFull(ts);
    if (!r) return res.status(404).json({ error: 'התמונה כבר לא שמורה' });
    res.json({ ok: true, ...r });
  });

  // תמונות הייחוס עצמן — מה שהמזהה בנוי עליו.
  app.get('/api/jarvis/faces/references', guard, (req, res) => {
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: 'צריך שם' });
    try {
      const arch = require('./face-archive');
      const fr = require('./face-recognition');
      const st = fr.getStatus ? fr.getStatus() : {};
      const entry = (st.references || []).find(r => r.name === name);
      const saved = arch.references(name, true);
      res.json({
        ok: true, name,
        // The gap between the two is the honest part: references added before
        // images were kept exist as vectors with no picture to show.
        descriptors: entry ? entry.count : 0,
        withoutImage: Math.max(0, (entry ? entry.count : 0) - saved.length),
        references: saved,
      });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  app.get('/api/jarvis/faces/photos', guard, (req, res) => {
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: 'צריך שם' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 12, 30);
    try {
      res.json({ ok: true, name, photos: require('./face-archive').photos(name, limit, true) });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // ── מילות מפתח ─────────────────────────────────────────────────
  app.get('/api/jarvis/keywords', guard, (_req, res) => {
    try {
      const ka = require('./keyword-alerts');
      const st = ka.getStatus();
      res.json({
        ok: true,
        enabled: st.enabled !== false,
        keywords: st.keywords || [],
        // Read from the log file rather than getTodayAlerts(), which returns
        // a formatted Hebrew string for WhatsApp — mapping over it yielded
        // 1,910 single characters instead of hits. The app needs structure:
        // the clock time for "when did this happen" and the epoch for "how
        // long ago", without reparsing a localised string.
        today: _todayHits(),
        stats: ka.getStats ? ka.getStats() : null,
      });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  app.post('/api/jarvis/keywords', guard, (req, res) => {
    const { add, remove, enabled } = req.body || {};
    try {
      const ka = require('./keyword-alerts');
      if (add) ka.addKeyword(String(add).trim());
      if (remove) ka.removeKeyword(String(remove).trim());
      if (enabled != null) ka.setEnabled(!!enabled);
      const st = ka.getStatus();
      res.json({ ok: true, enabled: st.enabled !== false, keywords: st.keywords || [] });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // ── קבוצות ─────────────────────────────────────────────────────
  app.get('/api/jarvis/groups', guard, (_req, res) => {
    try {
      const fr = require('./face-recognition');
      const st = fr.getStatus ? fr.getStatus() : {};
      // The scan list is not the file's top level — it lives inside the
      // group_summary task's params, which is why reading daily.json
      // directly came back empty.
      let scanList = [];
      try {
        const daily = JSON.parse(fs.readFileSync(path.join(DATA, 'daily.json'), 'utf8'));
        const gs = (Array.isArray(daily) ? daily : []).find(t => t.action === 'group_summary');
        scanList = (gs && gs.params && gs.params.groups) || [];
      } catch {}
      res.json({
        ok: true,
        scanList,
        photoMonitored: st.monitoredGroups || [],
      });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // The live chat list, which is what a scan actually picks from — the
  // configured daily list is empty on this server, so showing it would have
  // meant an empty tab on a bot that scans a dozen groups every morning.
  app.get('/api/jarvis/groups/live', guard, async (_req, res) => {
    if (!deps.listGroups) return res.status(503).json({ error: 'not wired' });
    try {
      res.json({ ok: true, groups: await deps.listGroups() });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 150) });
    }
  });

  // ── שיחה ───────────────────────────────────────────────────────
  // Separate from /command because a conversation needs the previous turns.
  // /command is stateless on purpose — a button press should not inherit
  // whatever was said before it.
  const _chats = new Map();     // deviceId → [{role, content}]
  app.post('/api/jarvis/chat', guard, async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    const device = String((req.body && req.body.device) || 'phone').substring(0, 40);
    if (!text) return res.status(400).json({ error: 'no text' });
    if (!deps.chat) return res.status(503).json({ error: 'chat not wired' });
    try {
      // One conversation. The app had its own path: its own memory, kept in
      // RAM and lost on every restart, straight to the model — so "מוקד"
      // typed in the app and in WhatsApp could get two different answers,
      // and a question asked here was unknown there. Now it goes through the
      // same router as a WhatsApp message, with the same saved history.
      if (deps.runCommand) {
        const reply = await deps.runCommand(text);
        return res.json({ ok: true, text: reply });
      }
      const history = _chats.get(device) || [];
      const reply = await deps.chat(text, history);
      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: reply });
      while (history.length > 12) history.shift();
      _chats.set(device, history);
      res.json({ ok: true, text: reply });
    } catch (e) {
      res.status(500).json({ error: (e.message || 'failed').substring(0, 200) });
    }
  });
  app.post('/api/jarvis/chat/reset', guard, (req, res) => {
    _chats.delete(String((req.body && req.body.device) || 'phone'));
    res.json({ ok: true });
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

module.exports = { attach, pushAlert, mirrorAlert, fetchContext, pullAlerts, addFact, removeFact, memory, memoryForPrompt, status };
