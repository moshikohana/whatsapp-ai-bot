'use strict';
/**
 * 🔎 בודק עובדות — כל מה שהמודל כתב על השידור חייב להיות בתמלול.
 *
 * הציטוטים בתקציר נבדקו מילה במילה, אבל הכותרת והסיכום שהמודל כתב מעליהם לא:
 * ב-13.9 הציטוט אמר "המבצע הצבאי בדוחה" והנושא שמעליו — "קושנר: מבצע רפח היה
 * כישלון". המודל השלים מהידע שלו, ודובר שמקבל את זה עלול לחזור על זה בפומבי.
 *
 * כאן: מילים בכותרת ובסיכום שלא מופיעות בתמלול מסומנות, ומודל שני מתקן לפי
 * התמלול ולפי כותרות האפליקציות מאותן שעות. ובלי לסמוך עליו: שם, מקום, ארגון
 * או מספר שאין לו זכר לא בתמלול ולא באף כותרת — הקוד בודק שיצא, ואם לא יצא
 * גם בניסיון שני, הפריט לא נשלח. בבדיקה החוזרת של אותו תקציר המודל אישר את
 * "רפח" — לכן ההחלטה הסופית היא של הקוד.
 */
const logger = require('./logger');

const STOP = new Set(('של את על עם זה זו לא כי גם אם או אבל רק כל יש אין היה היא הוא הם הן אני אנחנו ' +
  'אתה מה מי איך למה כמו עוד כבר אחרי לפני בין תחת מול אל עד שלא שהוא שהיא הזה הזאת היום אמר אמרה ' +
  'נגד בגלל כדי לכן מאוד יותר פחות שם פה כאן עכשיו אתמול מחר השבוע עדכון טען טוען אומר הגדיר ציין הוסיף ' +
  'דיווח דיווחים לדבריו לדבריה נמסר מסר הודיע הודיעה הסביר ביקורת קריאה').split(/\s+/));
