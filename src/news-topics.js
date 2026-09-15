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
function _storiesOf(t, all) {
  const mine = new Set(t.members || []);
  return all.filter(s => (s.memberIds || []).some(id => mine.has(id))).sort((a, b) => a.firstTs - b.firstTs);
}
function _topicOf(s, topics) {
  return topics.find(t => (s.memberIds || []).some(id => (t.members || []).includes(id)));
}
function _addStory(t, s) {
  const m = new Set(t.members || []);
  for (const id of s.memberIds || []) m.add(id);
  t.members = [...m];
}
const _srcCount = s => Object.keys(s.apps || {}).length;

// ── 1. קיבוץ ─────────────────────────────────────────────────────
const GROUP_SYSTEM = `אתה עורך חדשות פוליטי. לפניך נושאים פתוחים (T) וידיעות (S) מהשעות האחרונות.
"נושא" הוא עלילה אחת שמתפתחת: אמירה או מעשה של מישהו, ותגובות אליה — תגובה, הכחשה, איום בתביעה, הסתייגות, תגובה לתגובה. למשל: "וינטר האשים את הליכוד בחוקרים פרטיים" ← "הליכוד: נגיש תביעת דיבה" ← "ליברמן מגיב לוינטר" ← "וינטר: לא זו הייתה הכוונה".
נושא הוא לא קטגוריה כללית ("הבחירות", "איראן", "מערכת המשפט") — הוא עימות או פרשה ספציפיים בין שחקנים מסוימים.
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
      && (_srcCount(s) >= 2 || (s.reporters || []).length) && now - s.last < 12 * 3600000)
      .sort((a, b) => a.firstTs - b.firstTs).slice(-70);
    if (!dry && !cands.some(s => !db.seen[s.id])) return { assigned: 0, created: 0 };
    const tList = open.map((t, i) => {
      const st = _storiesOf(t, all).slice(-3).map(s => `${_hhmm(s.firstTs)} ${s.title.substring(0, 90)}`).join(' | ');
      return `T${i + 1}: ${t.title}${st ? ` — אחרונות: ${st}` : ''}`;
    }).join('\n');
    const sList = cands.map((s, i) => `S${i + 1} [${_hhmm(s.firstTs)}] (${_srcCount(s)} מקורות) ${s.title.substring(0, 140)}`).join('\n');
    const r = await require('./claude').classifyJSON(`נושאים פתוחים:\n${tList || '(אין)'}\n\nידיעות:\n${sList}`,
      { system: GROUP_SYSTEM, maxTokens: 1500, model, temperature: 0 });
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
    for (const a of (r.assign || [])) {
      const s = cands[(+String(a.s).replace(/\D/g, '') || 0) - 1];
      const t = open[(+String(a.t).replace(/\D/g, '') || 0) - 1];
      if (!s || !t || used.has(s.id)) continue;
      used.add(s.id); _addStory(t, s); t.updated = Math.max(t.updated || 0, s.last); assigned++;
      if (!grown.has(t)) grown.set(t, []);
      grown.get(t).push(s);
    }
    for (const n of (r.new || [])) {
      const ss = (n.s || []).map(x => cands[(+String(x).replace(/\D/g, '') || 0) - 1]).filter(s => s && !used.has(s.id));
      if (ss.length < 2 || !n.title) continue;
      const t = { id: _id(), title: String(n.title).substring(0, 120), actors: (n.actors || []).slice(0, 6).map(String), members: [], created: now, updated: 0, followed: false };
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
const WRITE_SYSTEM = `אתה עורך חדשות. לפניך ידיעות שהן עלילה אחת, לפי סדר הזמן, עם הפוסטים המקוריים מכל מקור.
כתוב את הסיפור כ-JSON:
- title: כותרת קצרה — מי נגד מי ועל מה.
- summary: משפט אחד: מה קרה עד עכשיו.
- steps: השלבים לפי הסדר. לכל שלב: s — מספרי הידיעות [S] שהוא מבוסס עליהן; label — אחת מ: רקע, אמירה, האשמה, תגובה, הכחשה, איום, הסתייגות, התפתחות; who — מי; what — משפט אחד, מה נאמר או קרה; quote — ציטוט מדויק, מילה במילה, מתוך אחד הפוסטים (העתק בדיוק, בלי לתקן), או null; quoteSrc — שם המקור שממנו הציטוט.
- framing: איך צדדים שונים הציגו את זה, רק כשזה ניכר בפוסטים עצמם — side (למשל "ערוצי ימין", "ערוצים מרכזיים", "דוברות הליכוד") ו-how (משפט אחד, עם שמות הערוצים). אם אין הבדל ניכר — מערך ריק.
- open: 1–3 שאלות פתוחות או מה צפוי, רק ממה שעולה מהפוסטים (למשל "האם הליכוד יגיש את התביעה?").
⚠️ רק מה שכתוב בפוסטים. אל תוסיף שמות, תארים, מספרים, מקומות או מניעים שאין בהם. תארים בדיוק כמו בפוסט.
החזר JSON בלבד: {"title":"...","summary":"...","steps":[{"s":[1],"label":"...","who":"...","what":"...","quote":"..."|null,"quoteSrc":"..."|null}],"framing":[{"side":"...","how":"..."}],"open":["..."]}`;

const _qn = s => String(s || '').replace(/["'״׳“”„`]/g, '').replace(/[.,!?:;()\-–—]/g, ' ').replace(/\s+/g, ' ').trim();

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
  // Each story with its posts — up to four sources, the original text.
  const posts = [];
  const input = stories.map((s, i) => {
    const d = na.story(s.id);
    const mem = ((d && d.members) || []).filter(m => (m.full || m.text));
    const pick = [];
    for (const m of mem) { if (pick.length >= 4) break; if (!pick.some(p => p.source === m.source)) pick.push(m); }
    for (const m of pick) posts.push({ s: i + 1, source: m.source, text: String(m.full || m.text) });
    return `[S${i + 1}] ${_hhmm(s.firstTs)} · ${_srcCount(s)} מקורות · ${s.title}\n` +
      pick.map(m => `   — ${m.source} (${_hhmm(m.ts)}): ${String(m.full || m.text).replace(/\s+/g, ' ').substring(0, 600)}`).join('\n');
  }).join('\n\n');
  const r = await require('./claude').classifyJSON(input, { system: WRITE_SYSTEM, maxTokens: 3000, model: 'claude-sonnet-4-6', temperature: 0 });
  if (!r || !Array.isArray(r.steps)) return { topic: t, stories, doc: t.doc || null, error: 'model' };
  const g = require('./grounding');
  const corpus = posts.map(p => p.text).join('\n');
  const steps = [];
  for (const st of r.steps) {
    const idx = (st.s || []).map(n => +n).filter(n => n >= 1 && n <= stories.length);
    const own = posts.filter(p => idx.includes(p.s));
    let quote = st.quote ? String(st.quote).trim() : null;
    // 🔎 The quote is really in a post, word for word — or it goes.
    if (quote) {
      const q = _qn(quote);
      const hit = (own.length ? own : posts).find(p => _qn(p.text).includes(q)) || posts.find(p => _qn(p.text).includes(q));
      if (!hit || q.split(' ').length < 3) { logger.info(`🧵 quote dropped (not in the posts): "${quote.substring(0, 50)}"`); quote = null; }
      else st.quoteSrc = hit.source;
    }
    // A name or word the posts do not have — flagged; a step with several is left out.
    const miss = g.missingWords(`${st.who || ''} ${st.what || ''}`, own.length ? own.map(p => p.text).join('\n') : corpus);
    if (miss.length >= 3) { logger.info(`🧵 step dropped (not in the posts: ${miss.join(', ')}): "${String(st.what).substring(0, 50)}"`); continue; }
    const ss = idx.map(n => stories[n - 1]);
    const first = ss.slice().sort((a, b) => a.firstTs - b.firstTs)[0];
    steps.push({
      label: String(st.label || 'התפתחות').substring(0, 20), who: String(st.who || '').substring(0, 60), what: String(st.what || '').substring(0, 300),
      quote: quote ? quote.substring(0, 400) : null, quoteSrc: quote ? String(st.quoteSrc || '').substring(0, 60) : null,
      ts: first ? first.firstTs : null, stories: ss.map(s => s.id),
      sources: new Set(ss.flatMap(s => Object.keys(s.apps || {}))).size,
      firstSource: first ? (first.firstAny || Object.keys(first.apps || {})[0] || null) : null,
    });
  }
  const doc = {
    title: String(r.title || t.title).substring(0, 120), summary: String(r.summary || '').substring(0, 400), steps,
    framing: (r.framing || []).filter(f => f && f.side && f.how).slice(0, 4).map(f => ({ side: String(f.side).substring(0, 40), how: String(f.how).substring(0, 300) })),
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
  const t = { id: _id(), title: String((r && r.title) || s0.title).substring(0, 120), actors: ((r && r.actors) || []).slice(0, 6).map(String), members: [], created: Date.now(), updated: s0.last, followed: false, manual: true };
  _addStory(t, s0);
  for (const n of ((r && r.s) || [])) { const s = others[(+String(n).replace(/\D/g, '') || 0) - 1]; if (s) { _addStory(t, s); t.updated = Math.max(t.updated, s.last); } }
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

function start() {
  setTimeout(group, 4 * 60000);
  setInterval(group, 20 * 60000);
}

module.exports = { start, group, write, list, follow, build, find, format };
