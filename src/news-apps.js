'use strict';
/**
 * התראות מאפליקציות החדשות — ynet, ערוץ 14, כאן — מול הרדיו.
 *
 * ההתראות מגיעות מהטלפון עצמו, מהאפליקציות, ברגע שהן קופצות: לא מאתרי
 * האינטרנט, שמתעדכנים באיחור. כך ההשוואה היא בין מה שנשמע ברדיו לבין מה
 * שהגיע לכיס — מי הקדים את מי, ובכמה.
 *
 * ההתאמה כמו במד היתרון: השוואת מילים זולה, ולמועמדות בלבד — שאלה קצרה
 * ל-Haiku "זה אותו סיפור?". לכל התראה נשמר אם נשמעה ברדיו ומתי; לכל כותרת
 * מהרדיו — מתי הגיעה לכל אפליקציה.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const FILE = path.join(__dirname, '..', 'data', 'news-apps.json');
const HEADLINES = path.join(__dirname, '..', 'data', 'broadcast', 'headlines.json');
const KEEP_DAYS = 7;
const MATCH_WINDOW_MS = 6 * 3600000;
// Channels (news-feed) added many more items to group into stories.
const MAX_CHECKS_PER_HOUR = 300;
// An item from a phone news app (no via) — the app table and duel count only these.
const _isApp = x => !x.via || x.via === 'app';

const STOP = new Set(('של את על עם זה זו לא כי גם אם או אבל רק כל יש אין היה היא הוא הם הן אני אנחנו ' +
  'אתה מה מי איך למה כמו עוד כבר אחרי לפני בין תחת מול אל עד שלא שהוא שהיא הזה הזאת היום אמר אמרה ' +
  'נגד בגלל כדי לכן מאוד יותר פחות שם פה כאן עכשיו אתמול מחר השבוע ראש שר חבר צפו דיווח בלעדי').split(/\s+/));
const _norm = s => String(s || '').replace(/["'״׳.,!?:;()\-–—|/\\*_~]/g, ' ').replace(/\s+/g, ' ').trim();
const _stem = w => (w.length >= 5 && /^[והבלמשכ]/.test(w) ? w.slice(1) : w);
const _words = s => new Set(_norm(s).split(' ').filter(w => w.length >= 3 && !STOP.has(w)).map(_stem));

function _load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } }
function _save(list) {
  try { fs.writeFileSync(FILE, JSON.stringify(list)); } catch (e) { logger.warn('news-apps save: ' + (e.message || '').substring(0, 50)); }
}
function _loadH() { try { return JSON.parse(fs.readFileSync(HEADLINES, 'utf8')); } catch { return []; } }
function _saveH(list) { try { fs.writeFileSync(HEADLINES, JSON.stringify(list, null, 1)); } catch (_) {} }

// The notification title is sometimes the app's own name ("ynet", "C14") and
// sometimes a real headline; only a real one is part of the story.
const _GENERIC = /^(ynet|c14|כאן|כאן 11|כאן חדשות|ערוץ 14|עכשיו 14|i24news)$/i;
// Podcasts, sport and culture channels inside the same apps are not news.
const _SKIP = /(הסכתים|פודקאסט|פופ אפ|כדורגל|כדורסל|ליגת|מונדיאל|פרמייר|שער בכורה|בליגה|אליפות העולם|אליפות אירופה|אולימפי|יורוליג|NBA|טניס|ג'ודו|התעמלות אמנותית|פיפ"א|אירוויזיון|מתכון|מגזין חג|\| מגזין|פרויקט מיוחד|כאן גימל|כאן 88|כאן תרבות|הצטרפו לשידור החי|\| הצטרפו|כאן חדשות ברשת ב' —|למתחילים:)/;

/**
 * התראות חדשות מהטלפון. חוזרות פעמיים לפעמים (עדכון של אותה התראה) — נשמר פעם אחת.
 * @returns כמה נוספו
 */