const _norm = s => String(s || '').replace(/["'״׳`]/g, '').replace(/[^֐-׿a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

function _forms(w) {
  const forms = [w];
  if (w.length >= 4 && /^[והבלמשכ]/.test(w)) forms.push(w.slice(1));
  if (w.length >= 5 && /^(וה|וב|ול|ומ|וש|שה|כש|מה|לה|בה)/.test(w)) forms.push(w.slice(2));
  return forms;
}
/** האם למילה יש זכר בטקסט (גם בלי אות שימוש בהתחלה, גם בנטייה אחרת). */
function _has(hay, w) {
  const forms = _forms(w);
  const stem = forms[forms.length - 1];
  return forms.some(f => hay.includes(f)) || (stem.length >= 4 && hay.includes(stem.slice(0, -1)));
}

// 🔊 How a word sounds, roughly: the consonants, with letters that sound alike
// merged. The transcript hears "עלי טאהר" as "אלי תהר" and "נבטיה" as "ענה
// בתיה"; the checker took the right spelling for a fact that was never said
// and rewrote it into the slip (21:00, 13.9). "רפח" and "דוחה" still differ.
const _SOUND = { 'ט': 'ת', 'כ': 'ק', 'ך': 'ק', 'ח': 'ק', 'ס': 'ש', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const _skel = w => [...String(w).replace(/[^֐-׿]/g, '')].filter(ch => !'אהויע'.includes(ch)).map(ch => _SOUND[ch] || ch).join('');
function _soundIndex(transcript) {
  const words = _norm(transcript).split(' ').filter(Boolean);
  const idx = new Set();
  const add = s => { if (s.length >= 2) idx.add(s); };
  for (let i = 0; i < words.length; i++) {
    for (const w of _forms(words[i])) {
      add(_skel(w));
      if (words[i + 1]) add(_skel(w + words[i + 1]));
    }
  }
  return idx;
}
/** נשמע כמו משהו בתמלול — אותה מילה בכתיב של שגיאת שמיעה. */
function _soundsIn(idx, w) {
  return _forms(w).some(f => { const s = _skel(f); return s.length >= 2 && idx.has(s); });
}

/** מילים בטקסט שאין להן שום זכר בתמלול — לא בכתיב ולא בצליל. */
function missingWords(text, transcript) {
  const hay = ' ' + _norm(transcript) + ' ';
  let idx = null;
  const out = [];
  for (const w of new Set(_norm(text).split(' '))) {
    if (w.length < 3 || STOP.has(w) || /^\d{1,2}$/.test(w)) continue;
    if (_has(hay, w)) continue;
    if (/[֐-׿]/.test(w) && _soundsIn(idx || (idx = _soundIndex(transcript)), w)) continue;
    out.push(w);
  }
  return out;
}

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

const SYSTEM = 'אתה בודק עובדות בחדר חדשות. לפניך תמלול רדיו, פריטים שנכתבו עליו, ולכל פריט כותרות קשורות מאפליקציות חדשות וערוצים מאותן שעות. ' +
  'לכל פריט: האם כל עובדה בו — שמות, מקומות, מספרים, מי עשה מה — מופיעה בתמלול? ניסוח אחר או מילה נרדפת זה בסדר; שם, מקום, מספר או אירוע שלא נאמרו — לא. ' +
  'אסור "לתקן" לפי מה שאתה יודע על העולם: אם בתמלול נאמר "דוחה" — הפריט אומר "דוחה" (דוחה ורפח — שני מקומות שונים). ' +
  'אבל התמלול אוטומטי ומלא שגיאות שמיעה וכתיב: "אלי תהר" = עלי טאהר, "ענה בתיה" = נבטיה, "ג\'רנל" = ג\'ורנל. כשהפריט כותב נכון שם שנשמע בתמלול משובש — זה תקין. לעולם אל תחליף כתיב נכון בשגיאת התמלול. ' +
  'כשמתקנים — משנים רק את המילים השגויות, וכל השאר נשאר כמו שהוא. ' +
  'הכותרות מהאפליקציות הן לאימות: הן עוזרות להבין מילה שהתמלול שיבש (שגיאת שמיעה) ולזהות סתירה. עובדה שמופיעה רק בכותרות ולא נאמרה ברדיו — לא מוסיפים. ' +
  'מילה שמסומנת "לא בתמלול וגם לא באף כותרת" ושהיא שם של אדם, מקום, ארגון, מדינה או מספר — חובה להוציא אותה: ok:false וכתוב את הפריט מחדש בלעדיה, לפי התמלול. ' +
  'entities: אילו מהמילים שלא נמצאו בתמלול הן שם של אדם, מקום, ארגון, מדינה או מספר (לא מילים רגילות). ' +
  'confirmed: שמות המקורות (בלי שעה) מהכותרות הקשורות שמדווחים את אותו אירוע, או []. ' +
  'החזר JSON בלבד: {"items":[{"id":"...","ok":true|false,"fields":{...רק כש-ok:false},"wrong":"מה היה שגוי — קצר","entities":["..."],"confirmed":["..."]}]}';

/**
 * items: [{ id, fields: { title, summary, ... } }] — מחזיר את אותם פריטים, מתוקנים.
 * פריט עם drop:true — לא נתמך בשידור גם אחרי תיקון; לא לשלוח.
 * opts.window: [from, to] לכותרות מהאפליקציות.
 */
async function ground(items, transcript, { label = '', window = null } = {}) {
  if (!items.length) return items;
  const claude = require('./claude');
  const [wFrom, wTo] = window || [Date.now() - 3 * 3600000, Date.now() + 60000];
  const prepared = items.map(it => {
    const text = Object.values(it.fields).filter(Boolean).join(' ');
    const miss = missingWords(text, transcript);
    const news = relatedNews(text, wFrom, wTo);
    const newsHay = ' ' + _norm(news.map(p => p.text).join(' ')) + ' ';
    // Not in the transcript, and not in any headline either: nowhere at all.
    const nowhere = miss.filter(w => !_has(newsHay, w));
    return { it, miss, news, nowhere };
  });
  const toAsk = prepared.filter(x => x.miss.length || x.news.length);
  if (!toAsk.length) return items;
  const hhmm = ts => new Date(ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
  const block = ({ it, miss, news, nowhere }) =>
    `#${it.id}\n${Object.entries(it.fields).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n')}` +
    (miss.length ? `\nמילים שלא נמצאו בתמלול: ${miss.join(', ')}` : '') +
    (nowhere.length ? `\nמתוכן — לא בתמלול וגם לא באף כותרת: ${nowhere.join(', ')}` : '') +
    (news.length ? `\nכותרות קשורות מאפליקציות וערוצים:\n${news.map(p => `  - [${p.source} ${hhmm(p.ts)}] ${p.text.substring(0, 220)}`).join('\n')}` : '');
  const ask = async list => {
    const r = await claude.classifyJSON(`תמלול:\n${String(transcript).substring(0, 24000)}\n\nפריטים לבדיקה:\n${list.map(block).join('\n\n')}`,
      { system: SYSTEM, maxTokens: 3000, temperature: 0 });
    return new Map(((r && r.items) || []).filter(Boolean).map(x => [String(x.id).replace(/^#/, ''), x]));
  };

  const byId = await ask(toAsk);
  // A second opinion on which words are names — out of context, so the model
  // that wrote "רפח" is not the one deciding whether "רפח" is a place.
  const allNowhere = [...new Set(toAsk.flatMap(p => p.nowhere))];
  let named = new Set();
  if (allNowhere.length) {
    const rn = await claude.classifyJSON(`מילים: ${allNowhere.join(', ')}`, {
      system: 'אילו מהמילים הן שם של אדם, מקום, עיר, מדינה, ארגון, מפלגה, מבצע צבאי או מספר? מילים רגילות (פעלים, תארים, שמות עצם כלליים) — לא. החזר JSON בלבד: {"names":["..."]}',
      maxTokens: 300, model: 'claude-haiku-4-5-20251001', temperature: 0,
    });
    named = new Set(((rn && rn.names) || []).map(e => _norm(e)));
  }
  const result = new Map();
  const retry = [];
  for (const p of toAsk) {
    const f = byId.get(String(p.it.id)) || {};
    const fields = { ...p.it.fields };
    if (f.ok === false && f.fields) for (const k of Object.keys(fields)) if (typeof f.fields[k] === 'string' && f.fields[k].trim()) fields[k] = f.fields[k].trim();
    const confirmed = Array.isArray(f.confirmed) ? [...new Set(f.confirmed.map(s => String(s).replace(/\s+\d{1,2}:\d{2}$/, '').trim()).filter(Boolean))].slice(0, 4) : [];
    // The code's check: a name, place or number that is nowhere — is it still in?
    const ents = new Set([...(Array.isArray(f.entities) ? f.entities : []).map(e => _norm(e)), ...named]);
    const bad = p.nowhere.filter(w => ents.has(w) || [...ents].some(e => e.includes(w) || w.includes(e)));
    const now = ' ' + _norm(Object.values(fields).join(' ')) + ' ';
    const left = bad.filter(w => _has(now, w));
    result.set(p.it.id, { fields, confirmed, wrong: f.wrong, changed: f.ok === false, bad, left });
    if (left.length) retry.push(p);
  }

  // A second, narrower ask for what still carries a name from nowhere.
  if (retry.length) {
    const r2 = await claude.classifyJSON(
      `תמלול:\n${String(transcript).substring(0, 24000)}\n\n` + retry.map(p => {
        const x = result.get(p.it.id);
        return `#${p.it.id}\n${Object.entries(x.fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\nחובה להוציא: ${x.left.join(', ')}`;
      }).join('\n\n'),
      {
        system: 'כתוב מחדש כל פריט רק לפי התמלול, בלי המילים שמסומנות "חובה להוציא" — הן לא נאמרו בשידור. שמור על אותם שדות ואורך דומה. ' +
          'החזר JSON בלבד: {"items":[{"id":"...","fields":{...}}]}',
        maxTokens: 2000, temperature: 0,
      });
    const m2 = new Map(((r2 && r2.items) || []).filter(Boolean).map(x => [String(x.id).replace(/^#/, ''), x]));
    for (const p of retry) {
      const x = result.get(p.it.id);
      const f2 = m2.get(String(p.it.id));
      if (f2 && f2.fields) for (const k of Object.keys(x.fields)) if (typeof f2.fields[k] === 'string' && f2.fields[k].trim()) x.fields[k] = f2.fields[k].trim();
      const now = ' ' + _norm(Object.values(x.fields).join(' ')) + ' ';
      x.changed = true;
      x.wrong = x.wrong || `לא נאמר בשידור: ${x.left.join(', ')}`;
      x.left = x.left.filter(w => _has(now, w));
      if (x.left.length) {
        x.drop = true;
        logger.warn(`🔎 grounding${label ? ' ' + label : ''}: dropped "${String(Object.values(p.it.fields)[0]).substring(0, 50)}" — still says ${x.left.join(', ')}`);
      }
    }
  }

  return items.map(it => {
    const x = result.get(it.id);
    if (!x) return it;
    if (!x.changed) return x.confirmed.length ? { ...it, confirmed: x.confirmed } : it;
    if (!x.drop) logger.info(`🔎 grounded${label ? ' ' + label : ''}: "${String(Object.values(it.fields)[0]).substring(0, 50)}" → "${String(Object.values(x.fields)[0]).substring(0, 50)}" (${String(x.wrong || '').substring(0, 60)})`);
    // removed: the names from nowhere taken out — what makes a change worth telling him.
    return { ...it, fields: x.fields, confirmed: x.confirmed, corrected: String(x.wrong || 'תוקן לפי התמלול').substring(0, 120), removed: x.bad || [], ...(x.drop ? { drop: true } : {}) };
  });
}

module.exports = { ground, missingWords, relatedNews };
