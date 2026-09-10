'use strict';
/**
 * כותרות מהשידור — לפני שהן מגיעות לוואטסאפ.
 *
 * ב-10.9 בשעה 08:15 יו"ר הכנסת אמיר אוחנה אמר ב-103FM שעופר וינטר "צריך
 * לפרוש, הוא מסכן את מחנה הימין". הניטור קלט את זה — המשפט היה בתמלול מילה
 * במילה. אבל הוא הגיע אליו רק דרך התקציר השעתי, קבור כחצי משפט בתוך נושא
 * בשם "שריונים בליכוד", בלי ציטוט ובלי התראה. בינתיים "מלוכדים" פרסמו אותו
 * כמבזק. זו בדיוק המטרה שהפיצ׳ר נכשל בה.
 *
 * תקציר שעתי לא יכול להקדים מבזק. כאן כל דגימה חדשה נבדקת מיד, יחד עם
 * הדגימה שלפניה באותה תחנה — הדגימות חותכות משפטים באמצע, וכותרת טובה נופלת
 * לפעמים בדיוק על התפר.
 *
 * מודל קטן ומהיר לכל דגימה, כי זה רץ כ-30 פעמים בשעה. הפרסומות מסוננות לפני
 * שהן בכלל מגיעות למודל.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DIR = path.join(__dirname, '..', 'data', 'broadcast');
const FILE = path.join(DIR, 'headlines.json');
const MAX_KEPT = 150;
const DEDUPE_MS = 90 * 60 * 1000;
const MIN_SCORE = 4;          // 1-5; only genuine headlines interrupt him

const _prev = {};             // station -> recent chunks [{ ts, text }]

// Words too common to say two headlines are about the same thing.
const STOP = new Set([
  'את', 'של', 'על', 'עם', 'הוא', 'היא', 'זה', 'זו', 'לא', 'כי', 'אם', 'גם', 'או',
  'אבל', 'כל', 'יש', 'אין', 'היה', 'הם', 'הן', 'אני', 'אנחנו', 'שלו', 'שלה',
  'מול', 'אחרי', 'לפני', 'בין', 'כמו', 'רק', 'עוד', 'כבר', 'אחד', 'אחת',
]);
let _busy = false;

/**
 * פרסומת או פרומו — לא חדשות.
 *
 * רוב מה שהופיע ב"נקלט עכשיו" היה פרסומות: מבצעים, מספרי טלפון, קריאות
 * להתקשר. הן מסוננות כאן, לפני המודל, גם כדי לחסוך קריאה וגם כדי שלא יוצגו.
 */
function isAd(text) {
  const t = String(text || '');
  const hits = [
    /מבצע|הנחה|במחיר|₪|שקלים בלבד|בלבד!|לרכישה|הזמינו|התקשרו|חייגו|לפרטים/,
    /\*\d{3,4}|\b0\d{1,2}[-\s]?\d{7}\b|www\.|\.co\.il|אתר האינטרנט/,
    /בחסות|מוגש על ידי|פרסומת|תוכן שיווקי|ט\.ל\.ח/,
    /קופון|משלוח חינם|עד גמר המלאי|רק השבוע|רק היום/,
  ].filter(r => r.test(t)).length;
  return hits >= 1;
}

function _load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function _save(list) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list.slice(0, MAX_KEPT), null, 2));
  } catch (e) { logger.warn('headlines save: ' + (e.message || '').substring(0, 60)); }
}

const SYSTEM = `אתה עורך מבזקים בחדר חדשות פוליטי בישראל. אתה מקבל קטע תמלול רדיו קצר.

השאלה היחידה: **האם יש כאן כותרת** — משהו שאתר חדשות או ערוץ וואטסאפ פוליטי היו מפרסמים כמבזק?

כותרת = אמירה בולטת על פוליטיקה, בחירות, ביטחון, מלחמה, חטופים או משפט — עמדה חריפה, קריאה למישהו לפרוש, התקפה על פוליטיקאי, חשיפה, הכרזה — או התפתחות חדשותית ממשית.

⚠️ הדובר לא חייב להיות מזוהה כדי שזו תהיה כותרת. הקטעים הם דגימות של 55 שניות, ולרוב ההצגה של המרואיין נפלה לפני הדגימה. "וינטר צריך לפרוש, הוא מסכן את מחנה הימין" היא כותרת גם כשלא ברור מי אמר אותה — היא עוסקת בדמויות מוכרות ובעמדה חדה.

לא כותרת: פרסומות, מוזיקה, ספורט, מזג אוויר, תנועה, טיפים צרכניים, שיחת חולין של מנחים, קריינות של מבזק שכבר ידוע.

כללים:
- quote חייב להיות מילה במילה מתוך הקטע. אסור לנסח מחדש.
- ⛔ speaker: **אסור לנחש.** רק אם השם נאמר בקטע עצמו — המנחה פונה אליו בשמו או מציג אותו. אם השם לא מופיע בטקסט — null, גם אם "נראה לך" שאתה יודע מי זה. שם שגוי בכותרת גרוע בהרבה מכותרת בלי שם.
- role: רק אם נאמר בקטע. אחרת null.
- headline: אם הדובר לא מזוהה, נסח בלי שם — "קריאה לוינטר לפרוש" ולא "אוחנה: וינטר צריך לפרוש".
- score: 5 = מבזק (אמירה חריפה/חדשה על דמות או מהלך מרכזי), 4 = כותרת טובה, 3 ומטה = לא לפרסם.

החזר JSON בלבד:
{"headline":"כותרת של עד 12 מילים או null","speaker":null,"role":null,"quote":"ציטוט מדויק או null","score":1}`;