function addMany(items) {
  const list = _load();
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let added = 0;
  const fresh = [];
  for (const it of items || []) {
    const source = String(it.source || '').substring(0, 40);
    const title = String(it.title || '').trim();
    const body = String(it.text || '').trim();
    const text = (_GENERIC.test(title) || !title ? body : (body && !body.startsWith(title) ? `${title} — ${body}` : title)).substring(0, 400);
    const ts = +it.ts || Date.now();
    if (!source || text.length < 12 || ts < cutoff) continue;
    const key = `${source}|${_norm(text).substring(0, 80)}`;
    if (list.some(x => x.key === key)) continue;
    const item = { id: `${ts}-${Math.random().toString(36).slice(2, 6)}`, source, text, ts, key, skip: _SKIP.test(text) || undefined };
    if (it.via && it.via !== 'app') {
      item.via = it.via;
      if (it.reporter) item.reporter = true;
      if (it.full) item.full = String(it.full).substring(0, 1500);
      if (it.link) item.link = String(it.link).substring(0, 200);
    }
    list.push(item);
    if (!item.skip) fresh.push(item);
    added++;
  }
  _save(list.filter(x => x.ts >= cutoff).sort((a, b) => b.ts - a.ts).slice(0, 5000));
  // Radio matching (a model call per push, up to three times) is for the
  // apps' race against the radio; channel posts only join stories.
  for (const it of fresh) { _queue.push({ kind: 'twin', id: it.id }); if (_isApp(it)) _queue.push({ kind: 'push', id: it.id }); }
  _drain();
  return added;
}

/**
 * בדיקה חוזרת. כשהתראה קופצת הרדיו עוד לא הספיק לדבר עליה — המבזק הבא יגיע
 * בעוד רבע שעה או שעה. אז כל התראה נבדקת שוב, עד שלוש פעמים בשעתיים הראשונות.
 * נקרא כל 10 דקות.
 */
function tick() {
  const now = Date.now();
  for (const p of _load()) {
    if (p.radio || p.skip || !_isApp(p)) continue;
    const age = now - p.ts;
    const due = [20, 60, 120][(p.checks || 1) - 1];
    if (due && age >= due * 60000 && age < 135 * 60000) _queue.push({ kind: 'push', id: p.id });
  }
  _drain();
}

/** כותרת חדשה מהרדיו — אולי אחת האפליקציות כבר שלחה אותה. */
function onHeadline(h) {
  _queue.push({ kind: 'headline', id: h.id });
  _drain();
}

// ── התאמה ─────────────────────────────────────────────────────────
const _queue = [];
let _busy = false, _hourKey = 0, _checks = 0;

// Shared content words; a long distinctive word ("עודפים", "ליברמן") counts
// extra, so two good words are enough to ask the model — it has the last say.
function _overlap(a, b) {
  const x = _words(a), y = _words(b);
  let n = 0; for (const w of x) if (y.has(w)) n += w.length >= 5 ? 1.5 : 1;
  return n;
}

/**
 * Two apps, the same story in different words: "ליברמן: היעד — מקסימום
 * מנדטים" in ynet and "ליברמן בראיון: נתמודד לראשות הממשלה" in ערוץ 14
 * share two words. Word overlap alone left almost every row with one app.
 */
async function _sameApps(a, b) {
  const hk = Math.floor(Date.now() / 3600000);
  if (hk !== _hourKey) { _hourKey = hk; _checks = 0; }
  if (_checks >= MAX_CHECKS_PER_HOUR) return false;
  _checks++;
  const r = await require('./claude').classifyJSON(`התראה א:
"${a}"

התראה ב:
"${b}"`, {
    system: 'שתי התראות מאפליקציות חדשות. האם הן מדווחות על אותה ידיעה — אותו אירוע או אותה אמירה, גם אם בניסוח אחר או עם פרטים נוספים? ' +
      'לא מספיק אותו נושא כללי. החזר JSON בלבד: {"same": true|false}',
    maxTokens: 30, model: 'claude-haiku-4-5-20251001',
  });
  return !!(r && r.same === true);
}

// "פיצוצים נשמעו באיראן" was linked to Kan Bet's "נשיא איראן: אין מלחמה עם
// סעודיה" (12.9, 21:01) — same two countries, a different story — and the app
// said "הרדיו הקדים ב-8 דק׳". Haiku waved it through; the claim is shown to
// him as fact, so the last word is Sonnet's, with that exact case as the
// example of "no".
const RADIO_JUDGE = 'אתה עורך חדשות קפדן. יש התראה מאפליקציית חדשות וטקסט מהרדיו. האם הרדיו דיווח על אותה ידיעה בדיוק — ' +
  'אותו אירוע ספציפי (מה קרה, למי, איפה), או אותה אמירה של אותו אדם? אותן מדינות, אותם אנשים או אותו נושא — זה לא מספיק. ' +
  'דוגמה ל"לא": התראה "פיצוצים נשמעו באיראן, במקביל: התרעות בסעודיה" מול רדיו "נשיא איראן אמר שארצו אינה במלחמה עם סעודיה" — אותן מדינות, ידיעה אחרת. ' +
  'אם כן — צטט מהטקסט של הרדיו, מילה במילה, את המשפט שמדווח את הידיעה. החזר JSON בלבד: {"same": true|false, "excerpt": "המשפט" או null}';
