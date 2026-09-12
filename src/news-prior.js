'use strict';
/**
 * 🆕 חדש או כבר ידוע? — לכל ידיעה ב"הכי חם עכשיו".
 *
 * ההתראה מהאפליקציה היא לא בהכרח הפעם הראשונה ששמע על הסיפור: לפעמים זה
 * כבר רץ בקבוצות הוואטסאפ שעה קודם, נאמר ברדיו בבוקר, או ש-ynet דיווח עליו
 * אתמול וזה רק עדכון. כאן נבדקות שלוש הזירות, לאחור מרגע ההתראה הראשונה:
 *   📻 תמלולי הרדיו — 36 שעות
 *   💬 הודעות בקבוצות ובערוצים — 36 שעות
 *   🔔 התראות קודמות מהאפליקציות — 48 שעות
 *
 * השוואת מילים זולה בוחרת מועמדים, ושאלה אחת למודל לכל זירה מכריעה אילו
 * מהם באמת על אותו אירוע. מה שהיה לפני ההתראה לא משתנה אחריה — אז כל ידיעה
 * נבדקת פעם אחת, והתוצאה נשמרת.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const FILE = path.join(__dirname, '..', 'data', 'news-prior.json');
const BACK_MS = 36 * 3600000;
const BACK_APPS_MS = 48 * 3600000;
// Within a few minutes of the push is the same moment, not "already known".
const SAME_MOMENT_MS = 5 * 60000;

let _groups = null;   // { cache: () => {cid: [{ts(sec), body, sender}]}, name: async cid => string }
function setGroupSource(src) { _groups = src; }
function _groupSource() { return _groups; }

function _load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function _save(m) {
  const cutoff = Date.now() - 4 * 86400000;
  for (const k of Object.keys(m)) if ((m[k].checkedAt || 0) < cutoff) delete m[k];
  try { fs.writeFileSync(FILE, JSON.stringify(m)); } catch (_) {}
}

/** Which of the numbered candidates report the same event. One call per arena. */
async function _confirm(storyText, cands) {
  if (!cands.length) return [];
  const list = cands.map((c, i) => `${i + 1}. ${String(c.text).replace(/\s+/g, ' ').substring(0, 400)}`).join('\n');
  const r = await require('./claude').classifyJSON(`ידיעה:\n"${storyText.substring(0, 500)}"\n\nמועמדים:\n${list}`, {
    // "Leaders around the world sent new-year greetings" was matched to Ben
    // Gvir's own new-year message: same occasion, not the same story. The
    // prompt asks for the specific event — who, what, where.
    system: 'אתה עורך חדשות. אילו מהמועמדים מדווחים על אותו אירוע ספציפי שבידיעה — אותם אנשים או גופים, אותו מעשה או אותה אמירה, אותו מקום — ' +
      'גם אם בניסוח אחר, בקיצור, או כחלק מסיכום? ' +
      'לא: אותו נושא כללי ("איראן", "הבחירות"), אותו מועד או חג (ברכות לשנה החדשה של אנשים שונים), או אדם אחר שעשה משהו דומה. ' +
      'כשיש ספק — לא. החזר JSON בלבד: {"same": [מספרי המועמדים המתאימים]}',
    // Sonnet, not Haiku: Haiku kept matching on the occasion alone. A few
    // calls per headline, once.
    maxTokens: 60, model: 'claude-sonnet-4-6',
  });
  const nums = Array.isArray(r && r.same) ? r.same.map(Number).filter(n => n >= 1 && n <= cands.length) : [];
  return nums.map(n => cands[n - 1]);
}

function _top(items, text, n, min = 3.5) {
  const { overlap } = require('./news-apps');
  return items.map(it => ({ ...it, n: overlap(text, it.text) }))
    .filter(x => x.n >= min).sort((a, b) => b.n - a.n).slice(0, n);
}

async function _radio(text, t0) {
  let chunks = [];
  try {
    const bd = require('./broadcast-digest');
    // chunksBetween reads the two day files at the window's ends; 36 hours can
    // touch three, so it is asked a day at a time.
    for (let from = t0 - BACK_MS; from < t0; from += 20 * 3600000) {
      chunks.push(...bd.chunksBetween(from, Math.min(from + 20 * 3600000, t0 - 60000)));
    }
  } catch { return null; }
  const seen = new Set();
  chunks = chunks.filter(c => c && c.text && !seen.has(c.ts + (c.station || '')) && seen.add(c.ts + (c.station || '')));
  try { const { isAd } = require('./broadcast-headlines'); chunks = chunks.filter(c => !isAd(c.text)); } catch (_) {}
  const hits = await _confirm(text, _top(chunks.map(c => ({ ts: c.ts, station: c.station, text: c.text })), text, 4));
  if (!hits.length) return null;
  const f = hits.sort((a, b) => a.ts - b.ts)[0];
  return { ts: f.ts, station: f.station || null, count: hits.length, excerpt: f.text.substring(0, 220) };
}

