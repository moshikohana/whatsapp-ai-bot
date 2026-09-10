'use strict';
/**
 * 📌 דורש התייחסות — מה שמבקשים ממנו בקבוצות האישיות, שנבלע בין החדשות.
 *
 * "נא לאשר הגעה", "להביא מחר", "עד יום ה' לשלם", "התייצבות ב-07:00" — בקבוצת
 * המשפחה, בגן, במילואים, בעבודה. הוא עוקב אחרי עשרות קבוצות חדשות, ומה שבאמת
 * דורש ממנו תגובה טובע בהן. ב-10.9 הזמנה של מיכל מדמון נשלחה כתמונה — ואף
 * מנגנון לא ראה אותה, כי כולם קוראים רק טקסט.
 *
 * קבוצה אישית = קבוצת וואטסאפ שאינה באף רשימת סריקה (כל רשימות הסריקה הן
 * חדשות ופוליטיקה), ואינה ערוץ או קבוצת מודעות.
 *
 * טקסט: סינון מילים זול, ורק מועמדות מגיעות למודל. תמונה: המודל קורא אותה
 * (הזמנות מגיעות כתמונה), בגרסה מוקטנת כדי שיהיה זול.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const FILE = path.join(__dirname, '..', 'data', 'attention.json');
const KEEP_DAYS = 21;

// Words that usually come with a request. Only a gate for the model — a false
// hit costs one short call; the model decides.
const TEXT_CUE = /(לאשר|אישור הגעה|תאשר|מאשרים|מי מגיע|מי בא|כמה מגיעים|להגיע|הזמנה|מוזמנ|להביא|תביאו|עד יום|עד מחר|עד ה-?\d|דדליין|הרשמה|להירשם|תירשמו|לשלם|תשלום|להעביר|ביט|פייבוקס|טופס|למלא|תמלאו|אסיפ|פגישה|ישיבה|להתייצב|התייצבות|תזכורת|שימו לב|חובה|אל תשכחו|נא ל|בבקשה ל|rsvp|\d{1,2}[:.]\d{2}|מחר ב|ב-?\d{1,2}[./]\d{1,2})/i;
const JUNK_GROUP = /(עבודות|דרושים|מציאת עבודה|קופון|מבצעים|למכירה|יד שנייה)/;

let _presetIds = null, _presetAt = 0;
function _newsGroupIds() {
  if (_presetIds && Date.now() - _presetAt < 5 * 60000) return _presetIds;
  const s = new Set();
  try {
    for (const p of require('./scan-presets').list() || []) {
      for (const src of p.sources || []) {
        const v = typeof src === 'string' ? src : (src && (src.id || src.name)) || '';
        if (v.startsWith('wa:')) s.add(v.slice(3));
      }
    }
  } catch (_) {}
  _presetIds = s; _presetAt = Date.now();
  return s;
}

function isPersonal(chatId, name) {
  if (!chatId || !chatId.endsWith('@g.us')) return false;
  if (_newsGroupIds().has(chatId)) return false;
  if (JUNK_GROUP.test(name || '')) return false;
  return true;
}

function _load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } }
function _save(l) { try { fs.writeFileSync(FILE, JSON.stringify(l, null, 1)); } catch (e) { logger.warn('attention save: ' + (e.message || '').substring(0, 50)); } }

const _seenMsg = new Set();

function _today() {
  const d = new Date();
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const il = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  return `${il.getFullYear()}-${String(il.getMonth() + 1).padStart(2, '0')}-${String(il.getDate()).padStart(2, '0')}, יום ${days[il.getDay()]}, ${String(il.getHours()).padStart(2, '0')}:${String(il.getMinutes()).padStart(2, '0')}`;
}

const SYSTEM = () => `אתה העוזר האישי של מושיקו. קיבלת הודעה מקבוצת וואטסאפ אישית שלו (משפחה, גן של הבנות, עבודה, מילואים).
האם ההודעה מבקשת ממנו — או מכל חברי הקבוצה — לעשות משהו: לאשר הגעה, להגיע למקום בשעה מסוימת, להביא משהו, לשלם, להירשם, למלא טופס, לענות, או לעמוד במועד?
ברכות, תמונות משפחתיות, בדיחות, עדכונים וחדשות — לא. הודעה שכבר אומרת "תודה לכל מי שאישר" — לא.
היום: ${_today()} (שעון ישראל).
החזר JSON בלבד:
{"needs": true|false,
 "what": "משפט קצר — מה בדיוק צריך לעשות",
 "event": "שם האירוע או null",
 "when": "היום והשעה כפי שנכתבו, או null",
 "where": "המקום, או null",
 "deadline": "עד מתי להגיב, או null",
 "dateISO": "YYYY-MM-DDTHH:MM של האירוע, או null"}
כללים ל-dateISO: רק כשגם היום וגם השעה כתובים במפורש — בלי שעה, null (לא 00:00).
יום בשבוע ("יום חמישי") = המופע הקרוב שעוד לא עבר: אם זה היום והשעה כבר עברה — השבוע הבא.
כשיש כמה מועדים — של האירוע שצריך להגיע אליו.`;

/**
 * A date already in the past is not where he has to be. "יום חמישי ב-19:30"
 * sent on Thursday at 20:45 means next week; the model, told the time, still
 * answered "today". Fixed here rather than trusted to the prompt.
 */
