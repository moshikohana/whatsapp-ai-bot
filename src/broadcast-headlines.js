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
const MIN_SCORE = 4;
// ⭐ מי שאמירה עליו לא מפספסים: התקרה השעתית לא חוסמת כותרת שעוסקת בהם (16.9).
const KEY_FIGURES = /(נתניהו|איזנקוט|אייזנקוט|גנץ|ליברמן|וינטר|בן גביר|סמוטריץ|יאיר גולן|בנט|לפיד|דרעי|גולדקנופף|קלנר|הליכוד|עמך ישראל|הציונות הדתית|עוצמה יהודית|ש"ס|יהדות התורה|הדמוקרטים|ישראל ביתנו|כחול לבן)/;          // 1-5; only genuine headlines interrupt him

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

כותרת = אמירה בולטת או התפתחות בנושא **פוליטי, מדיני או ביטחוני**: בחירות, מפלגות, שרים וממשלה, כנסת, מערכת המשפט, צבא ומלחמה, חטופים, מדיניות חוץ — עמדה חריפה, קריאה למישהו לפרוש, התקפה על פוליטיקאי, חשיפה, הכרזה.
כלכלה, צרכנות, תרבות, פשיעה, תאונות ואסונות — כותרת רק כשיש בהם זווית פוליטית (שר, ממשלה, מחדל, חקיקה).

⭐ מה שהכי חשוב: אמירה על אחת הדמויות המרכזיות — נתניהו, איזנקוט, גנץ, ליברמן, וינטר, בן גביר, סמוטריץ, יאיר גולן, בנט, לפיד, דרעי, אריאל קלנר — או על הליכוד, עמך ישראל, הציונות הדתית, עוצמה יהודית ושאר המפלגות. גם כשהאומר הוא מרואיין, פרשן או אלוף במיל: ביקורת, חשיפה, האשמה, תמיכה או הערכה פוליטית עליהם היא כותרת (score 4 לפחות). זו בדיוק המטרה של המעקב — לתפוס בזמן אמת מה נאמר עליהם.

⚠️ הדובר לא חייב להיות מזוהה כדי שזו תהיה כותרת. הקטעים הם דגימות של 55 שניות, ולרוב ההצגה של המרואיין נפלה לפני הדגימה. "וינטר צריך לפרוש, הוא מסכן את מחנה הימין" היא כותרת גם כשלא ברור מי אמר אותה — היא עוסקת בדמויות מוכרות ובעמדה חדה.

לא כותרת: פרסומות, מוזיקה, ספורט, מזג אוויר, תנועה, טיפים צרכניים, שיחת חולין של מנחים, קריינות של מבזק שכבר ידוע.
מנחה שמסכם או מקריא חדשות שכבר פורסמו — לא כותרת. במבזק החדשות של השעה העגולה — כותרת רק אם זו ידיעה חדשה לגמרי, ואז score 5.

⚠️ התמלול אוטומטי ויש בו שגיאות שמיעה — "הערג" במקום "הרג", "פילוג צהל" במקום "פעילות צה"ל". ב-headline כתוב את המילה הנכונה; אל תבנה כותרת על מילה שלא קיימת בעברית.

כללים:
- quote חייב להיות מילה במילה מתוך הקטע. אסור לנסח מחדש.
- ⛔ אל תהפוך מי עושה מה: קרא את המשפט ובדוק מי הנושא. "רונן מנליס… העמדות שלו העמדות יאיר גולן… והוא זה שמנהל את כל הקמפיין" — מנליס מנהל את הקמפיין ועמדותיו כשל יאיר גולן; לא "יאיר גולן מנהל קמפיין".
- about: על מי הידיעה — הדמות או המפלגה שהאמירה עוסקת בהן (נתניהו, איזנקוט, וינטר, הליכוד…), או null.
- ⛔ speaker: **אסור לנחש.** רק אם השם נאמר בקטע עצמו — המנחה פונה אליו בשמו או מציג אותו. אם השם לא מופיע בטקסט — null, גם אם "נראה לך" שאתה יודע מי זה. שם שגוי בכותרת גרוע בהרבה מכותרת בלי שם.
- role: רק אם נאמר בקטע. אחרת null.
- headline: אם הדובר לא מזוהה, נסח בלי שם — "קריאה לוינטר לפרוש" ולא "אוחנה: וינטר צריך לפרוש".
- ⛔ אל תמציא תווית לדובר לא מזוהה — לא "דובר ימין", לא "גורם", לא "פרשן", לא "מרואיין". כתוב את האמירה עצמה, בלי ייחוס.
- score: 5 = מבזק (אמירה חריפה או חדשה על דמות או מהלך מרכזי). 4 = כל אמירה על אחת הדמויות או המפלגות שברשימה למעלה — ביקורת, האשמה, חשיפה, הערכה פוליטית או טענה על מי שעומד מאחוריהם — גם מפי פרשן, מרואיין או אלוף במיל׳, וגם אם היא לא דרמטית. 3 ומטה = דיבור כללי בלי דמות או מפלגה מרכזית, פרשנות על מגמות, או מה שכבר נאמר בקטע קודם.

בנוסף, kind — מה יש בקטע האחרון (הפסקה האחרונה בתמלול): "news" = מהדורה או מבזק, "talk" = דיבור, ראיון, פאנל או מנחה, "music" = שיר או מוזיקה (גם מילים של שיר), "ads" = פרסומות וקדימונים.

בקטע אחד יכולות להיות שתי אמירות נפרדות (למשל ויכוח על מפלגה, ומיד אחריו אמירה על מנהל קמפיין) — החזר את שתיהן, כל אחת בנפרד. עד ארבע, כל אחת ידיעה נפרדת באמת. עדיף להחזיר אחת נוספת מאשר לפספס אמירה על אחת הדמויות.

החזר JSON בלבד:
{"headlines":[{"headline":"כותרת של עד 12 מילים","speaker":null,"role":null,"about":null,"quote":"ציטוט מדויק או null","score":4}],"kind":"news|talk|music|ads"}
אין כותרת — headlines: [].`;

// 🎵 What each station was playing at its last sample — the monitor pauses a
// station that is only playing music (see broadcast-monitor).
const _kind = {};
function lastKind(station) { return _kind[station] || null; }

/**
 * נקרא על כל דגימה חדשה. לא חוסם את לולאת הדגימה — רץ ברקע ובולע שגיאות.
 */
async function onChunk({ station, text, ts = Date.now() }) {
  const out = [];                     // a chunk can yield more than one headline
  const clean = String(text || '').trim();
  const recentArr = (_prev[station] || []).filter(p => ts - p.ts < 20 * 60 * 1000 && !isAd(p.text));
  _prev[station] = [...recentArr, { ts, text: clean }].slice(-4);
  // 55 seconds of speech is 500+ characters; a few words is a song or silence.
  if (!clean || clean.length < 60) { _kind[station] = { ts, kind: 'music' }; return out; }
  if (isAd(clean)) { _kind[station] = { ts, kind: 'ads' }; return out; }
  if (_busy) return out;             // one at a time; the next chunk carries the context
  _busy = true;
  try {
    // The last three samples from this station, about twelve minutes.
    // 55-second samples cut sentences in half, and an interviewee is
    // introduced once, at the start — the wider the window, the likelier that
    // introduction is in it and the speaker can be named honestly rather than
    // left blank.
    const window = [...recentArr.slice(-3).map(p => p.text), clean].join('\n');

    // 📻 Where in the day this is: the round-hour bulletin, or which programme
    // (and its hosts, who are never the "speaker"). See broadcast-schedule.
    let seg = { bulletin: false, name: null, hosts: [], type: 'morning' };
    try { seg = require('./broadcast-schedule').segmentAt(station, ts); } catch (_) {}
    if (seg.type === 'sports' || seg.type === 'music') { _kind[station] = { ts, kind: seg.type === 'music' ? 'music' : 'talk' }; return out; }
    const segLine = seg.bulletin ? 'עכשיו: מבזק החדשות של השעה העגולה'
      : `עכשיו: ${seg.name ? `התוכנית "${seg.name}"` : 'תוכנית'}${seg.type === 'interviews' ? ' (ראיונות)' : ''}` +
        (seg.hosts.length ? `\nמנחי התוכנית (הם לא הדוברים): ${seg.hosts.join(', ')}` : '');

    const claude = require('./claude');
    const r = await claude.classifyJSON(
      `תחנה: ${station}\n${segLine}\n\nתמלול:\n${window}`,
      { system: SYSTEM, maxTokens: 400, model: 'claude-haiku-4-5-20251001' }
    );
    // One line per check. Without it a quiet hour and a broken detector look
    // the same in the log.
    if (r && ['news', 'talk', 'music', 'ads'].includes(r.kind)) _kind[station] = { ts, kind: r.kind };
    const _cands0 = Array.isArray(r && r.headlines) ? r.headlines : (r && r.headline ? [r] : []);
    logger.info(`📻 headline check [${station}${seg.bulletin ? ' · מבזק' : ''}] → ${_cands0.length ? _cands0.map(c => `★${c.score || 0} ${String(c.headline).substring(0, 45)}`).join(' | ') : 'nothing'}${r && r.kind ? ` · ${r.kind}` : ''}`);
    // One chunk can hold two separate statements — an argument about a party,
    // and right after it a line about a campaign manager (103FM 9:44, 15.9:
    // the second, on Eisenkot's manager, was lost). Each is taken on its own.
    const cands = (Array.isArray(r && r.headlines) ? r.headlines : (r && r.headline ? [r] : []))
      .filter(c => c && c.headline && (c.score || 0) >= MIN_SCORE).slice(0, 4);
    if (!cands.length) return out;
    const bulletin = seg.bulletin || r.kind === 'news';
    for (const c of cands) {

    // Verified against the transcript, exactly as the hourly digest does. A
    // spokesperson must never be handed a quote that was tidied up.
    const norm = s => String(s || '').replace(/["'״׳]/g, '').replace(/\s+/g, ' ').trim();
    let quote = c.quote ? String(c.quote).trim() : null;
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
    let speaker = c.speaker ? String(c.speaker).trim() : null;
    let role = c.role ? String(c.role).trim() : null;
    let headline = String(c.headline).trim();
    // An invented label in front of an unknown speaker — "דובר ימין: …" (14.9) — goes.
    if (!c.speaker) {
      const lab = headline.match(/^([^:]{2,30}):\s*/);
      // Only a label that was never said: "דובר צה"ל:" heard on air stays.
      if (lab && !norm(window).includes(norm(lab[1]))) {
        logger.info(`📻 headline: dropped invented label "${lab[1]}"`);
        headline = headline.slice(lab[0].length).trim();
      }
    }
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
    // The host says the guest's name, then asks the question: a host is not the speaker.
    if (speaker && seg.hosts.some(hn => norm(hn).split(' ').pop() === norm(speaker).split(' ').pop())) {
      logger.info(`📻 headline: "${speaker}" is the programme's host — not the speaker`);
      if (headline.startsWith(speaker)) headline = headline.slice(speaker.length).replace(/^[\s:—-]+/, '');
      speaker = null; role = null;
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
    // "באוקטובר" and "ובאוקטובר" are one word: a leading ו/ב/ה/ל/מ/ש/כ is a prefix.
    const same = (a, b) => a === b || (/^[והבלמשכ]/.test(a) && a.slice(1) === b) || (/^[והבלמשכ]/.test(b) && b.slice(1) === a);
    // Six words in a row shared by two quotes — the same sentence heard twice.
    const run = (a, b) => {
      const A = norm(a).split(' '), B = ' ' + norm(b) + ' ';
      for (let i = 0; i + 6 <= A.length; i++) if (B.includes(' ' + A.slice(i, i + 6).join(' ') + ' ')) return true;
      return false;
    };
    const dup = list.find(h => {
      if (ts - h.ts > DEDUPE_MS) return false;
      if (h.key === key) return true;
      if (h.station !== station || ts - h.ts > 45 * 60 * 1000) return false;
      // The same quote is the same story, however differently it was
      // headlined: 09:23 "נתניהו התעלם מהתראות" and 09:31 "נתניהו תעד התראות
      // וזלזל בהן" carried one identical quote and shared only one word.
      // And 10:26 / 10:30 (14.9) — one interview, the second window still
      // holding the first sample: "הייתה כאן הפקרה מודעת של חיי אדם" in both.
      if (quote && h.quote) {
        const a = norm(quote), b = norm(h.quote);
        if (a === b || a.includes(b) || b.includes(a) || run(a, b)) return true;
      }
      let shared = 0;
      for (const w of words(h.headline)) if ([...mine].some(m => same(m, w))) shared++;
      return shared >= 3 || (shared >= 2 && mine.size <= 4);
    });
    if (dup) {
      logger.info(`📻 headline: same story as ${new Date(dup.ts).toISOString().substring(11, 16)} — skipped`);
      continue;
    }

    // 📡 The same story on another station, or hours later (14.9: the Venice
    // film five times in two hours, on three stations). Shared words find the
    // candidates; the model says whether this one adds anything — a new
    // voice, a decision, a fact. Repeating the same stance is not news.
    const hhmm = t => new Date(t).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
    let update = null;
    const mineAll = words(`${headline} ${quote || ''}`);
    const cands = list.filter(h => h.ts < ts && ts - h.ts < 6 * 3600000).map(h => {
      let shared = 0;
      for (const w of words(`${h.headline} ${h.quote || ''}`)) if ([...mineAll].some(m => same(m, w))) shared++;
      return { h, shared, q: !!(quote && h.quote && run(quote, h.quote)) };
    }).filter(c => c.q || c.shared >= 2).sort((a, b) => b.shared - a.shared).slice(0, 3);
    if (cands.length) {
      const v = await claude.classifyJSON(
        `כותרת חדשה (${station} ${hhmm(ts)}): "${headline}"${quote ? `\nציטוט: "${quote}"` : ''}\n\nכותרות קודמות:\n` +
        cands.map((c, i) => `${i + 1}. ${c.h.station} ${hhmm(c.h.ts)}: "${c.h.headline}"${c.h.quote ? ` — "${c.h.quote}"` : ''}`).join('\n'),
        {
          system: 'האם הכותרת החדשה היא אותו סיפור כמו אחת הקודמות — אותו אירוע או אותה מחלוקת שכבר דווחה, גם בניסוח אחר או מפי דובר אחר שחוזר על אותה עמדה? ' +
            'אם כן — האם יש בה חידוש ממשי: דמות חשובה חדשה עם עמדה חדשה, החלטה, צעד, עובדה חדשה? חזרה על אותה טענה או אותה עמדה אינה חידוש. ' +
            'החזר JSON בלבד: {"same": מספר הכותרת הקודמת או 0, "new": "החידוש במשפט קצר, או null"}',
          maxTokens: 150, model: 'claude-haiku-4-5-20251001', temperature: 0,
        });
      const n = v ? parseInt(v.same, 10) : 0;
      if (n >= 1 && n <= cands.length) {
        const orig = cands[n - 1].h;
        if (!v.new) {
          // One entry per station and hour on the original: "✅ גם ב…".
          orig.alsoOn = [...(orig.alsoOn || []).filter(a => !(a.station === station && ts - a.ts < 3600000)), { station, ts }].slice(-8);
          _save(list);
          logger.info(`📻 headline: same story as ${orig.station} ${hhmm(orig.ts)} — "גם ב${station}", not sent`);
          continue;
        }
        update = { of: orig.id, at: orig.ts, station: orig.station, what: String(v.new).substring(0, 160) };
        logger.info(`📻 headline: update to ${orig.station} ${hhmm(orig.ts)} — ${update.what.substring(0, 60)}`);
      }
    }

    // 🎙️ No speaker in the sample: the introduction, minutes back.
    if (!speaker) {
      try {
        const f = await findSpeaker(station, ts, quote || headline);
        if (f) { speaker = f.speaker; role = role || f.role; logger.info(`🎙️ headline speaker found: ${f.speaker} — "${f.evidence.substring(0, 60)}"`); }
      } catch (_) {}
    }

    // 🔎 Checked against the transcript and the apps before it reaches him.
    let confirmed = null, corrected = null;
    try {
      const g = await require('./grounding').ground([{ id: 'h', fields: { headline } }], window,
        { label: 'headline', window: [ts - 3 * 3600000, ts + 60000] });
      if (g[0] && g[0].drop) { logger.info(`📻 headline: dropped — not supported by the broadcast: "${headline.substring(0, 50)}"`); continue; }
      if (g[0]) { headline = g[0].fields.headline || headline; confirmed = g[0].confirmed || null; corrected = g[0].corrected || null; }
    } catch (_) {}

    // 🔕 Kept — in the tab and the hourly summary — but not pushed to him:
    //   bulletin  — the round-hour news repeats what is known; only a scoop (5) interrupts
    //   published — out in the apps or groups 20+ minutes before the radio
    //   cap       — a fifth headline inside the hour, unless it is a 5
    let silent = null, earlier = null;
    if (bulletin && (c.score || 0) < 5) silent = 'bulletin';
    if (!silent) {
      try { earlier = await require('./news-apps').publishedBefore({ headline, quote, speaker, ts }, 20); } catch (_) {}
      if (earlier) silent = 'published';
    }
    const about = c.about ? String(c.about).trim().substring(0, 60) : null;
    const keyOne = KEY_FIGURES.test(`${about || ''} ${headline}`);
    if (!silent && !keyOne && (c.score || 0) < 5 && list.filter(h => h.sentAt && ts - h.sentAt < 3600000).length >= 6) silent = 'cap';

    const item = {
      id: `${ts}-${station}${out.length ? '-' + (out.length + 1) : ''}`.replace(/[^\w-]/g, ''),
      ...(confirmed && confirmed.length ? { confirmed } : {}),
      ...(corrected ? { corrected } : {}),
      ts, station,
      headline: headline.substring(0, 140),
      speaker,
      role,
      quote,
      score: c.score,
      ...(about ? { about } : {}),
      key,
      segment: { bulletin, name: seg.name, type: seg.type },
      ...(update ? { update } : {}),
      ...(silent ? { silent } : {}),
      ...(earlier ? { appsSeen: { [earlier.source]: { ts: earlier.ts, text: earlier.text, leadMin: -earlier.min } } } : {}),
      // Kept so the app can open the surrounding transcript on demand.
      context: window.substring(0, 1600),
    };
    list.unshift(item);
    _save(list);
    // 📻 הרדיו נכנס לחדשות: אמירה באוויר מצטרפת לסיפור ולנושא, ולא נשארת
    // רק בטאב הרדיו (16.9). רק כותרת שנשלחה — שקטה או חוזרת לא מוסיפה רעש.
    if (!silent) {
      try {
        require('./news-apps').addMany([{
          source: `${station} · רדיו`, via: 'radio', ts,
          text: [speaker, headline].filter(Boolean).join(': ').substring(0, 240),
          full: quote || (item.context || '').substring(0, 400) || undefined,
        }]);
      } catch (e) { logger.warn('📻 → news: ' + (e.message || '').substring(0, 50)); }
    }
    logger.info(`📻 HEADLINE [${station}] ${item.speaker || '?'}: ${item.headline}${silent ? ` — not sent (${silent}${earlier ? `: ${earlier.source}, ${earlier.min} min earlier` : ''})` : ''}`);
      out.push(item);
    }
    return out;
  } catch (e) {
    logger.warn('headline check: ' + (e.message || '').substring(0, 60));
    return out;
  } finally {
    _busy = false;
  }
}