async function _groupsPrior(text, t0) {
  if (!_groups) return null;
  const all = [];
  const cache = _groups.cache() || {};
  for (const [cid, msgs] of Object.entries(cache)) {
    for (const m of msgs || []) {
      const ts = (m.ts || 0) * 1000;
      if (ts < t0 - BACK_MS || ts > t0 - 60000) continue;
      if (!m.body || m.body.length < 20) continue;
      all.push({ cid, ts, text: m.body.substring(0, 1200) });
    }
  }
  const hits = await _confirm(text, _top(all, text, 8));
  if (!hits.length) return null;
  hits.sort((a, b) => a.ts - b.ts);
  const f = hits[0];
  let name = null;
  try { name = await _groups.name(f.cid); } catch (_) {}
  // Channels have no chat to ask; the scan lists carry their names.
  if (!name) {
    try {
      for (const p of require('./scan-presets').list() || []) {
        const s = (p.sources || []).find(x => x && x.id === `wa:${f.cid}`);
        if (s) { name = s.raw || String(s.label || '').replace(/^[^\p{L}\d]+/u, '').trim(); break; }
      }
    } catch (_) {}
  }
  return {
    ts: f.ts, group: name || 'קבוצת וואטסאפ', groups: new Set(hits.map(h => h.cid)).size,
    excerpt: f.text.replace(/\s+/g, ' ').substring(0, 220),
  };
}

async function _appsPrior(text, t0, story) {
  const na = require('./news-apps');
  const members = new Set(story.memberIds || []);
  const pushes = na.pushesBetween(t0 - BACK_APPS_MS, t0 - 60000).filter(p => !members.has(p.id));
  const hits = await _confirm(text, _top(pushes.map(p => ({ ts: p.ts, source: p.source, text: p.text })), text, 5));
  if (!hits.length) return null;
  const f = hits.sort((a, b) => a.ts - b.ts)[0];
  return { ts: f.ts, source: f.source, count: hits.length, excerpt: f.text.substring(0, 220) };
}

const _running = new Set();

/** בודק ידיעה אחת ושומר. story: פריט מ-latest()/hot(). */
async function check(story) {
  const key = story.id;
  if (!key || _running.has(key)) return null;
  _running.add(key);
  try {
    const t0 = story.firstTs || story.last;
    const text = [story.title, ...Object.values(story.texts || {})].join(' · ').substring(0, 700);
    const [radio, groups, apps] = await Promise.all([
      _radio(text, t0).catch(e => { logger.warn('prior radio: ' + (e.message || '').substring(0, 50)); return null; }),
      _groupsPrior(text, t0).catch(e => { logger.warn('prior groups: ' + (e.message || '').substring(0, 50)); return null; }),
      _appsPrior(text, t0, story).catch(e => { logger.warn('prior apps: ' + (e.message || '').substring(0, 50)); return null; }),
    ]);
    const earlier = [radio && { src: 'radio', ts: radio.ts }, groups && { src: 'groups', ts: groups.ts }, apps && { src: 'apps', ts: apps.ts }]
      .filter(Boolean).filter(x => x.ts < t0 - SAME_MOMENT_MS).sort((a, b) => a.ts - b.ts);
    const res = {
      checkedAt: Date.now(),
      status: earlier.length ? 'known' : 'new',
      firstSrc: earlier[0]?.src || null, firstTs: earlier[0]?.ts || null,
      radio, groups, apps,
    };
    const m = _load(); m[key] = res; _save(m);
    logger.info(`🆕 prior: "${String(story.title).substring(0, 40)}" → ${res.status}${res.firstSrc ? ` (first: ${res.firstSrc}, ${Math.round((t0 - res.firstTs) / 60000)} min before)` : ''}`);
    return res;
  } finally { _running.delete(key); }
}

/** The results for these stories; the ones not yet checked are started in the background, one at a time. */
let _queue = [], _busy = false;
function attach(stories) {
  const m = _load();
  for (const s of stories) {
    if (m[s.id]) s.prior = m[s.id];
    else if (s.id && !_queue.some(q => q.id === s.id) && !_running.has(s.id)) _queue.push(s);
  }
  _drain();
  return stories;
}
async function _drain() {
  if (_busy) return;
  _busy = true;
  try { while (_queue.length) { const s = _queue.shift(); await check(s).catch(() => null); } }
  finally { _busy = false; }
}

/** Cached results only — for long lists, where checking everything would cost a call per story. */
function peek(stories) { const m = _load(); for (const s of stories) if (m[s.id]) s.prior = m[s.id]; return stories; }

module.exports = { setGroupSource, _groupSource, check, attach, peek };
