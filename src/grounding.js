'use strict';
/**
 * 🔎 בודק עובדות — כל מה שהמודל כתב על השידור חייב להיות בתמלול.
 *
 * הציטוטים בתקציר נבדקו מילה במילה, אבל הכותרת והסיכום שהמודל כתב מעליהם לא:
 * ב-13.9 הציטוט אמר "המבצע הצבאי בדוחה" והנושא שמעליו — "קושנר: מבצע רפח היה
 * כישלון". המודל השלים מהידע שלו, ודובר שמקבל את זה עלול לחזור על זה בפומבי.
 *
 * כאן: מילים בכותרת ובסיכום שלא מופיעות בתמלול מסומנות, ומודל שני מתבקש לתקן
 * לפי התמלול בלבד. שם, מקום או מספר שלא נאמר — יוצא.
 */
const logger = require('./logger');

const STOP = new Set(('של את על עם זה זו לא כי גם אם או אבל רק כל יש אין היה היא הוא הם הן אני אנחנו ' +
  'אתה מה מי איך למה כמו עוד כבר אחרי לפני בין תחת מול אל עד שלא שהוא שהיא הזה הזאת היום אמר אמרה ' +
  'נגד בגלל כדי לכן מאוד יותר פחות שם פה כאן עכשיו אתמול מחר השבוע עדכון טען טוען אומר הגדיר ציין הוסיף ' +
  'דיווח דיווחים לדבריו לדבריה נמסר מסר הודיע הודיעה הסביר ביקורת קריאה').split(/\s+/));