function recent(n = 30) {
  return _load().slice(0, n);
}

/**
 * The headline went out to him — when, and as which WhatsApp message. "הרחב"
 * picked the newest *stored* headline, and one stored at 10:30 reached him
 * only at 10:32, after he had asked about another (14.9).
 */
/**
 * כותרות שלא יצאו — רשת ביטחון. ב-15.9 כותרת של 103FM מ-9:44 נשמרה בלי
 * silent ובלי sentAt, כלומר היא נבנתה ופשוט לא הגיעה אליו. עד שלושה נסיונות.
 */
function pendingUnsent(minutes = 45) {
  const now = Date.now();
  return _load().filter(h => !h.silent && !h.sentAt && (h.tries || 0) < 3 && now - h.ts < minutes * 60000);
}
function markTried(id) {
  const list = _load();
  const h = list.find(x => x.id === id);
  if (!h) return;
  h.tries = (h.tries || 0) + 1;
  _save(list);
}

function markSent(id, waId) {
  const list = _load();
  const h = list.find(x => x.id === id);
  if (!h) return;
  h.sentAt = Date.now();
  if (waId) h.waIds = [...(h.waIds || []), waId].slice(-3);
  _save(list);
}

/**
 * Which headline a reply ("הרחב", "שמע", "טיוטה") is about.
 *   quoted — the WhatsApp message he replied to: by its id, then by its bold
 *            headline line; no match is an answer too — never "the newest".
 *   none   — the one sent last, unless two went out within minutes of each
 *            other: then he is asked which.
 * @returns {{ h } | { ask: object[] } | { none: string }}
 */