function _fixDate(iso, text) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(iso || '')) return null;
  const il = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const p = n => String(n).padStart(2, '0');
  const nowLocal = `${il.getFullYear()}-${p(il.getMonth() + 1)}-${p(il.getDate())}T${p(il.getHours())}:${p(il.getMinutes())}`;
  if (iso >= nowLocal) return iso;
  if (!/(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/.test(text)) return null;
  const [d, t] = iso.split('T');
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 7);
  const out = `${dt.toISOString().slice(0, 10)}T${t}`;
  return out >= nowLocal ? out : null;
}

async function _classifyText(text, group, sender) {
  return require('./claude').classifyJSON(
    `קבוצה: ${group}\nשולח/ת: ${sender || '—'}\nהודעה:\n${String(text).substring(0, 1500)}`,
    { system: SYSTEM(), maxTokens: 400, model: 'claude-haiku-4-5-20251001' }
  );
}

async function _classifyImage(buf, caption, group, sender) {
  const sharp = require('sharp');
  const small = await sharp(buf).rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const Anthropic = require('@anthropic-ai/sdk');
  const a = new (Anthropic.default || Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await a.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 400,
    system: SYSTEM() + '\nההודעה היא תמונה — הזמנה, מודעה, צילום מסך או סתם תמונה. קרא את מה שכתוב בה.',
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: small.toString('base64') } },
      { type: 'text', text: `קבוצה: ${group}\nשולח/ת: ${sender || '—'}\nכיתוב לתמונה: ${caption || '(אין)'}` },
    ] }],
  });
  const t = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const m = t.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

/**
 * נקרא על כל הודעה בקבוצה. מחזיר פריט חדש כשיש משהו שדורש ממנו פעולה.
 * @param media  { buffer } לתמונה, אם כבר הורדה
 */