const _norm = s => String(s || '').replace(/["'״׳`]/g, '').replace(/[^֐-׿a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** מילים בטקסט שאין להן שום זכר בתמלול (גם בלי ו/ה/ב/ל/מ/ש/כ בהתחלה). */
function missingWords(text, transcript) {
  const hay = ' ' + _norm(transcript) + ' ';
  const out = [];
  for (const w of new Set(_norm(text).split(' '))) {
    if (w.length < 3 || STOP.has(w) || /^\d{1,2}$/.test(w)) continue;
    const forms = [w];
    if (w.length >= 4 && /^[והבלמשכ]/.test(w)) forms.push(w.slice(1));
    if (w.length >= 5 && /^(וה|וב|ול|ומ|וש|שה|כש|מה|לה|בה)/.test(w)) forms.push(w.slice(2));
    const stem = forms[forms.length - 1];
    // The word itself, or its stem inside another form of it ("כישלון"/"נכשל" are not caught — that is the model's job).
    if (forms.some(f => hay.includes(f)) || (stem.length >= 4 && hay.includes(stem.slice(0, -1)))) continue;
    out.push(w);
  }
  return out;
}

/**
 * items: [{ id, fields: { title, summary, ... } }] — מחזיר את אותם פריטים, מתוקנים.
 * transcript: הטקסט שממנו נכתבו. קריאה אחת למודל, רק כשיש מה לבדוק.
 */
/**
 * כותרות מהאפליקציות ומהערוצים באותן שעות, שקשורות לפריט — לאימות מולן
 * ("רציתי שהשידורים יאומתו גם מול כותרות החדשות מהאפליקציות", 13.9).
 */
function relatedNews(text, fromTs, toTs, n = 3) {
  try {
    const na = require('./news-apps');
    return na.pushesBetween(fromTs, toTs)
      .map(p => ({ source: p.source, text: p.text, ts: p.ts, n: na.overlap(text, p.text) }))
      .filter(p => p.n >= 2).sort((a, b) => b.n - a.n)
      // One per source is enough to confirm or contradict.
      .filter((p, i, a) => a.findIndex(q => q.source === p.source) === i).slice(0, n);
  } catch (_) { return []; }
}

/**
 * opts.window: [from, to] — חלון הזמן לכותרות מהאפליקציות (ברירת מחדל: 3 שעות לפני ועד עכשיו).
 * פריט שמוחזר עם confirmed: [מקורות] — אפליקציות וערוצים שדיווחו את אותו דבר.
 */
async function ground(items, transcript, { label = '', window = null } = {}) {
  if (!items.length) return items;
  const [wFrom, wTo] = window || [Date.now() - 3 * 3600000, Date.now() + 60000];
  const prepared = items.map(it => {
    const text = Object.values(it.fields).filter(Boolean).join(' ');
    return { it, miss: missingWords(text, transcript), news: relatedNews(text, wFrom, wTo) };
  });
  // Nothing unstated and nothing to compare with — nothing to ask.
  const toAsk = prepared.filter(x => x.miss.length || x.news.length);
  if (!toAsk.length) return items;
  const hhmm = ts => new Date(ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
  const list = toAsk.map(({ it, miss, news }) =>
    `#${it.id}\n${Object.entries(it.fields).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n')}` +
    (miss.length ? `\nמילים שלא נמצאו בתמלול: ${miss.join(', ')}` : '') +
    (news.length ? `\nכותרות קשורות מאפליקציות וערוצים:\n${news.map(p => `  - [${p.source} ${hhmm(p.ts)}] ${p.text.substring(0, 220)}`).join('\n')}` : '')
  ).join('\n\n');
  const r = await require('./claude').classifyJSON(
    `תמלול:\n${String(transcript).substring(0, 24000)}\n\nפריטים לבדיקה:\n${list}`,
    {
      system: 'אתה בודק עובדות בחדר חדשות. לפניך תמלול רדיו, פריטים שנכתבו עליו, ולכל פריט כותרות קשורות מאפליקציות חדשות וערוצים מאותן שעות. ' +
        'לכל פריט: האם כל עובדה בו — שמות, מקומות, מספרים, מי עשה מה — מופיעה בתמלול? ניסוח אחר או מילה נרדפת זה בסדר; שם, מקום, מספר או אירוע שלא נאמרו — לא. ' +
        'אסור "לתקן" לפי מה שאתה יודע על העולם: אם בתמלול נאמר "דוחה" — הפריט אומר "דוחה". ' +
        'הכותרות מהאפליקציות הן לאימות: הן עוזרות להבין מילה שהתמלול שיבש (שגיאת שמיעה) ולזהות סתירה — אם הפריט אומר משהו שגם התמלול וגם הכותרות סותרים, הוא שגוי. אבל עובדה שמופיעה רק בכותרות ולא נאמרה ברדיו — לא מוסיפים. ' +
        'אם הפריט תקין — ok:true. אם לא — ok:false וכתוב מחדש את אותם שדות, באותו אורך בערך, לפי התמלול. ' +
        'confirmed: שמות המקורות מהכותרות הקשורות שמדווחים את אותו אירוע (או [] אם אף אחד). ' +
        'החזר JSON בלבד: {"items":[{"id":"...","ok":true|false,"fields":{...רק כש-ok:false},"wrong":"מה היה שגוי — קצר","confirmed":["..."]}]}',
      maxTokens: 3000,
    }
  );
  if (!r || !Array.isArray(r.items)) return items;
  const byId = new Map(r.items.filter(Boolean).map(x => [String(x.id).replace(/^#/, ''), x]));
  return items.map(it => {
    const f = byId.get(String(it.id));
    if (!f) return it;
    const confirmed = Array.isArray(f.confirmed) ? [...new Set(f.confirmed.map(String).filter(Boolean))].slice(0, 4) : [];
    if (f.ok !== false || !f.fields) return confirmed.length ? { ...it, confirmed } : it;
    const fields = { ...it.fields };
    for (const k of Object.keys(fields)) if (typeof f.fields[k] === 'string' && f.fields[k].trim()) fields[k] = f.fields[k].trim();
    logger.info(`🔎 grounded${label ? ' ' + label : ''}: "${String(Object.values(it.fields)[0]).substring(0, 50)}" → "${String(Object.values(fields)[0]).substring(0, 50)}" (${String(f.wrong || '').substring(0, 60)})`);
    return { ...it, fields, confirmed, corrected: String(f.wrong || 'תוקן לפי התמלול').substring(0, 120) };
  });
}

module.exports = { ground, missingWords, relatedNews };