function forReply({ quotedId = null, quotedBody = null } = {}) {
  const list = _load().slice(0, 60);
  if (quotedId || quotedBody) {
    // By the message key alone — the chat part may come as @lid or @c.us.
    const k = id => String(id || '').split('_')[2] || String(id || '');
    let h = quotedId ? list.find(x => (x.waIds || []).some(w => k(w) === k(quotedId))) : null;
    if (!h && quotedBody) {
      const bold = (String(quotedBody).match(/\n\*([^*\n]{4,160})\*/) || [])[1];
      if (bold) h = list.find(x => String(x.headline).trim() === bold.trim());
      if (!h) h = list.find(x => String(quotedBody).includes(String(x.headline).substring(0, 40)));
    }
    return h ? { h } : { none: 'quoted' };
  }
  const sent = list.filter(x => x.sentAt && Date.now() - x.sentAt < 3 * 3600000)
    .sort((a, b) => b.sentAt - a.sentAt);
  if (!sent.length) return { none: 'recent' };
  const close = sent.filter(x => sent[0].sentAt - x.sentAt < 6 * 60000).slice(0, 4);
  return close.length > 1 ? { ask: close } : { h: sent[0] };
}

/**
 * התמלול סביב רגע מסוים — לכפתור "פתח הקשר".
 * מחזיר את הדגימות של אותה תחנה בחלון של כמה דקות לפני ואחרי.
 */
