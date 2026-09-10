'use strict';
/**
 * שגיאות מהאפליקציה — ישר לשיחת הפיתוח.
 *
 * עד עכשיו הדיווח על תקלה עבר דרכו: הוא ראה TIMEOUT, כתב לי, ואני שחזרתי
 * מהלוגים מה קרה. שתי פעמים באותו יום זו הייתה בדיוק אותה טעות שלי —
 * נתיב איטי חדש שלא נוסף לרשימת הזמן הארוך — ובשתיהן איבדנו סבב שלם
 * על שחזור מידע שהטלפון ידע ברגע שזה קרה.
 *
 * כאן הטלפון מדווח בעצמו, דרך אותו גשר של פקודת "קלוד".
 *
 * ⚠️ מה שלא נשלח, בכוונה: תוכן הודעות, שמות קבוצות, תמונות, שמות אנשים.
 * דיווח תקלה הוא עובדות טכניות — נתיב, קוד סטטוס, סוג חריגה, מסך. אם צריך
 * את התוכן כדי להבין תקלה, הוא יבקש אותו ממנו במפורש.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA, 'app-reports.json');

const MAX_KEPT = 200;
// One relay per signature per hour. A phone with no signal can produce the
// same timeout forty times in a minute, and forty identical prompts in the
// development session is worse than none.
const RELAY_COOLDOWN_MS = 60 * 60 * 1000;

let _list = null;

function _load() {
  if (_list) return _list;
  try { _list = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { _list = []; }
  return _list;
}
function _save() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(_list, null, 2));
  } catch (e) { logger.warn('app-reports save: ' + (e.message || '').substring(0, 60)); }
}

/**
 * מנקה כל מה שעלול לשאת תוכן.
 *
 * הודעת שגיאה של אנדרואיד נוטה לגרור איתה את מה שנכשל — כתובת עם פרמטרים,
 * גוף תשובה, לפעמים טקסט שהמשתמש הקליד. כאן זה נחתך לפני שזה יוצא מהשרת.
 */
function _scrub(s, max = 300) {
  return String(s || '')
    .replace(/[?&](key|token|secret)=[^&\s]*/gi, '$1=***')
    .replace(/https?:\/\/[^\s]+/g, m => {
      try { const u = new URL(m); return u.origin.replace(/\/\/[^/]+/, '//***') + u.pathname; }
      catch { return '[url]'; }
    })
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, max);
}

function _signature(r) {
  return [r.kind, r.screen, r.endpoint, String(r.message || '').substring(0, 40)]
    .join('|').replace(/\d{3,}/g, 'N');
}

/** רושם דיווח. מחזיר את הפריט, או null אם נדחה. */
function record({ kind, screen, endpoint, status, message, appVersion, android, ts = Date.now() }) {
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    ts,
    kind: _scrub(kind, 40) || 'error',
    screen: _scrub(screen, 40),
    endpoint: _scrub(endpoint, 80),
    status: typeof status === 'number' ? status : null,
    message: _scrub(message, 300),
    appVersion: _scrub(appVersion, 20),
    android: _scrub(android, 20),
    relayed: false,
    count: 1,
  };
  const list = _load();
  const sig = _signature(item);

  // The same fault in the same hour is one report with a counter, not many.
  const recent = list.find(r => _signature(r) === sig && (Date.now() - r.ts) < RELAY_COOLDOWN_MS);
  if (recent) {
    recent.count = (recent.count || 1) + 1;
    recent.lastTs = Date.now();
    _save();
    return recent;
  }

  list.unshift(item);
  _list = list.slice(0, MAX_KEPT);
  _save();
  logger.info(`🐞 App report [${item.kind}] ${item.screen} ${item.endpoint} ${item.status || ''} — ${item.message.substring(0, 60)}`);
  return item;
}

/**
 * מעביר לשיחת הפיתוח דרך הגשר הקיים.
 *
 * אותו מסלול בדיוק כמו פקודת "קלוד": כותב פרומפט לתיבת הנכנסות במחשב שלו.
 * הוא לא מריץ שום דבר — מה שקורה אחר כך הוא שיחת Claude רגילה שבה אני
 * מבקש ממנו אישור לפני שאני משנה משהו.
 */
async function relay(item) {
  if (!item || item.relayed) return false;
  try {
    const da = require('./desktop-agent');
    if (!da.isConnected || !da.isConnected()) {
      // Left unrelayed on purpose: it goes out on the next attempt once the
      // agent is back, rather than being lost.
      return false;
    }
    const when = new Date(item.ts).toLocaleString('he-IL', {
      timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    const prompt =
      `🐞 דיווח שגיאה אוטומטי מאפליקציית JARVIS\n\n` +
      `זמן: ${when}\n` +
      `סוג: ${item.kind}\n` +
      (item.screen ? `מסך: ${item.screen}\n` : '') +
      (item.endpoint ? `נתיב: ${item.endpoint}\n` : '') +
      (item.status ? `סטטוס: ${item.status}\n` : '') +
      (item.count > 1 ? `חזר: ${item.count} פעמים\n` : '') +
      (item.appVersion ? `גרסה: ${item.appVersion}\n` : '') +
      (item.android ? `אנדרואיד: ${item.android}\n` : '') +
      `\nהודעה:\n${item.message}\n\n` +
      `— אבחן את זה מהלוגים של השרת, ואל תשנה כלום לפני שתציג לי מה נשבר ותקבל אישור.`;

    const r = await da.run('claude_ask', { prompt }, 20000);
    if (r && r.ok) {
      item.relayed = true;
      item.relayedAt = Date.now();
      _save();
      logger.info(`🐞 App report relayed to dev session: ${item.id}`);
      return true;
    }
    return false;
  } catch (e) {
    logger.warn('app-report relay: ' + (e.message || '').substring(0, 60));
    return false;
  }
}

/** דיווחים שממתינים להעברה — נשלחים כשהסוכן חוזר להתחבר. */
function pendingRelay() {
  return _load().filter(r => !r.relayed);
}

function recent(n = 30) { return _load().slice(0, n); }

function stats() {
  const l = _load();
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  return {
    total: l.length,
    last24h: l.filter(r => r.ts >= dayAgo).length,
    pending: l.filter(r => !r.relayed).length,
  };
}

module.exports = { record, relay, pendingRelay, recent, stats };