/**
 * נקרא על כל דגימה חדשה. לא חוסם את לולאת הדגימה — רץ ברקע ובולע שגיאות.
 */
async function onChunk({ station, text, ts = Date.now() }) {
  const clean = String(text || '').trim();
  const recentArr = (_prev[station] || []).filter(p => ts - p.ts < 14 * 60 * 1000 && !isAd(p.text));
  _prev[station] = [...recentArr, { ts, text: clean }].slice(-3);
  if (!clean || clean.length < 60) return null;
  if (isAd(clean)) return null;
  if (_busy) return null;            // one at a time; the next chunk carries the context
  _busy = true;
  try {
    // The last three samples from this station, about twelve minutes.
    // 55-second samples cut sentences in half, and an interviewee is
    // introduced once, at the start — the wider the window, the likelier that
    // introduction is in it and the speaker can be named honestly rather than
    // left blank.
    const window = [...recentArr.slice(-2).map(p => p.text), clean].join('\n');

    const claude = require('./claude');
    const r = await claude.classifyJSON(
      `תחנה: ${station}\n\nתמלול:\n${window}`,
      { system: SYSTEM, maxTokens: 400, model: 'claude-haiku-4-5-20251001' }
    );
    if (!r || !r.headline || (r.score || 0) < MIN_SCORE) return null;

    // Verified against the transcript, exactly as the hourly digest does. A
    // spokesperson must never be handed a quote that was tidied up.
    const norm = s => String(s || '').replace(/["'״׳]/g, '').replace(/\s+/g, ' ').trim();
    let quote = r.quote ? String(r.quote).trim() : null;
    if (quote && !norm(window).includes(norm(quote))) {
      logger.info(`📻 headline: dropped unverifiable quote "${norm(quote).substring(0, 40)}…"`);
      quote = null;
    }

    // Enforced here, not only asked for in the prompt. Replaying the Ohana
    // interview, the model named "אמיר אוחנה" as the speaker although the name
    // appears nowhere in the transcript — the host's introduction fell between
    // samples. It happened to be right. A wrong name in a headline handed to a
    // spokesperson is worse than no name, so a name that is not in the text
    // is dropped, and the headline is kept.
    let speaker = r.speaker ? String(r.speaker).trim() : null;
    let role = r.role ? String(r.role).trim() : null;
    let headline = String(r.headline).trim();
    if (speaker) {
      const surname = speaker.split(/\s+/).pop();
      if (!norm(window).includes(norm(surname))) {
        logger.info(`📻 headline: dropped unstated speaker "${speaker}"`);
        if (headline.includes(speaker)) headline = headline.replace(speaker, '').replace(/^[\s:—-]+/, '');
        if (surname && headline.includes(surname)) headline = headline.replace(surname, '').replace(/^[\s:—-]+/, '');
        speaker = null;
        role = null;
      }
    }
    if (role && !norm(window).includes(norm(role.split(/\s+/)[0]))) {
      // The role was inferred from the name, so it goes with it.
      if (!speaker) role = null;
    }

    const list = _load();
    const key = norm(`${speaker || ''} ${headline}`).substring(0, 60);
    // Same story, reworded. Replaying the Ohana interview, 08:15 produced
    // "קריאה להפלת וינטר: הוא מסכן את מחנה הימין" and 08:22 — the same answer,
    // one sample later — "קריאה להפלת וינטר: סכנה לגוש הימיני". An exact-text
    // key let both through, which would have buzzed him twice. Two headlines
    // from one station sharing three meaningful words inside 45 minutes are
    // treated as one story.
    const words = s => new Set(norm(s).split(' ').filter(w => w.length >= 3 && !STOP.has(w)));
    const mine = words(headline);
    const dup = list.find(h => {
      if (ts - h.ts > DEDUPE_MS) return false;
      if (h.key === key) return true;
      if (h.station !== station || ts - h.ts > 45 * 60 * 1000) return false;
      let shared = 0;
      for (const w of words(h.headline)) if (mine.has(w)) shared++;
      return shared >= 3 || (shared >= 2 && mine.size <= 4);
    });
    if (dup) {
      logger.info(`📻 headline: same story as ${new Date(dup.ts).toISOString().substring(11, 16)} — skipped`);
      return null;
    }

    const item = {
      id: `${ts}-${station}`.replace(/[^\w-]/g, ''),
      ts, station,
      headline: headline.substring(0, 140),
      speaker,
      role,
      quote,
      score: r.score,
      key,
      // Kept so the app can open the surrounding transcript on demand.
      context: window.substring(0, 1600),
    };
    list.unshift(item);
    _save(list);
    logger.info(`📻 HEADLINE [${station}] ${item.speaker || '?'}: ${item.headline}`);
    return item;
  } catch (e) {
    logger.warn('headline check: ' + (e.message || '').substring(0, 60));
    return null;
  } finally {
    _busy = false;
  }
}

function recent(n = 30) {
  return _load().slice(0, n);
}

/**
 * התמלול סביב רגע מסוים — לכפתור "פתח הקשר".
 * מחזיר את הדגימות של אותה תחנה בחלון של כמה דקות לפני ואחרי.
 */
function contextAround(ts, station, minutes = 12) {
  const bd = require('./broadcast-digest');
  const from = ts - minutes * 60 * 1000;
  const to = ts + minutes * 60 * 1000;
  return bd.chunksBetween(from, to)
    .filter(c => !station || c.station === station)
    .map(c => ({ ts: c.ts, station: c.station, text: c.text, ad: isAd(c.text) }));
}

module.exports = { onChunk, recent, contextAround, isAd };