// 🎙️ The host introduces a guest once — "איתנו על הקו", "שלום ל…", "מצטרף
// אלינו" — and the 55-second sample with the quote comes minutes later, so the
// speaker was always "לא מזוהה" (14.9, 103FM 09:30). The station's last 25
// minutes are searched for an introduction; a name only if it is said there.
const _INTRO = /(איתנו על הקו|על הקו איתנו|איתנו עכשיו|עכשיו איתנו|מצטרף אלינו|מצטרפת אלינו|נמצא איתנו|נמצאת איתנו|איתי באולפן|איתנו באולפן|אורחנו|אורחתנו|שלום ל|בוקר טוב ל|ערב טוב ל|תודה רבה ל|תודה ל|ח"כ|ח״כ|חבר הכנסת|חברת הכנסת|השר |השרה |ראש העיר|פרופסור|ד"ר|עו"ד)/;
async function findSpeaker(station, ts, quote) {
  const chunks = require('./broadcast-digest').chunksBetween(ts - 25 * 60000, ts + 60000)
    .filter(c => c.station === station && !isAd(c.text)).sort((a, b) => a.ts - b.ts);
  const hits = [];
  for (const c of chunks) {
    const parts = c.text.split(/(?<=[.?!])\s+/);
    parts.forEach((p, i) => { if (_INTRO.test(p)) hits.push(`[${new Date(c.ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' })}] ${[parts[i - 1], p, parts[i + 1]].filter(Boolean).join(' ')}`); });
  }
  if (!hits.length) return null;
  const r = await require('./claude').classifyJSON(
    `קטעים מהשידור שבהם מוצג מישהו:\n${hits.slice(-8).join('\n').substring(0, 3000)}\n\nהציטוט (נאמר אחר כך): "${String(quote || '').substring(0, 300)}"`,
    {
      system: 'מי אמר את הציטוט? רק אם שמו נאמר בקטעים במפורש — הוצג, קיבל "שלום", או שפנו אליו בשמו — ורק אם סביר שזה הוא שמדבר בציטוט (האורח האחרון שהוצג לפניו). אל תנחש ואל תשלים מהידע שלך. ' +
        'החזר JSON בלבד: {"speaker":"שם כפי שנאמר או null","role":"תפקיד כפי שנאמר או null","evidence":"המשפט שבו הוצג"}',
      maxTokens: 200, model: 'claude-haiku-4-5-20251001', temperature: 0,
    });
  if (!r || !r.speaker) return null;
  const norm = s => String(s || '').replace(/["'״׳]/g, '').replace(/\s+/g, ' ').trim();
  // The code checks the name is really there.
  const surname = norm(r.speaker).split(' ').pop();
  if (!surname || !norm(hits.join(' ')).includes(surname)) return null;
  return { speaker: String(r.speaker).substring(0, 60), role: r.role ? String(r.role).substring(0, 60) : null, evidence: String(r.evidence || '').substring(0, 200) };
}

function contextAround(ts, station, minutes = 12) {
  const bd = require('./broadcast-digest');
  const from = ts - minutes * 60 * 1000;
  const to = ts + minutes * 60 * 1000;
  return bd.chunksBetween(from, to)
    .filter(c => !station || c.station === station)
    .map(c => ({ ts: c.ts, station: c.station, text: c.text, ad: isAd(c.text) }));
}

const EXPAND_SYSTEM = `אתה עורך חדשות. קיבלת כותרת שנקלטה ברדיו, ואת התמלול סביבה.
התמלול הוא דגימות של 55 שניות כל 4 דקות — יש חורים, ומשפטים נחתכים.

החזר JSON בלבד:
{"story":"2-4 משפטים בעברית עיתונאית: מה נאמר ומי אמר — 'המרואיינת, מירב, אמרה ש…', לא 'לטענת המדברים'",
 "speakers":[{"name":"שם כפי שנאמר, או 'המנחה' / 'המרואיין' / 'המרואיינת' כשאין שם","role":"תפקיד אם נאמר, אחרת null","said":"מה אמר/ה בשידור — פרפרזה קצרה"}],
 "mentioned":[{"name":"שם כפי שנאמר","about":"מה נאמר עליו או ציטוט שיוחס לו — כטענה של הדובר"}],
 "quotes":["ציטוט מדויק, מילה במילה מהתמלול, 8-30 מילים"],
 "background":"הקשר קצר שעולה מהתמלול, או null",
 "unclear":"משפט אחד: מה לא ברור בגלל החורים בדגימה, או null"}

🎯 רק הסיפור של הכותרת. התמלול הוא רבע שעה, ולרוב יש בו עוד ידיעות מאותה מהדורה או נושאים אחרים בתוכנית — השמט אותם לגמרי (לא ב-story, לא ב-speakers, לא ב-mentioned). אבל על הסיפור עצמו — כל הפרטים שנאמרו: מי, מה, איפה, למי פנו, מה נענה.
speakers = רק מי שמדבר בשידור עצמו על הסיפור הזה. מי שמדברים עליו או מצטטים אותו — ב-mentioned, לא ב-speakers. גוף (מפלגה, ארגון) — לא אדם; אל תכתוב אותו כאדם.
שמות מפלגות בתמלול משתבשים: "ראם" / "רם" ליד "הרשימה המשותפת" = רע"מ.
⛔ שם אדם רק אם הוא מופיע בתמלול. אסור להשלים ממה שאתה יודע מבחוץ. כתוב את השם כפי שנשמע — לא "גורם בשם X".
⛔ ציטוט רק אם הוא מופיע בתמלול כלשונו. עדיף פחות ציטוטים מציטוט לא מדויק.
⛔ מראיין ששואל שאלה אינו "אמר" את תוכן השאלה.
⛔ התמלול אוטומטי ויש בו שיבושי שמיעה ("השיבה באוקטובר" = "השבעה באוקטובר") — ב-story וב-said כתוב עברית תקינה; ב-quotes השאר כלשונו.`;

/**
 * "הרחב" — מי אמר מה, סביב כותרת.
 *
 * הכותרת היא שורה אחת; מאחוריה יש ראיון של כמה דקות. כאן נקרא כל התמלול
 * שנשמר סביב הרגע (רבע שעה לכל כיוון, כולל מה שנקלט אחריו) ומסוכם לסיפור,
 * לאנשים ולמה שכל אחד אמר. אותם כללי אימות כמו בכותרת: שם שלא נאמר באוויר
 * יורד, וציטוט שלא נמצא בתמלול יורד.
 */
async function expand(id) {
  const list = _load();
  const h = list.find(x => x.id === id);
  if (!h) { const e = new Error('headline not found'); e.code = 'NOT_FOUND'; throw e; }
  // The interview may have gone on after the headline was sent; a cached
  // answer from the first minutes is refreshed once more has been recorded.
  // (Answers from before speakers and the mentioned were apart are redone.)
  if (h.expansion && h.expansion.speakers && h.expansion.ts - h.ts > 20 * 60 * 1000) return h.expansion;

  const chunks = contextAround(h.ts, h.station, 15).filter(c => !c.ad);
  const text = chunks.map(c => c.text).join('\n');
  if (text.length < 80) { const e = new Error('no transcript'); e.code = 'NO_TRANSCRIPT'; throw e; }

  const claude = require('./claude');
  const r = await claude.classifyJSON(
    `כותרת: ${h.headline}\nתחנה: ${h.station}\n\nתמלול:\n${text.substring(0, 9000)}`,
    { system: EXPAND_SYSTEM, maxTokens: 1800 }
  );
  if (!r || !r.story) { const e = new Error('analysis failed'); e.code = 'ANALYSIS_FAILED'; throw e; }

  const norm = s => String(s || '').replace(/["'״׳.,!?:;\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  const hay = norm(text);
  const surname = n => norm(n).split(' ').filter(w => w.length >= 2).pop() || '';
  // "המנחה", "המרואיינת" — a description, not a name; nothing to check.
  const _desc = /^(ה?מנח(ה|ת)|ה?מרואיי?נ(ת)?|ה?מאזינ(ה)?|ה?כתב(ת)?|ה?פרשנ(ית)?)$/;
  const named = n => n && (_desc.test(norm(n)) || (surname(n) && hay.includes(surname(n))));
  // Older answers had a single "who" list; it is read as speakers.
  const speakers = (Array.isArray(r.speakers) ? r.speakers : Array.isArray(r.who) ? r.who : [])
    .filter(w => w && named(w.name)).slice(0, 5)
    .map(w => ({ name: String(w.name).substring(0, 40), role: w.role ? String(w.role).substring(0, 60) : null, said: String(w.said || '').substring(0, 240) }));
  const mentioned = (Array.isArray(r.mentioned) ? r.mentioned : [])
    .filter(w => w && w.name && !_desc.test(norm(w.name)) && named(w.name)).slice(0, 4)
    .map(w => ({ name: String(w.name).substring(0, 40), about: String(w.about || '').substring(0, 240) }));
  const x = {
    ts: Date.now(),
    story: String(r.story).substring(0, 700),
    speakers, mentioned,
    // The app reads one list: speakers, then those mentioned, marked as such.
    who: [...speakers, ...mentioned.map(m => ({ name: m.name, role: 'מוזכר בשידור', said: m.about }))],
    quotes: (Array.isArray(r.quotes) ? r.quotes : [])
      .filter(q => q && norm(q).length >= 12 && hay.includes(norm(q)))
      .slice(0, 3),
    background: r.background ? String(r.background).substring(0, 300) : null,
    unclear: r.unclear ? String(r.unclear).substring(0, 200) : null,
    span: chunks.length ? { from: chunks[0].ts, to: chunks[chunks.length - 1].ts, samples: chunks.length } : null,
  };
  const asked = (r.speakers || r.who || []).length + (r.mentioned || []).length + (r.quotes || []).length;
  const dropped = asked - speakers.length - mentioned.length - x.quotes.length;
  if (dropped > 0) logger.info(`📻 expand: dropped ${dropped} unverified name/quote(s)`);

  h.expansion = x;
  _save(list);
  return x;
}

/**
 * הפירוט כהודעת וואטסאפ.
 *
 * It opens with *which* headline it expands — station, date and time — so a
 * reply that landed on the wrong one is obvious at a glance; then who is on
 * air, apart from who is only talked about ("גורם בשם דרמר" sat among the
 * speakers, 14.9).
 */
function formatExpansion(h, x) {
  const tz = { timeZone: 'Asia/Jerusalem' };
  const t = ts => new Date(ts).toLocaleTimeString('he-IL', { ...tz, hour: '2-digit', minute: '2-digit' });
  const d = ts => new Date(ts).toLocaleDateString('he-IL', { ...tz, day: 'numeric', month: 'numeric' });
  const who = [h.speaker, h.role].filter(Boolean).join(', ');
  const parts = [
    `🔎 *הרחבה לכותרת:*`,
    `*${h.headline}*`,
    `📻 ${h.station} · ${d(h.ts)} · ${t(h.ts)}${who ? ` · 🎙️ ${who}` : ''}`,
    '', `*מה נאמר:*`, x.story,
  ];
  const speakers = x.speakers || x.who || [];
  if (speakers.length) {
    parts.push('', '*🎙️ מדברים בשידור:*');
    for (const w of speakers) parts.push(`• *${w.name}*${w.role ? ` (${w.role})` : ''} — ${w.said}`);
  }
  if ((x.mentioned || []).length) {
    parts.push('', '*👤 מוזכרים (לא מדברים):*');
    for (const m of x.mentioned) parts.push(`• *${m.name}* — ${m.about}`);
  }
  if (x.quotes.length) {
    parts.push('', '*💬 מילה במילה מהאוויר:*');
    for (const q of x.quotes) parts.push(`"${q}"`);
  }
  if (x.background) parts.push('', `📌 ${x.background}`);
  if (x.unclear) parts.push('', `⚠️ ${x.unclear}`);
  if (x.span) parts.push('', `_מתוך ${x.span.samples} דגימות של 55 שניות, ${t(x.span.from)}–${t(x.span.to)} · ענה *שמע* לקטע עצמו_`);
  return parts.join('\n');
}

module.exports = { pendingUnsent, markTried, findSpeaker, lastKind, onChunk, recent, markSent, forReply, contextAround, isAd, expand, formatExpansion };