async function _confirmRadio(pushText, radioText) {
  const hk = Math.floor(Date.now() / 3600000);
  if (hk !== _hourKey) { _hourKey = hk; _checks = 0; }
  if (_checks >= MAX_CHECKS_PER_HOUR) return null;
  _checks++;
  return require('./claude').classifyJSON(
    `התראה מאפליקציית חדשות:\n"${pushText}"\n\nמהרדיו:\n"${String(radioText).substring(0, 1500)}"`,
    { system: RADIO_JUDGE, maxTokens: 250, model: 'claude-sonnet-4-6' }
  );
}
/** הציטוט באמת נמצא בתמלול — ולא משפט שהמודל ניסח בעצמו. */
function _quoteIn(excerpt, text) {
  const ws = String(excerpt || '').replace(/[^\u0590-\u05FFa-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 3).map(_stem);
  if (ws.length < 3) return false;
  return ws.filter(w => String(text).includes(w)).length / ws.length >= 0.6;
}

async function _same(headline, quote, text) {
  const hk = Math.floor(Date.now() / 3600000);
  if (hk !== _hourKey) { _hourKey = hk; _checks = 0; }
  if (_checks >= MAX_CHECKS_PER_HOUR) return false;
  _checks++;
  const r = await require('./claude').classifyJSON(
    `כותרת שנקלטה ברדיו:\n"${headline}"${quote ? `\nציטוט: "${quote}"` : ''}\n\nהתראה מאפליקציית חדשות:\n"${text}"`,
    {
      // "Also reports" counts. "איזנקוט וגולן חתמו על הסכם עודפים, כמו גם בנט
      // וליברמן" is the radio's "ליברמן ובנט חתמו הסכם עודפים" — asked for
      // "exactly the same story", the model said no.
      system: 'אתה עורך חדשות. האם ההתראה מדווחת על אותו אירוע או אותה אמירה שבכותרת — גם אם היא מוסיפה פרטים או מדווחת גם על אירוע נוסף? ' +
        'לא מספיק אותו נושא כללי (למשל "איראן" או "הבחירות") — צריך שיהיה אותו אירוע. החזר JSON בלבד: {"same": true|false}',
      maxTokens: 30, model: 'claude-haiku-4-5-20251001',
    }
  );
  return !!(r && r.same === true);
}

function _link(h, p) {
  // On the push: when radio had it. On the headline: when each app sent it.
  const lead = Math.round((p.ts - h.ts) / 60000);   // > 0: radio was first
  const list = _load();
  const pp = list.find(x => x.id === p.id);
  if (pp && !pp.radio) { pp.radio = { headlineId: h.id, ts: h.ts, headline: h.headline, station: h.station, leadMin: lead }; pp.radioChecked = true; _save(list); }
  const hs = _loadH();
  const hh = hs.find(x => x.id === h.id);
  if (hh) {
    hh.appsSeen = hh.appsSeen || {};
    if (!hh.appsSeen[p.source] || hh.appsSeen[p.source].ts > p.ts) {
      hh.appsSeen[p.source] = { ts: p.ts, text: p.text.substring(0, 200), leadMin: lead };
      _saveH(hs);
    }
  }
  logger.info(`📲 ${p.source} ↔ radio: "${h.headline.substring(0, 40)}" — ${lead > 0 ? `radio first by ${lead} min` : `${p.source} first by ${-lead} min`}`);
}

/** מחפש את ההתראה בתמלול הרדיו — שלוש שעות לפני ועד שעתיים אחרי. */
async function _matchTranscript(p) {
  let chunks = [];
  try { chunks = require('./broadcast-digest').chunksBetween(p.ts - 3 * 3600000, p.ts + 2 * 3600000); } catch { return; }
  const { isAd } = require('./broadcast-headlines');
  const cands = chunks.filter(c => !isAd(c.text))
    .map(c => ({ c, n: _overlap(p.text, c.text) }))
    .filter(x => x.n >= 3).sort((a, b) => b.n - a.n).slice(0, 2);
  for (const { c } of cands) {
    const hk = Math.floor(Date.now() / 3600000);
    if (hk !== _hourKey) { _hourKey = hk; _checks = 0; }
    if (_checks >= MAX_CHECKS_PER_HOUR) return;
    _checks++;
    const r = await _confirmRadio(p.text, c.text);
    if (!r || r.same !== true) continue;
    if (!_quoteIn(r.excerpt, c.text)) { logger.info(`📲 ${p.source} ↔ ${c.station}: quote not in the transcript — not linked`); continue; }
    const lead = Math.round((p.ts - c.ts) / 60000);   // > 0: on air before the push
    const list = _load();
    const pp = list.find(x => x.id === p.id);
    if (pp && !pp.radio) {
      pp.radio = { ts: c.ts, station: c.station, excerpt: String(r.excerpt || '').substring(0, 220), leadMin: lead, via: 'transcript' };
      pp.radioChecked = true;
      _save(list);
      logger.info(`📲 ${p.source} ↔ ${c.station} transcript: ${lead > 0 ? `radio first by ${lead} min` : `${p.source} first by ${-lead} min`}`);
    }
    return;
  }
}

async function _drain() {
  if (_busy || !_queue.length) return;
  _busy = true;
  const job = _queue.shift();
  try {
    if (job.kind === 'twin') {
      // Which earlier push, from any app, is this same story? The row in the
      // table is the story; each app's first push on it is its time.
      const all = _load();
      const p = all.find(x => x.id === job.id);
      if (!p || p.story) return;
      const cands = all.filter(x => x.id !== p.id && !x.skip && x.ts <= p.ts && p.ts - x.ts < 3 * 3600000)
        .map(x => ({ x, n: _overlap(x.text, p.text) })).filter(c => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 3);
      let story = null;
      for (const c of cands) {
        if (c.n >= 4.5 || (c.x.source !== p.source && await _sameApps(c.x.text, p.text))) { story = c.x.story || c.x.id; break; }
      }
      const l2 = _load(); const pp = l2.find(x => x.id === p.id);
      if (pp) { pp.story = story || pp.id; _save(l2); }
      if (story) logger.info(`📲 ${p.source} = same story as earlier push: "${p.text.substring(0, 40)}"`);
      return;
    }
    if (job.kind === 'push') {
      const all = _load();
      const p = all.find(x => x.id === job.id);
      if (!p || p.radio) return;
      p.checks = (p.checks || 0) + 1;
      _save(all);
      const cands = _loadH().filter(h => Math.abs(h.ts - p.ts) < MATCH_WINDOW_MS)
        .map(h => ({ h, n: _overlap(`${h.headline} ${h.speaker || ''} ${h.quote || ''}`, p.text) }))
        .filter(c => c.n >= 3).sort((a, b) => b.n - a.n).slice(0, 2);
      for (const c of cands) {
        if (await _same(c.h.headline, c.h.quote, p.text)) {
        const ok = await _confirmRadio(p.text, c.h.headline + (c.h.quote ? ' — ' + c.h.quote : ''));
        if (ok && ok.same === true) { _link(c.h, p); break; }
        logger.info(`📲 ${p.source} ↔ radio headline: Sonnet said no — "${c.h.headline.substring(0, 40)}"`);
      }
      }
      // Not a headline — was it said on air at all? Radio headlines are
      // statements from interviews; app pushes are breaking news, so the two
      // rarely coincide. The full transcript (a bulletin, a presenter's
      // mention) is where the comparison actually lives.
      if (!_load().find(x => x.id === p.id && x.radio)) await _matchTranscript(p);
    } else {
      const h = _loadH().find(x => x.id === job.id);
      if (!h) return;
      const done = new Set(Object.keys(h.appsSeen || {}));
      // One push per app is enough to know when that app had the story.
      const bySource = {};
      for (const p of _load().filter(x => !x.skip && !x.radio && !done.has(x.source) && Math.abs(x.ts - h.ts) < MATCH_WINDOW_MS)) {
        const n = _overlap(`${h.headline} ${h.speaker || ''} ${h.quote || ''}`, p.text);
        if (n >= 3 && (!bySource[p.source] || n > bySource[p.source].n)) bySource[p.source] = { p, n };
      }
      for (const { p } of Object.values(bySource)) {
        if (await _same(h.headline, h.quote, p.text)) _link(h, p);
      }
    }
  } catch (e) {
    logger.warn('news-apps match: ' + (e.message || '').substring(0, 60));
  } finally {
    _busy = false;
    if (_queue.length) setTimeout(_drain, 300);
  }
}

// ── למסך ─────────────────────────────────────────────────────────
function recent(n = 30) {
  return _load().filter(x => !x.skip && _isApp(x)).slice(0, n)
    .map(x => ({ id: x.id, source: x.source, text: x.text, ts: x.ts, radio: x.radio || null }));
}

/**
 * סיפורים — שורה לכל סיפור, ומתי כל מקור היה איתו: הרדיו, ynet, ערוץ 14, כאן.
 * התראות על אותו סיפור מאפליקציות שונות מקובצות לפי מילים משותפות בחלון של
 * שלוש שעות. זו הטבלה שבה רואים מי הקדים את מי.
 */
function stories(hours = 24, limit = 15) {
  const since = Date.now() - hours * 3600000;
  const pushes = _load().filter(x => !x.skip && x.ts >= since && _isApp(x)).sort((a, b) => a.ts - b.ts);
  const out = [];
  for (const p of pushes) {
    const s = out.find(st => Math.abs(st.last - p.ts) < 3 * 3600000 && st.members.some(m => _overlap(m.text, p.text) >= 3.5));
    if (s) { s.members.push(p); s.last = Math.max(s.last, p.ts); }
    else out.push({ members: [p], last: p.ts });
  }
  return out.map(st => {
    const apps = {};
    for (const m of st.members) if (!apps[m.source] || m.ts < apps[m.source]) apps[m.source] = m.ts;
    const r = st.members.map(m => m.radio).filter(Boolean).sort((a, b) => a.ts - b.ts)[0] || null;
    const times = [...Object.entries(apps).map(([k, t]) => [k, t]), ...(r ? [['רדיו', r.ts]] : [])];
    const first = times.sort((a, b) => a[1] - b[1])[0];
    return {
      title: st.members[0].text.substring(0, 140),
      apps,
      radio: r ? { ts: r.ts, station: r.station } : null,
      first: first ? first[0] : null,
      last: st.last,
      sources: Object.keys(apps).length + (r ? 1 : 0),
    };
  })
    // A story more than one source had is the interesting row; then the latest.
    .sort((a, b) => (b.sources > 1) - (a.sources > 1) || b.last - a.last)
    .slice(0, limit);
}

/**
 * הכותרות האחרונות — האפליקציות בלבד, החדשה למעלה.
 * לכל סיפור: מתי כל אפליקציה שלחה, ומה היא כתבה. "ראשון" רק כשיותר
 * מאפליקציה אחת שלחה — סיפור שרק אחת שלחה אינו ניצחון של אף אחת.
 */
function latest(hours = 12, limit = 20) {
  const since = Date.now() - hours * 3600000;
  // _SKIP again: items stored before a word was added to it.
  const pushes = _load().filter(x => !x.skip && !_SKIP.test(x.text) && x.ts >= since).sort((a, b) => a.ts - b.ts);
  const out = [];
  for (const p of pushes) {
    // The story the model linked it to; words only for pushes it has not seen.
    const s = p.story
      ? (p.story === p.id ? null : out.find(st => st.members.some(m => m.id === p.story || m.story === p.story)))
      : out.find(st => Math.abs(st.last - p.ts) < 3 * 3600000 && st.members.some(m => _overlap(m.text, p.text) >= 3.5));
    if (s) { s.members.push(p); s.last = Math.max(s.last, p.ts); }
    else out.push({ members: [p], last: p.ts });
  }
  return out.map(st => {
    const apps = {}, texts = {}, vias = {};
    for (const m of st.members) if (!apps[m.source] || m.ts < apps[m.source]) { apps[m.source] = m.ts; texts[m.source] = m.text.substring(0, 160); vias[m.source] = m.via || 'app'; }
    const order = Object.entries(apps).sort((a, b) => a[1] - b[1]);
    const appOrder = order.filter(([src]) => vias[src] === 'app');
    const reporters = [...new Set(st.members.filter(m => m.reporter).map(m => m.source))];
    // The headline: an app's wording when there is one (edited), else a reporter's.
    const titleSrc = (appOrder[0] || order.find(([src]) => reporters.includes(src)) || order[0] || [null])[0];
    return {
      id: st.members[0].id,
      memberIds: st.members.map(m => m.id),
      title: titleSrc ? texts[titleSrc] : st.members[0].text.substring(0, 160),
      apps, texts, vias, reporters,
      first: appOrder.length > 1 ? appOrder[0][0] : null,
      firstAny: order.length > 1 ? order[0][0] : null,
      firstTs: order.length ? order[0][1] : st.members[0].ts,
      count: st.members.length,
      radio: st.members.some(m => m.radio),
      last: st.last,
    };
  }).sort((a, b) => b.last - a.last).slice(0, limit);
}

// Words that make a push breaking news rather than a feature.
const _BREAKING = /(מבזק|דחוף|בלעדי|פרסום ראשון|לראשונה|חוסל|חיסול|נהרג|נהרגו|נרצח|הרוג|פצוע|אזעק|ירי |פיגוע|שיגור|יירוט|טיל|רעידת אדמה|התפטר|נעצר|כתב אישום|צה"ל מאשר|הודעה רשמית)/;

/**
 * 🔥 הכי חם עכשיו — הסיפורים ששווה לראות ראשונים.
 * חם = כמה ערוצים שלחו (הסימן החזק ביותר), עדכונים נוספים, מילות מבזק,
 * ואם נשמע גם ברדיו — פחות הזמן שעבר מאז שהתחיל. בלי מודל: שקוף וחינם.
 */
function hot(hours = 6, limit = 12) {
  const now = Date.now();
  return latest(hours, 300).map(s => {
    const channels = Object.keys(s.apps).length;
    const nApps = Object.values(s.vias || {}).filter(v => v === 'app').length;
    const nOther = channels - nApps;
    const breaking = _BREAKING.test(Object.values(s.texts).join(' '));
    const ageH = (now - s.firstTs) / 3600000;
    const rep = (s.reporters || []).length;
    // A single post in one WhatsApp group, no app and no reporter: rarely the
    // story of the hour, and the groups post all day.
    const lone = nApps === 0 && rep === 0 && nOther <= 1 ? -3 : 0;
    const score = Math.max(nApps - 1, 0) * 4 + Math.min(nOther, 4) * 1.5 + (nApps && nOther ? 1 : 0)
      + Math.min(s.count - channels, 3) + (breaking ? 3 : 0) + (s.radio ? 2 : 0) + (rep ? 3 : 0) + lone - ageH * 1.5;
    return { ...s, channels, breaking, score: Math.round(score * 10) / 10 };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * האפליקציות זו מול זו: בכמה סיפורים משותפים כל אחת הייתה ראשונה, ובכמה
 * דקות בממוצע היא איחרה אחרי הראשונה כשלא הייתה.
 */
function duel(hours = 24) {
  const out = {};
  const since = Date.now() - hours * 3600000;
  for (const p of _load().filter(x => !x.skip && x.ts >= since && _isApp(x))) {
    const s = out[p.source] || (out[p.source] = { source: p.source, pushes: 0, shared: 0, first: 0, behind: [], lastTs: 0 });
    s.pushes++; s.lastTs = Math.max(s.lastTs, p.ts);
  }
  for (const st of latest(hours, 500)) {
    const e = Object.entries(st.apps).filter(([src]) => (st.vias || {})[src] === 'app');
    if (e.length < 2) continue;
    const t0 = Math.min(...e.map(x => x[1]));
    for (const [src, t] of e) {
      const s = out[src]; if (!s) continue;
      s.shared++;
      if (t === t0) s.first++; else s.behind.push(Math.round((t - t0) / 60000));
    }
  }
  return Object.values(out).map(s => ({
    source: s.source, pushes: s.pushes, shared: s.shared, first: s.first, lastTs: s.lastTs,
    avgBehindMin: s.behind.length ? Math.round(s.behind.reduce((a, b) => a + b, 0) / s.behind.length) : null,
  }));
}

/** לכל אפליקציה: בכמה סיפורים הרדיו הקדים אותה, ובכמה דקות בממוצע. */
function stats(days = 7) {
  const since = Date.now() - days * 86400000;
  const out = {};
  for (const p of _load().filter(x => x.ts >= since && !x.skip && _isApp(x))) {
    const s = out[p.source] || (out[p.source] = { source: p.source, pushes: 0, matched: 0, radioFirst: 0, appFirst: 0, leads: [] });
    s.pushes++;
    if (p.radio) {
      s.matched++;
      if (p.radio.leadMin > 0) { s.radioFirst++; s.leads.push(p.radio.leadMin); } else s.appFirst++;
    }
  }
  return Object.values(out).map(s => ({
    source: s.source, pushes: s.pushes, matched: s.matched, radioFirst: s.radioFirst, appFirst: s.appFirst,
    avgLeadMin: s.leads.length ? Math.round(s.leads.reduce((a, b) => a + b, 0) / s.leads.length) : null,
  })).sort((a, b) => b.pushes - a.pushes);
}

function idle() {
  return new Promise(r => { const t = setInterval(() => { if (!_busy && !_queue.length) { clearInterval(t); r(); } }, 100); });
}

// After a restart: the last 12 hours' pushes that were never grouped.
setTimeout(() => {
  const since = Date.now() - 12 * 3600000;
  for (const p of _load().filter(x => !x.skip && !x.story && x.ts >= since).sort((a, b) => a.ts - b.ts)) _queue.push({ kind: 'twin', id: p.id });
  _drain();
}, 30000);

/** התראות בטווח זמן — לבדיקה "האם כבר דווח". */
function pushesBetween(from, to) {
  return _load().filter(x => !x.skip && x.ts >= from && x.ts <= to);
}

/**
 * ידיעה אחת במלואה — כל התראה שנשלחה עליה, מכל אפליקציה, עם הטקסט המלא,
 * ומתי נשמעה ברדיו. זה מה שנפתח כשלוחצים על כותרת.
 */
function story(id) {
  const s = latest(48, 2000).find(x => x.id === id || (x.memberIds || []).includes(id));
  if (!s) return null;
  const ids = new Set(s.memberIds || []);
  const members = _load().filter(p => ids.has(p.id)).sort((a, b) => a.ts - b.ts).map(p => ({
    id: p.id, source: p.source, ts: p.ts, text: p.text, via: p.via || 'app',
    full: p.full || null, link: p.link || null, reporter: !!p.reporter,
    radio: p.radio ? { station: p.radio.station || null, ts: p.radio.ts, headline: p.radio.headline || p.radio.excerpt || null, quote: p.radio.excerpt || p.radio.headline || null, leadMin: p.radio.leadMin } : null,
  }));
  return { ...s, members };
}

/** בודק מחדש קישורי רדיו קיימים עם השופט המחמיר; מה שלא עומד בו — יורד. */
async function recheckRadio(hours = 24) {
  const since = Date.now() - hours * 3600000;
  const bd = require('./broadcast-digest');
  let kept = 0, dropped = 0;
  for (const p of _load().filter(x => x.radio && x.ts >= since && !x.radioChecked)) {
    let radioText = null;
    if (p.radio.via === 'transcript') {
      const c = bd.chunksBetween(p.radio.ts - 2000, p.radio.ts + 2000).find(x => x.station === p.radio.station);
      radioText = c && c.text;
    } else radioText = p.radio.headline;
    if (!radioText) continue;
    const r = await _confirmRadio(p.text, radioText);
    if (!r) break;   // out of checks this hour
    const ok = r.same === true && (p.radio.via !== 'transcript' || _quoteIn(r.excerpt, radioText));
    const l = _load(); const pp = l.find(x => x.id === p.id);
    if (!pp || !pp.radio) continue;
    if (ok) {
      if (pp.radio.via === 'transcript' && r.excerpt) pp.radio.excerpt = String(r.excerpt).substring(0, 220);
      pp.radioChecked = true; kept++;
    } else {
      logger.info(`📻 radio link dropped: ${p.source} "${p.text.substring(0, 40)}" ≠ ${p.radio.station}`);
      pp.radioRejected = pp.radio; delete pp.radio; dropped++;
    }
    _save(l);
  }
  logger.info(`📻 radio links rechecked: ${kept} kept, ${dropped} dropped`);
  return { kept, dropped };
}

module.exports = { recheckRadio, addMany, onHeadline, recent, stats, stories, latest, hot, duel, idle, tick, pushesBetween, story, overlap: _overlap };
