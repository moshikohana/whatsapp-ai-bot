'use strict';
/**
 * יומן פעילות — כל מה שהוא עושה עם בוטי, בשני הערוצים.
 *
 * המטרה: אחרי כמה ימים לראות דפוסים — מה הוא מריץ, מתי, מאיזה ערוץ, ומה הוא
 * עושה שוב ושוב שאפשר לקצר — ולבנות פיצ׳רים לפי השימוש האמיתי ולא לפי ניחוש.
 *
 * שני מקורות:
 *   • וואטסאפ — הבוט כבר רושם כל הודעה בצ׳אט הפרטי ל-logs/chat-YYYY-MM-DD.log
 *   • האפליקציה — נרשם כאן, מתוך שכבת ה-API, עם שם פעולה קריא
 *
 * הסקרים של שירות הרקע (pull כל דקה) לא נרשמים: הם 1,440 שורות ביום שלא
 * אומרות כלום על מה שהוא עשה, והיו מטביעים את מה שכן.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const FILE = path.join(__dirname, '..', 'data', 'app-activity.jsonl');
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const KEEP_DAYS = 30;

// Endpoints that are background plumbing, not something he did.
const NOISE = /\/(pull|hello|faces\/tracked|faces\/checks|faces\/photos|faces\/references|decisions$|scan\/last|groups\/live|scan\/presets|broadcast$|reports|memory|actions|wa-thread|activity|changelog|check\/full|warroom$|lead-radar|news-push|news-compare|attention$|videos$|videos\/thumb|videos\/file)/;

/** שם קריא לפעולה באפליקציה, לפי הנתיב והגוף. */
function describe(method, route, body) {
  const b = body || {};
  const map = [
    [/\/command$/, () => `פקודה: ${String(b.text || '').substring(0, 60)}`],
    [/\/chat$/, () => `שיחה: ${String(b.text || '').substring(0, 60)}`],
    [/\/chat\/reset$/, () => 'ניקוי שיחה'],
    [/\/scan\/preset$/, () => `סריקת פריסט (${b.hours || 24} שעות)`],
    [/\/broadcast\/analyse$/, () => `ניתוח רדיו (${b.hours || 1} שעות)`],
    [/\/broadcast\/terms$/, () => `${b.action === 'remove' ? 'הסרת' : 'הוספת'} מילת מעקב: ${b.term || ''}`],
    [/\/broadcast\/context$/, () => 'פתיחת הקשר מהשידור'],
    [/\/face\/number$/, () => 'מספור פרצופים'],
    [/\/face\/unteach$/, () => `מחיקת ייחוס שגוי: ${b.name || ''}`],
    [/\/face\/reference\/delete$/, () => `מחיקת תמונת ייחוס: ${b.name || ''}`],
    [/\/face\/reference$/, () => `הוספת ייחוס: ${b.name || ''}`],
    [/\/face\/photo\/delete$/, () => `מחיקת תמונה: ${b.name || ''}`],
    [/\/face\/person\/delete$/, () => `מחיקת אדם: ${b.name || ''}`],
    [/\/decisions\/answer$/, () => `הכרעה על ספק: ${b.value || ''}`],
    [/\/warroom\/end$/, () => 'סיום מצב חירום'],
    [/\/keywords/, () => method === 'GET' ? null : 'עדכון מילות מפתח'],
  ];
  for (const [re, fn] of map) if (re.test(route)) return fn();
  return null;
}

function _category(label) {
  if (/סריק|פריסט/.test(label)) return 'סריקה';
  if (/רדיו|שידור|מילת מעקב/.test(label)) return 'רדיו';
  if (/פרצוף|ייחוס|תמונה|אדם|ספק/.test(label)) return 'פנים';
  if (/שיחה/.test(label)) return 'שיחה';
  if (/פקודה/.test(label)) return 'פקודה';
  return 'אחר';
}

