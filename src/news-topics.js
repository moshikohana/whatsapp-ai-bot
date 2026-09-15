'use strict';
/**
 * 🧵 נושאים — עלילה אחת מעל הידיעות.
 *
 * ידיעה (news-apps) היא אירוע אחד: אמירה, או תגובה. נושא הוא השרשרת:
 * וינטר האשים את הליכוד בחוקרים פרטיים → הליכוד: "נגיש תביעת דיבה" →
 * ליברמן הגיב → וינטר הסתייג. ב-15.9 זה היה שש ידיעות נפרדות, 45 מקורות,
 * בלי שום קשר ביניהן.
 *
 * שני שלבים, לפי מה שביקש (15.9):
 *  1. קיבוץ — אוטומטי: Sonnet כל 20 דקות, רק כשיש ידיעות חדשות (Haiku,
 *     בניסיון, פיצל את פרשת וינטר ופתח "נושאים" שהם קטגוריות).
 *     משייך ידיעה לנושא קיים או פותח נושא כשיש שרשרת (אמירה ← תגובה).
 *  2. הסיפור — רק כשהוא פותח נושא או מבקש: ציר זמן, ציטוטים מדויקים
 *     (נבדקים בקוד מול הפוסט), איך כל צד הציג, מה פתוח.
 * התראה על שלב חדש — רק לנושאים שסימן "עקוב".
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const FILE = path.join(__dirname, '..', 'data', 'news-topics.json');
const WINDOW_H = 36;          // stories considered for grouping
const KEEP_H = 72;            // a topic with nothing new for this long is closed
const CATS = new Set(['פוליטיקה', 'ביטחון', 'פנים ישראל']);

let _db = null;
function _load() {
  if (_db) return _db;
  try { _db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { _db = { topics: [], seen: {} }; }
  _db.topics = _db.topics || []; _db.seen = _db.seen || {};
  return _db;
}
function _save() {
  try { fs.writeFileSync(FILE, JSON.stringify(_load(), null, 1)); } catch (e) { logger.warn('🧵 topics save: ' + e.message); }
}
const _hhmm = t => new Date(t).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
const _id = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

/** The stories of a topic, as news-apps groups them now (merges move items between stories). */
// Sets, kept per topic: with arrays the topics list took 11s (15.9).
const _setOf = t => { if (!t._set || t._setN !== (t.members || []).length) { Object.defineProperty(t, '_set', { value: new Set(t.members || []), writable: true, enumerable: false, configurable: true }); Object.defineProperty(t, '_setN', { value: (t.members || []).length, writable: true, enumerable: false, configurable: true }); } return t._set; };
function _storiesOf(t, all) {
  const mine = _setOf(t);
  return all.filter(s => (s.memberIds || []).some(id => mine.has(id))).sort((a, b) => a.firstTs - b.firstTs);
}
function _topicOf(s, topics) {
  return topics.find(t => { const m = _setOf(t); return (s.memberIds || []).some(id => m.has(id)); });
}
function _addStory(t, s) {
  const m = new Set(t.members || []);
  for (const id of s.memberIds || []) m.add(id);
  t.members = [...m];
}
const _srcCount = s => Object.keys(s.apps || {}).length;
// An actor's name as it is written in the stories — the model wrote "יאיר
// ליברמן" (Avigdor, next to Yair Golan) in the 15.9 trial. Not there — out.
function _grounded(actors, stories) {
  const hay = stories.map(s => `${s.title} ${Object.values(s.texts || {}).join(' ')} ${s.find || ''}`).join(' ').replace(/["״׳']/g, '');
  return (actors || []).map(a => String(a).replace(/["״׳']/g, '').trim()).filter(a => a.length >= 2 && hay.includes(a)).slice(0, 6);
}

// ── 1. קיבוץ ─────────────────────────────────────────────────────
const GROUP_SYSTEM = `אתה עורך חדשות פוליטי. לפניך נושאים פתוחים (T) וידיעות (S) מהשעות האחרונות.
"נושא" הוא עלילה אחת שמתפתחת: אמירה או מעשה של מישהו, ותגובות אליה — תגובה, הכחשה, איום בתביעה, הסתייגות, תגובה לתגובה. למשל: "וינטר האשים את הליכוד בחוקרים פרטיים" ← "הליכוד: נגיש תביעת דיבה" ← "ליברמן מגיב לוינטר" ← "וינטר: לא זו הייתה הכוונה".
נושא הוא לא קטגוריה כללית ("הבחירות", "איראן", "מערכת המשפט") — הוא עימות או פרשה ספציפיים בין שחקנים מסוימים.
גם סדרה של אירועים קשורים בזמן קצר היא נושא: גל חיסולים של מפקדים באותו ארגון ובאותה זירה (מג"ד ג'באליה ← מח"ט רפיח ← מח"ט ח'אן יונס), מבצע או מצוד מתגלגל, אירוע ביטחוני שמתפתח (תקיפה ← זיהוי היעד ← אישור החיסול ← תגובת הארגון). אבל לא כל תקיפה בודדת, ולא "תקיפות בעזה" באופן כללי.
גם עלילה קטנה היא נושא: הודעה ואחריה ביטול, דחייה או שינוי ("נתניהו יגיע מחר לסיור בחירות בבית שאן" ← "בוטל ביקור רה"מ מחר בבית שאן"), גם ממקור אחד.
1. לכל ידיעה S ששייכת בבירור לנושא פתוח T — שייך אותה.
2. פתח נושא חדש רק כשיש לפחות 2 ידיעות S שהן שרשרת (אחת מגיבה לשנייה, או שתיהן חלק מאותה פרשה) — לא שתי אמירות נפרדות של אותו אדם על דברים שונים.
3. ידיעה שלא שייכת לשום עלילה — השאר אותה בחוץ. עדיף להשאיר בחוץ מאשר לשייך בכוח.
כותרת לנושא: קצרה, מי נגד מי ועל מה ("וינטר נגד הליכוד: חוקרים פרטיים ותביעת דיבה"). actors: השחקנים המרכזיים (אנשים/מפלגות).
החזר JSON בלבד: {"assign":[{"s":מספר,"t":"T1"}],"new":[{"title":"...","actors":["..."],"s":[מספרים]}]}`;

let _busy = false;
const GROUP_MODEL = 'claude-sonnet-4-6';   // Haiku split the Winter affair and made "topics" of categories (15.9 trial)
async function group({ dry = false, model = GROUP_MODEL, fresh = false } = {}) {
  if (_busy && !dry) return { skipped: true };
  if (!dry) _busy = true;
  try {
    const db = dry ? JSON.parse(JSON.stringify(_load())) : _load();
    if (fresh) db.topics = [];
    const na = require('./news-apps');
    const all = na.latest(WINDOW_H, 3000);
    const now = Date.now();
    // Topics still alive: something new within KEEP_H.
    const open = db.topics.filter(t => !t.closed && now - (t.updated || t.created) < KEEP_H * 3600000);
    for (const t of db.topics) if (!t.closed && now - (t.updated || t.created) >= KEEP_H * 3600000) t.closed = true;
    // Not in a topic yet, political enough. Stories already looked at stay in the
    // list: the reaction that makes one of them a chain may come hours later.
    const cands = all.filter(s => !_topicOf(s, db.topics) && (CATS.has(s.cat) || !s.cat)
      && now - s.last < 12 * 3600000)   // one source too: "נתניהו יגיע לבית שאן" ← "הביקור בוטל" came from one channel (15.9)
      .sort((a, b) => a.firstTs - b.firstTs).slice(-130);
    if (!dry && !cands.some(s => !db.seen[s.id])) return { assigned: 0, created: 0 };
    const tList = open.map((t, i) => {
      const st = _storiesOf(t, all).slice(-3).map(s => `${_hhmm(s.firstTs)} ${s.title.substring(0, 90)}`).join(' | ');
      return `T${i + 1}: ${t.title}${st ? ` — אחרונות: ${st}` : ''}`;
    }).join('\n');
    const sList = cands.map((s, i) => `S${i + 1} [${_hhmm(s.firstTs)}] (${_srcCount(s)} מקורות) ${s.title.substring(0, 120)}`).join('\n');
    const r = await require('./claude').classifyJSON(`נושאים פתוחים:\n${tList || '(אין)'}\n\nידיעות:\n${sList}`,
      { system: GROUP_SYSTEM, maxTokens: 2500, model, temperature: 0 });
    if (!r) return { error: 'model' };
    // A trial: what it would do, nothing saved.
    if (dry) {
      const S = x => cands[(+String(x).replace(/\D/g, '') || 0) - 1];
      return {
        assign: (r.assign || []).map(a => ({ topic: (open[(+String(a.t).replace(/\D/g, '') || 0) - 1] || {}).title, story: (S(a.s) || {}).title })),
        created: (r.new || []).map(n => ({ title: n.title, stories: (n.s || []).map(x => { const s = S(x); return s ? `${_hhmm(s.firstTs)} (${_srcCount(s)}) ${s.title.substring(0, 80)}` : null; }).filter(Boolean) })),
        candidates: cands.length,
      };
    }
    for (const s of cands) db.seen[s.id] = (db.seen[s.id] || 0) + 1;
    const grown = new Map();   // topic → new stories, for the alert
    let assigned = 0, created = 0;
    const used = new Set();
    // What a topic is about, in words: its title and its stories' headlines.
    const about = t => `${t.title} ${_storiesOf(t, all).map(s => s.title).join(' ')}`;
    for (const a of (r.assign || [])) {
      const s = cands[(+String(a.s).replace(/\D/g, '') || 0) - 1];
      const t = open[(+String(a.t).replace(/\D/g, '') || 0) - 1];
      if (!s || !t || used.has(s.id)) continue;
      // Two words in common at least — one name is not enough: "נתניהו יגיע
      // לבית שאן" went into "הרמטכ"ל לנתניהו: חמאס הובס" (15.9).
      if (na.overlap(s.title, about(t)) < 2.5) { logger.info(`🧵 assignment refused: "${s.title.substring(0, 40)}" ↛ "${t.title.substring(0, 40)}"`); continue; }
      used.add(s.id); _addStory(t, s); t.updated = Math.max(t.updated || 0, s.last); assigned++;
      if (!grown.has(t)) grown.set(t, []);
      grown.get(t).push(s);
    }
    for (const n of (r.new || [])) {
      const ss = (n.s || []).map(x => cands[(+String(x).replace(/\D/g, '') || 0) - 1]).filter(s => s && !used.has(s.id));
      if (ss.length < 2 || !n.title) continue;
      // The same as an open topic ("מח"ט רפיח ומפקד גדוד ג'באליה" twice, 15.9) — join it.
      const twin = open.find(t => na.overlap(`${n.title} ${ss.map(s => s.title).join(' ')}`, about(t)) >= 4.5 && na.overlap(n.title, t.title) >= 3);
      if (twin) {
        for (const s of ss) { used.add(s.id); _addStory(twin, s); twin.updated = Math.max(twin.updated || 0, s.last); }
        if (!grown.has(twin)) grown.set(twin, []);
        grown.get(twin).push(...ss); assigned += ss.length;
        logger.info(`🧵 new topic joined to "${twin.title.substring(0, 40)}": "${String(n.title).substring(0, 40)}"`);
        continue;
      }
      const t = { id: _id(), title: String(n.title).substring(0, 120), actors: _grounded(n.actors, ss), members: [], created: now, updated: 0, followed: false };
      for (const s of ss) { used.add(s.id); _addStory(t, s); t.updated = Math.max(t.updated, s.last); }
      db.topics.push(t); created++;
      logger.info(`🧵 new topic: "${t.title}" (${ss.length} stories)`);
    }
    // Keep the seen map small.
    for (const k of Object.keys(db.seen)) if (!all.some(s => s.id === k)) delete db.seen[k];
    _save();
    for (const [t, ss] of grown) if (t.followed) _alert(t, ss);
    if (assigned || created) logger.info(`🧵 topics: ${assigned} stories added, ${created} new topics`);
    return { assigned, created };
  } catch (e) { logger.warn('🧵 group: ' + (e.message || '').substring(0, 80)); return { error: e.message }; }
  finally { if (!dry) _busy = false; }
}

function _alert(t, ss) {
  const s = ss[ss.length - 1];
  try {
    require('./jarvis-api').pushAlert({
      title: `🧵 התפתחות: ${t.title}`.substring(0, 120),
      body: ss.map(x => `• ${_hhmm(x.firstTs)} ${x.title}`).join('\n'),
      summary: s.title.substring(0, 140), kind: 'news', urgency: 'normal',
    });
  } catch (_) {}
}

// ── 2. הסיפור ────────────────────────────────────────────────────
const WRITE_SYSTEM = `אתה עורך חדשות. לפניך פוסטים ממקורות שונים (P1, P2…, עם שם המקור והשעה) שהם עלילה אחת.
כתוב את הסיפור כ-JSON:
- title: כותרת קצרה — מי נגד מי ועל מה.
- summary: משפט אחד: מה קרה עד עכשיו.
- steps: השלבים לפי סדר הזמן — עד 12. כל שלב הוא אירוע אחד של שחקן אחד (אמירה, תגובה, הכחשה); פוסטים על אותו אירוע מאחדים לשלב אחד, אבל אמירות של שחקנים שונים — שלבים נפרדים, גם כשהן באותו פוסט. תגובה, איום בתביעה או הכחשה של צד אחר הם שלב משלהם. אם יש יותר מ-12 — השמט את הפחות חשובים (פרשנויות, סקרים, רקע ישן), אל תאחד. הכחשה או הסתייגות של מי שאמר את הדברים חשובה תמיד. לכל שלב: p — מספרי הפוסטים שהשלב מבוסס עליהם; label — אחת מ: רקע, אמירה, האשמה, תגובה, הכחשה, איום, הסתייגות, פעולה, אישור, התפתחות; who — מי; what — משפט אחד, מה נאמר או קרה, קרוב לניסוח הפוסט; quote — ציטוט מדויק, מילה במילה, מתוך אחד הפוסטים שב-p (העתק בדיוק, בלי לתקן ובלי לחבר קטעים), או null.
- framing: איך מקורות שונים הציגו את זה — רק כשזה ניכר בפוסטים עצמם. לכל אחד: side (למשל "ערוצי ימין", "ערוץ 14"), how (משפט אחד), p — הפוסטים שמראים את זה, quote — משפט מדויק מאחד מהם שמדגים את ההצגה. בלי ציטוט כזה — אל תכתוב. אם אין הבדל ניכר — מערך ריק.
- open: 1–3 שאלות פתוחות או מה צפוי, רק ממה שעולה מהפוסטים (למשל "האם הליכוד יגיש את התביעה?").
⚠️ רק מה שכתוב בפוסטים. אל תוסיף שמות, תארים, מספרים, מקומות או מניעים שאין בהם. תארים בדיוק כמו בפוסט. אל תייחס דבר למקור שלא כתב אותו.
החזר JSON בלבד: {"title":"...","summary":"...","steps":[{"p":[1],"label":"...","who":"...","what":"...","quote":"..."|null}],"framing":[{"side":"...","how":"...","p":[1],"quote":"..."}],"open":["..."]}`;

const _qn = s => String(s || '').replace(/["'״׳“”„`]/g, '').replace(/[.,!?:;()\-–—*_]/g, ' ').replace(/\s+/g, ' ').trim();
/** The post (among these) that has the quote word for word. */
function _quoteHit(quote, posts) {
  const q = _qn(quote);
  if (q.split(' ').length < 3) return null;
  return posts.find(p => _qn(p.text).includes(q)) || null;
}

async function write(id, { force = false } = {}) {
  const db = _load();
  const t = db.topics.find(x => x.id === id);
  if (!t) return null;
  const na = require('./news-apps');
  const all = na.latest(48, 3000);
  const stories = _storiesOf(t, all);
  if (!stories.length) return { topic: t, stories: [], doc: t.doc || null };
  const sig = stories.map(s => s.id + ':' + (s.memberIds || []).length).join(',');
  if (!force && t.doc && t.docSig === sig) return { topic: t, stories, doc: t.doc };
  // The posts, numbered, in time order — from each story the ones that add
  // something: the first four by source missed the Likud's "נגיש תביעת דיבה",
  // which sat after Winter's accusations in the same story (15.9).
  const posts = [];
  const toks = s => new Set(_qn(s).split(' ').filter(w => w.length >= 3));
  const same = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.max(1, Math.min(a.size, b.size)); };
  for (const s of stories) {
    const d = na.story(s.id);
    const mem = ((d && d.members) || []).filter(m => (m.full || m.text)).sort((a, b) => a.ts - b.ts);
    const pick = [];
    // The news apps' headlines first — they often hold both sides in a line
    // ("ההאשמות של וינטר, והזעם בליכוד: נגיש תביעת דיבה") — then what is new.
    for (const m of [...mem.filter(x => x.via === 'app'), ...mem.filter(x => x.via !== 'app')]) {
      if (pick.length >= 8) break;
      const tk = toks(m.full || m.text);
      if (pick.some(p => same(p.tk, tk) >= 0.6)) continue;
      pick.push({ m, tk });
    }
    for (const { m } of pick) posts.push({ story: s.id, source: m.source, ts: m.ts, text: String(m.full || m.text) });
  }
  // Too many for one call: the first post of every story stays, then the rest in order.
  if (posts.length > 100) {
    const keep = new Set(stories.map(s => posts.find(p => p.story === s.id)).filter(Boolean));
    for (const p of posts) { if (keep.size >= 100) break; keep.add(p); }
    posts.splice(0, posts.length, ...posts.filter(p => keep.has(p)));
  }
  posts.sort((a, b) => a.ts - b.ts);
  const input = posts.map((p, i) => `P${i + 1} — ${p.source} (${_hhmm(p.ts)}): ${p.text.replace(/\s+/g, ' ').substring(0, 450)}`).join('\n');
  const r = await require('./claude').classifyJSON(input, { system: WRITE_SYSTEM, maxTokens: 8000, model: 'claude-sonnet-4-6', temperature: 0 });
  if (!r || !Array.isArray(r.steps)) return { topic: t, stories, doc: t.doc || null, error: 'model' };
  const g = require('./grounding');
  const P = list => (list || []).map(n => posts[(+String(n).replace(/\D/g, '') || 0) - 1]).filter(Boolean);
  const corpus = posts.map(p => p.text).join('\n');
  // 1. Each step against its own posts: the quote word for word, the words in them.
  const draft = [];
  for (const st of r.steps) {
    const own = P(st.p);
    let quote = st.quote ? String(st.quote).trim() : null, qHit = null;
    if (quote) {
      qHit = _quoteHit(quote, own) || _quoteHit(quote, posts);
      if (!qHit) { logger.info(`🧵 quote dropped (not in the posts): "${quote.substring(0, 50)}"`); quote = null; }
    }
    const base = own.length ? own : (qHit ? [qHit] : []);
    if (!base.length) { logger.info(`🧵 step dropped (no posts cited): "${String(st.what).substring(0, 50)}"`); continue; }
    draft.push({ st, own: base, quote, qHit, miss: g.missingWords(`${st.who || ''} ${st.what || ''}`, base.map(p => p.text).join('\n')) });
  }
  // 2. Words the posts do not have — the step is written again from its posts
  //    (dropping it lost the Likud's "why only now?" in the first trial).
  const flagged = draft.filter(d => d.miss.length >= 3);
  const sumMiss = g.missingWords(String(r.summary || ''), corpus);
  if (flagged.length || sumMiss.length >= 4) {
    const items = flagged.map((d, i) => `${i + 1}. פוסטים:\n${d.own.map(p => `   ${p.source}: ${p.text.replace(/\s+/g, ' ').substring(0, 500)}`).join('\n')}\n   who: ${d.st.who}\n   what: ${d.st.what}\n   מילים שאין בפוסטים: ${d.miss.join(', ')}`);
    if (sumMiss.length >= 4) items.push(`S. הפוסטים: כל האמורים למעלה\n   summary: ${r.summary}\n   מילים שאין בפוסטים: ${sumMiss.join(', ')}`);
    const fx = await require('./claude').classifyJSON(items.join('\n\n'), {
      system: 'לכל פריט: כתוב מחדש את who ו-what (או את summary בפריט S) רק לפי הפוסטים שלו — בלי שום פרט, שם, תואר או מניע שאין בהם, במילים של הפוסט עצמו, לא בפעלים משלך ("אמר שיגיש" כשבפוסט "נגיש" — כתוב "נגיש"). החזר JSON בלבד: {"items":[{"n":מספר או "S","who":"...","what":"..."}]}',
      maxTokens: 3000, model: 'claude-sonnet-4-6', temperature: 0,
    });
    for (const f of ((fx && fx.items) || [])) {
      if (String(f.n) === 'S') { if (f.what) r.summary = f.what; continue; }
      const d = flagged[(+f.n || 0) - 1];
      if (d && f.what) { d.st.who = f.who || d.st.who; d.st.what = f.what; d.miss = g.missingWords(`${d.st.who} ${d.st.what}`, d.own.map(p => p.text).join('\n')); }
    }
  }
  const steps = [];
  for (const d of draft) {
    if (d.miss.length >= (d.quote ? 6 : 3)) { logger.info(`🧵 step dropped (not in the posts: ${d.miss.join(', ')}): "${String(d.st.what).substring(0, 50)}"`); continue; }
    const ss = stories.filter(s => d.own.some(p => p.story === s.id));
    const first = d.own.slice().sort((a, b) => a.ts - b.ts)[0];
    steps.push({
      label: String(d.st.label || 'התפתחות').substring(0, 20), who: String(d.st.who || '').substring(0, 60), what: String(d.st.what || '').substring(0, 300),
      quote: d.quote ? d.quote.substring(0, 400) : null, quoteSrc: d.qHit ? d.qHit.source.substring(0, 60) : null,
      // When it was reported — its own posts, not the story's earliest item.
      ts: first.ts, stories: ss.map(s => s.id),
      sources: new Set(ss.flatMap(s => Object.keys(s.apps || {}))).size,
      firstSource: first.source,
    });
  }
  steps.sort((a, b) => a.ts - b.ts);
  // 3. How each side told it — only with a sentence from that source that shows it.
  const framing = [];
  for (const f of (r.framing || [])) {
    if (!f || !f.side || !f.how || !f.quote) continue;
    const hit = _quoteHit(f.quote, P(f.p));
    if (!hit) { logger.info(`🧵 framing dropped (quote not in its posts): "${String(f.how).substring(0, 50)}"`); continue; }
    framing.push({ side: String(f.side).substring(0, 40), how: `${String(f.how).substring(0, 260)} — ״${String(f.quote).substring(0, 160)}״ (${hit.source})` });
    if (framing.length >= 4) break;
  }
  const doc = {
    title: String(r.title || t.title).substring(0, 120), summary: String(r.summary || '').substring(0, 400), steps, framing,
    open: (r.open || []).slice(0, 3).map(x => String(x).substring(0, 200)),
    at: Date.now(),
  };
  const fresh = _load().topics.find(x => x.id === id);
  if (fresh) { fresh.doc = doc; fresh.docSig = sig; if (doc.title) fresh.title = doc.title; _save(); }
  logger.info(`🧵 written: "${doc.title}" — ${steps.length} steps from ${stories.length} stories`);
  return { topic: fresh || t, stories, doc };
}

// ── API helpers ──────────────────────────────────────────────────
function list() {
  const all = require('./news-apps').latest(48, 3000);
  const now = Date.now();
  return _load().topics.filter(t => !t.closed && now - (t.updated || t.created) < KEEP_H * 3600000).map(t => {
    const ss = _storiesOf(t, all);
    return {
      id: t.id, title: t.title, actors: t.actors || [], followed: !!t.followed,
      steps: ss.length, sources: new Set(ss.flatMap(s => Object.keys(s.apps || {}))).size,
      first: ss.length ? ss[0].firstTs : t.created, last: ss.length ? Math.max(...ss.map(s => s.last)) : t.updated,
      latest: ss.length ? ss[ss.length - 1].title : null,
      written: !!t.doc, stale: !!t.doc && t.docSig !== ss.map(s => s.id + ':' + (s.memberIds || []).length).join(','),
      img: (ss.slice().reverse().find(s => s.img) || {}).img || null, video: ss.some(s => s.video),
    };
  }).filter(t => t.steps >= 2).sort((a, b) => b.last - a.last);
}

function follow(id, on) {
  const t = _load().topics.find(x => x.id === id);
  if (!t) return false;
  t.followed = !!on; _save();
  return true;
}

/** 🧵 בנה נושא — on request, from one story: the model finds its chain among the recent stories. */
async function build(storyId) {
  const db = _load();
  const na = require('./news-apps');
  const all = na.latest(WINDOW_H, 3000);
  const s0 = all.find(s => s.id === storyId || (s.memberIds || []).includes(storyId));
  if (!s0) return null;
  const has = _topicOf(s0, db.topics);
  if (has) { if (has.closed) { has.closed = false; has.updated = Date.now(); _save(); } return has; }
  const others = all.filter(s => s.id !== s0.id && !_topicOf(s, db.topics) && Math.abs(s.firstTs - s0.firstTs) < WINDOW_H * 3600000)
    .sort((a, b) => a.firstTs - b.firstTs).slice(-120);
  const r = await require('./claude').classifyJSON(
    `הידיעה:\n${s0.title}\n\nידיעות אחרות:\n${others.map((s, i) => `S${i + 1} [${_hhmm(s.firstTs)}] ${s.title.substring(0, 140)}`).join('\n')}`,
    { system: 'אילו מהידיעות האחרות הן חלק מאותה עלילה כמו הידיעה — אותו עימות או פרשה: האמירה, התגובות אליה, תגובות לתגובות, הכחשות, הסתייגויות? לא נושא כללי. ' +
      'כתוב גם כותרת קצרה לעלילה (מי נגד מי ועל מה) ואת השחקנים. החזר JSON בלבד: {"s":[מספרים],"title":"...","actors":["..."]}', maxTokens: 400, model: 'claude-haiku-4-5-20251001', temperature: 0 });
  const t = { id: _id(), title: String((r && r.title) || s0.title).substring(0, 120), actors: [], members: [], created: Date.now(), updated: s0.last, followed: false, manual: true };
  _addStory(t, s0);
  const chosen = [s0];
  for (const n of ((r && r.s) || [])) { const s = others[(+String(n).replace(/\D/g, '') || 0) - 1]; if (s) { chosen.push(s); _addStory(t, s); t.updated = Math.max(t.updated, s.last); } }
  t.actors = _grounded(r && r.actors, chosen);
  db.topics.push(t); _save();
  logger.info(`🧵 built on request: "${t.title}"`);
  return t;
}

/** "נושא וינטר" — by words in the title or the actors. */
function find(q) {
  const ws = String(q || '').replace(/[^֐-׿a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
  if (!ws.length) return null;
  const score = t => ws.filter(w => (t.title + ' ' + (t.actors || []).join(' ')).includes(w)).length;
  return list().map(t => ({ t, n: score(t) })).filter(x => x.n).sort((a, b) => b.n - a.n || b.t.last - a.t.last)[0]?.t || null;
}

/** For WhatsApp. */
function format(res) {
  const { doc, stories } = res;
  if (!doc) return '❌ לא הצלחתי לכתוב את הסיפור — נסה שוב בעוד רגע.';
  const lines = [`🧵 *${doc.title}*`, doc.summary, ''];
  for (const st of doc.steps) {
    lines.push(`*${st.ts ? _hhmm(st.ts) + ' · ' : ''}${st.label}${st.who ? ' — ' + st.who : ''}*`);
    lines.push(st.what);
    if (st.quote) lines.push(`> "${st.quote}"${st.quoteSrc ? ` (${st.quoteSrc})` : ''}`);
    lines.push(`_${st.sources} מקורות${st.firstSource ? ' · ראשון: ' + st.firstSource : ''}_`, '');
  }
  if (doc.framing.length) { lines.push('*איך הוצג*'); for (const f of doc.framing) lines.push(`• ${f.side}: ${f.how}`); lines.push(''); }
  if (doc.open.length) { lines.push('*מה פתוח*'); for (const o of doc.open) lines.push(`• ${o}`); }
  lines.push('', `_${stories.length} ידיעות · ${new Set(stories.flatMap(s => Object.keys(s.apps || {}))).size} מקורות_`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Start over — the topics a weaker grouping made go, the followed ones are kept. */
function reset() {
  const db = _load();
  const kept = db.topics.filter(t => t.followed || t.manual);
  db.topics = kept; db.seen = {};
  _save();
  return { kept: kept.length };
}

function start() {
  setTimeout(group, 4 * 60000);
  setInterval(group, 20 * 60000);
}

module.exports = { start, group, write, list, follow, build, find, format, reset };
