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
const MAX_CHECKS_PER_HOUR = 60;

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
const _SKIP = /(הסכתים|פודקאסט|פופ אפ|כדורגל|כדורסל|ליגת|מונדיאל|פיפ"א|אירוויזיון|מתכון)/;

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
    const source = String(it.source || '').substring(0, 20);
    const title = String(it.title || '').trim();
    const body = String(it.text || '').trim();
    const text = (_GENERIC.test(title) || !title ? body : (body && !body.startsWith(title) ? `${title} — ${body}` : title)).substring(0, 400);
    const ts = +it.ts || Date.now();
    if (!source || text.length < 12 || ts < cutoff) continue;
    const key = `${source}|${_norm(text).substring(0, 80)}`;
    if (list.some(x => x.key === key)) continue;
    const item = { id: `${ts}-${Math.random().toString(36).slice(2, 6)}`, source, text, ts, key, skip: _SKIP.test(text) || undefined };
    list.push(item);
    if (!item.skip) fresh.push(item);
    added++;
  }
  _save(list.filter(x => x.ts >= cutoff).sort((a, b) => b.ts - a.ts).slice(0, 1500));
  for (const it of fresh) _queue.push({ kind: 'push', id: it.id });
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
    if (p.radio || p.skip) continue;
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
  if (pp && !pp.radio) { pp.radio = { headlineId: h.id, ts: h.ts, headline: h.headline, station: h.station, leadMin: lead }; _save(list); }
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
    const r = await require('./claude').classifyJSON(
      `התראה מאפליקציית חדשות:\n"${p.text}"\n\nקטע מתמלול רדיו (${c.station}):\n"${c.text.substring(0, 1500)}"`,
      {
        system: 'האם קטע הרדיו מדבר על אותו אירוע כמו ההתראה — לא רק על אותו נושא כללי? אם כן, צטט את המשפט הרלוונטי מהתמלול. ' +
          'החזר JSON בלבד: {"same": true|false, "excerpt": "המשפט מהתמלול או null"}',
        maxTokens: 200, model: 'claude-haiku-4-5-20251001',
      }
    );
    if (!r || r.same !== true) continue;
    const lead = Math.round((p.ts - c.ts) / 60000);   // > 0: on air before the push
    const list = _load();
    const pp = list.find(x => x.id === p.id);
    if (pp && !pp.radio) {
      pp.radio = { ts: c.ts, station: c.station, excerpt: String(r.excerpt || '').substring(0, 220), leadMin: lead, via: 'transcript' };
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
        if (await _same(c.h.headline, c.h.quote, p.text)) { _link(c.h, p); break; }
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
  return _load().filter(x => !x.skip).slice(0, n)
    .map(x => ({ id: x.id, source: x.source, text: x.text, ts: x.ts, radio: x.radio || null }));
}

/** לכל אפליקציה: בכמה סיפורים הרדיו הקדים אותה, ובכמה דקות בממוצע. */
function stats(days = 7) {
  const since = Date.now() - days * 86400000;
  const out = {};
  for (const p of _load().filter(x => x.ts >= since && !x.skip)) {
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

module.exports = { addMany, onHeadline, recent, stats, idle, tick };