/** נקרא מה-middleware של ה-API. בולע כל שגיאה — יומן לא יפיל בקשה. */
function recordApp(method, route, body, status) {
  try {
    if (NOISE.test(route) && method === 'GET') return;
    const label = describe(method, route, body);
    if (!label) return;
    const line = JSON.stringify({
      ts: Date.now(), source: 'app', label, category: _category(label),
      ok: status >= 200 && status < 300,
    });
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, line + '\n');
  } catch (e) { logger.warn('activity record: ' + (e.message || '').substring(0, 50)); }
}

function _readApp(sinceTs) {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.ts >= sinceTs);
  } catch { return []; }
}

// His own chat with the bot — by number, and by the lid WhatsApp sometimes
// uses in its place. Replies the bot sent into groups are not part of it.
function _ownerIds() {
  const ids = new Set([process.env.OWNER_ID || '972524243250@c.us']);
  try {
    const lid = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'owner-lid.json'), 'utf8')).lid;
    if (lid) ids.add(lid);
  } catch {}
  return ids;
}

function _readWhatsApp(days) {
  const out = [];
  const owner = _ownerIds();
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.now() - d * 86400000)
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    let raw = '';
    try { raw = fs.readFileSync(path.join(LOGS_DIR, `chat-${date}.log`), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.chatId && !owner.has(e.chatId)) continue;
        const text = String(e.text || '').replace(/[*_~`]/g, '').trim();
        if (!text) continue;
        out.push({
          ts: new Date(e.ts).getTime(),
          source: 'whatsapp',
          dir: e.dir === 'in' ? 'in' : 'out',
          label: text.substring(0, 220),
          full: text.length > 220,
          text,
          category: e.dir === 'in' ? 'הודעה שלך' : 'תשובת בוטי',
        });
      } catch {}
    }
  }
  return out;
}

/**
 * ציר זמן מאוחד + סיכום דפוסים ראשוני.
 * הסיכום בכוונה פשוט — ספירות ושעות. הניתוח האמיתי יבוא כשיהיו מספיק ימים.
 */
function timeline(days = 3, limit = 200) {
  const since = Date.now() - days * 86400000;
  const app = _readApp(since);
  const wa = _readWhatsApp(days).filter(e => e.ts >= since);
  const all = [...app, ...wa].sort((a, b) => b.ts - a.ts);

  const hourOf = ts => +new Date(ts).toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false });
  const byHour = new Array(24).fill(0);
  for (const e of all) if (e.source === 'app' || e.dir === 'in') byHour[hourOf(e.ts) % 24]++;

  const byCategory = {};
  for (const e of app) byCategory[e.category] = (byCategory[e.category] || 0) + 1;

  // What he types to the bot most — the raw material for shortcuts.
  const commands = {};
  for (const e of wa) {
    if (e.dir !== 'in') continue;
    const first = e.label.split(/\s+/).slice(0, 2).join(' ');
    if (first.length >= 2) commands[first] = (commands[first] || 0) + 1;
  }
  const topCommands = Object.entries(commands).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([text, count]) => ({ text, count }));

  const peak = byHour.indexOf(Math.max(...byHour));
  return {
    entries: all.slice(0, limit).map(({ text, ...e }) => e),
    stats: {
      days,
      appActions: app.length,
      whatsappIn: wa.filter(e => e.dir === 'in').length,
      whatsappOut: wa.filter(e => e.dir === 'out').length,
      byCategory,
      byHour,
      peakHour: Math.max(...byHour) > 0 ? peak : null,
      topCommands,
    },
  };
}

/**
 * השיחה שלו עם בוטי בוואטסאפ, בטקסט מלא — לטאב השיחה באפליקציה.
 * זה אותו בוט ואותו זיכרון; בלי זה האפליקציה נראתה כמו בוט אחר שלא יודע
 * מה נאמר לו לפני רבע שעה.
 */
function waThread(limit = 40, days = 2) {
  return _readWhatsApp(days)
    .sort((a, b) => a.ts - b.ts)
    .slice(-limit)
    .map(e => ({ ts: e.ts, dir: e.dir, text: e.text.substring(0, 1500) }));
}

function prune() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    const kept = _readApp(cutoff).map(e => JSON.stringify(e)).join('\n');
    fs.writeFileSync(FILE, kept ? kept + '\n' : '');
  } catch {}
}

module.exports = { recordApp, timeline, waThread, prune };