async function check({ msgId, chatId, group, sender, text, isImage, media, ts = Date.now() }) {
  try {
    if (!isPersonal(chatId, group)) return null;
    if (msgId) { if (_seenMsg.has(msgId)) return null; _seenMsg.add(msgId); if (_seenMsg.size > 2000) _seenMsg.clear(); }
    let r = null, source = 'text';
    if (isImage && media && media.buffer) {
      source = 'image';
      r = await _classifyImage(media.buffer, text, group, sender);
    } else {
      if (!text || text.length < 12 || !TEXT_CUE.test(text)) return null;
      r = await _classifyText(text, group, sender);
    }
    if (!r || r.needs !== true || !r.what) return null;

    const list = _load();
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
    // The same request, reposted or forwarded — once.
    if (list.some(x => x.group === group && norm(x.what) === norm(r.what) && ts - x.ts < 2 * 86400000)) return null;
    const item = {
      id: `${ts}-${Math.random().toString(36).slice(2, 6)}`, ts,
      group: String(group || '').substring(0, 80), sender: String(sender || '').substring(0, 40),
      what: String(r.what).substring(0, 200),
      event: r.event ? String(r.event).substring(0, 120) : null,
      when: r.when ? String(r.when).substring(0, 80) : null,
      where: r.where ? String(r.where).substring(0, 120) : null,
      deadline: r.deadline ? String(r.deadline).substring(0, 80) : null,
      dateISO: _fixDate(r.dateISO, `${text || ''} ${r.when || ''}`),
      source, excerpt: String(text || '').substring(0, 300),
      done: false, calendar: false,
    };
    list.unshift(item);
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    _save(list.filter(x => x.ts >= cutoff).slice(0, 300));
    logger.info(`📌 attention: "${item.what.substring(0, 50)}" (${group}, ${source})`);
    return item;
  } catch (e) {
    logger.warn('attention check: ' + (e.message || '').substring(0, 60));
    return null;
  }
}

function format(it) {
  const lines = [`📌 *דורש התייחסות* · ${it.group}${it.sender ? ` · ${it.sender}` : ''}`, '', `*${it.what}*`];
  const facts = [it.when && `🗓️ ${it.when}`, it.where && `📍 ${it.where}`].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '));
  if (it.deadline) lines.push(`⏳ לענות עד: ${it.deadline}`);
  if (it.source === 'image') lines.push('_(נקרא מתוך תמונה)_');
  lines.push('', `↩️ ענה על ההודעה: *טופל*${it.dateISO ? ' או *ליומן*' : ''}`);
  return lines.join('\n');
}

function open() { return _load().filter(x => !x.done); }
function recent(n = 30) { return _load().slice(0, n); }
function find(id) { return _load().find(x => x.id === id) || null; }

function markDone(id) {
  const l = _load(); const x = l.find(i => i.id === id);
  if (!x) return false;
  x.done = true; x.doneAt = Date.now(); _save(l);
  return true;
}

/** מוסיף ליומן גוגל. רק כשיש תאריך ושעה מדויקים — ניחוש ביומן גרוע מכלום. */
async function toCalendar(id) {
  const l = _load(); const x = l.find(i => i.id === id);
  if (!x) throw Object.assign(new Error('הפריט לא נמצא'), { code: 'NOT_FOUND' });
  if (!x.dateISO) throw Object.assign(new Error('אין תאריך ושעה מדויקים בהודעה'), { code: 'NO_DATE' });
  const { google } = require('googleapis');
  const cal = google.calendar({ version: 'v3', auth: require('./calendar').getAuthClient() });
  const [d, t] = x.dateISO.split('T');
  const [hh, mm] = t.split(':').map(Number);
  const endH = String((hh + 2) % 24).padStart(2, '0');
  const res = await cal.events.insert({
    calendarId: 'primary',
    resource: {
      summary: x.event || x.what,
      location: x.where || undefined,
      description: `מתוך "${x.group}"${x.sender ? ` · ${x.sender}` : ''}\n${x.what}${x.deadline ? `\nלענות עד: ${x.deadline}` : ''}`,
      start: { dateTime: `${d}T${t}:00`, timeZone: 'Asia/Jerusalem' },
      end: { dateTime: `${d}T${endH}:${String(mm).padStart(2, '0')}:00`, timeZone: 'Asia/Jerusalem' },
    },
  });
  x.calendar = true; x.calendarAt = Date.now(); _save(l);
  return { summary: res.data.summary, when: `${d.split('-').reverse().join('.')} ${t}` };
}

module.exports = { check, format, open, recent, find, markDone, toCalendar, isPersonal };
