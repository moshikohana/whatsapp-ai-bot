'use strict';
/**
 * 📊 ניתוח מקורות — מי מדווח ראשון, על מה, וכמה זה מחזיק.
 *
 * Every source the bot reads, in one race: the phone's news apps, WhatsApp
 * groups and channels, Telegram, the reporters, and the radio. A story is the
 * news-apps grouping (one `story` id across sources); for each story, each
 * source counts from its first item on it. Radio joins through the links the
 * matcher already made (an item's `radio`, a headline's `appsSeen`).
 *
 * "אמין" is measured, not judged: of the stories a source broke, how many did
 * another source report too, and how many drew a denial ("מכחיש", "דיווח
 * שגוי") afterwards. A story nobody else picked up is "לא אומת" — possibly an
 * exclusive, possibly not true; the page says which it is not sure of.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const _read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };

const TYPE_OF = x => (x.reporter ? 'reporter' : x.via === 'wa' ? 'whatsapp' : x.via === 'tg' ? 'telegram' : 'app');
const DENIAL = /(מכחיש|מכחישה|מכחישים|הכחיש|הכחישה|הכחישו|הכחשה|דיווח שגוי|מידע שגוי|לא נכון|פייק|אין אמת|לא היו דברים|מופרך|תיקון:)/;
const JUDGE_AFTER = 2 * 3600000;       // a story is judged "confirmed or not" once 2h old

let _cache = null;

/**
 * @param {number} days 1 or 7 (up to the 7 days news-apps keeps)
 */
function analyze(days = 7) {
  if (_cache && _cache.days === days && Date.now() - _cache.at < 3 * 60000) return _cache.data;
  const now = Date.now();
  const since = now - days * 86400000;
  const items = _read('news-apps.json', []).filter(x => !x.skip && x.ts >= since);
  const headlines = _read(path.join('broadcast', 'headlines.json'), []).filter(h => h.ts >= since);

  // ── stories: id → { entries: source → {ts, type, text}, cat, texts[] }
  const stories = new Map();
  const get = id => stories.get(id) || stories.set(id, { id, by: {}, cats: {}, texts: [], denied: false }).get(id);
  for (const x of items) {
    const st = get(x.story || x.id);
    // A roundup part repeats old news: it counts as an item, never as a race entry.
    if (!x.part) {
      const e = st.by[x.source];
      if (!e || x.ts < e.ts) st.by[x.source] = { ts: x.ts, type: TYPE_OF(x), text: x.text };
    }
    if (x.cat) st.cats[x.cat] = (st.cats[x.cat] || 0) + 1;
    st.texts.push({ ts: x.ts, text: x.text });
    // The radio, where the matcher found the story on air.
    if (x.radio && x.radio.ts && x.radio.station) {
      const k = `📻 ${x.radio.station}`;
      const e = st.by[k];
      if (!e || x.radio.ts < e.ts) st.by[k] = { ts: x.radio.ts, type: 'radio', text: x.radio.headline || x.radio.excerpt || '' };
    }
  }
  // Radio headlines nobody else had: the radio's own solo stories.
  const linked = new Set(items.filter(x => x.radio && x.radio.headlineId).map(x => x.radio.headlineId));
  for (const h of headlines) {
    if (linked.has(h.id) || Object.keys(h.appsSeen || {}).length) continue;
    const st = get(`h:${h.id}`);
    st.by[`📻 ${h.station}`] = { ts: h.ts, type: 'radio', text: h.headline };
    st.texts.push({ ts: h.ts, text: h.headline });
    for (const a of h.alsoOn || []) st.by[`📻 ${a.station}`] = st.by[`📻 ${a.station}`] || { ts: a.ts, type: 'radio', text: h.headline };
  }

  // ── per story: order, first, denial
  const list = [];
  for (const st of stories.values()) {
    const entries = Object.entries(st.by).map(([source, e]) => ({ source, ...e })).sort((a, b) => a.ts - b.ts);
    if (!entries.length) continue;
    const first = entries[0];
    st.entries = entries;
    st.first = first;
    // Items from the phone's apps carry no category; the same rules as the home screen then.
    st.cat = Object.entries(st.cats).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    if (!st.cat) { try { st.cat = require('./news-apps').catOf([], st.texts.map(t => t.text).join(' ')); } catch (_) {} }
    st.denied = st.texts.some(t => t.ts > first.ts && DENIAL.test(t.text));
    st.title = String(first.text || '').substring(0, 120);
    list.push(st);
  }

  // ── per source
  const src = {};
  const S = (name, type) => src[name] || (src[name] = { source: name, type, stories: 0, shared: 0, first: 0, behind: [], solo: 0, broke: 0, judged: 0, confirmed: 0, denied: 0, joined: [], recent: [] });
  for (const st of list) {
    const multi = st.entries.length > 1;
    st.entries.forEach((e, i) => {
      const s = S(e.source, e.type);
      s.stories++;
      if (multi) { s.shared++; if (i === 0) s.first++; else s.behind.push((e.ts - st.first.ts) / 60000); }
      else s.solo++;
    });
    const b = S(st.first.source, st.first.type);
    b.broke++;
    const old = now - st.first.ts > JUDGE_AFTER;
    if (old) { b.judged++; if (multi) b.confirmed++; }
    if (st.denied) b.denied++;
    if (multi) b.joined.push(st.entries.length - 1);
    b.recent.push({ title: st.title, ts: st.first.ts, sources: st.entries.length, status: st.denied ? 'denied' : multi ? 'confirmed' : old ? 'unconfirmed' : 'pending', cat: st.cat });
  }
  const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)]); };
  const sources = Object.values(src).map(s => ({
    source: s.source, type: s.type, stories: s.stories, shared: s.shared, first: s.first,
    firstRate: s.shared ? Math.round(100 * s.first / s.shared) : null,
    behindMin: med(s.behind),
    solo: s.solo, broke: s.broke,
    confirmRate: s.judged >= 2 ? Math.round(100 * s.confirmed / s.judged) : null,
    judged: s.judged, confirmed: s.confirmed, denied: s.denied,
    avgJoined: s.joined.length ? Math.round(10 * s.joined.reduce((a, b) => a + b, 0) / s.joined.length) / 10 : null,
    recent: s.recent.sort((a, b) => b.ts - a.ts).slice(0, 6),
  })).sort((a, b) => b.first - a.first || b.stories - a.stories);

  // ── by type and by category: who breaks it
  const multiStories = list.filter(s => s.entries.length > 1);
  const byType = {};
  for (const st of multiStories) byType[st.first.type] = (byType[st.first.type] || 0) + 1;
  const byCat = {};
  for (const st of multiStories) {
    if (!st.cat) continue;
    const c = byCat[st.cat] || (byCat[st.cat] = { cat: st.cat, stories: 0, firsts: {} });
    c.stories++; c.firsts[st.first.source] = (c.firsts[st.first.source] || 0) + 1;
  }
  const cats = Object.values(byCat).map(c => {
    const top = Object.entries(c.firsts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { cat: c.cat, stories: c.stories, leaders: top.map(([s, n]) => ({ source: s, first: n })) };
  }).sort((a, b) => b.stories - a.stories);

  // Hot stories the verifier checked (news-verify): confirmed by another source or single.
  const ver = Object.values(_read('news-verify.json', {})).filter(v => (v.firstTs || 0) >= since);

  const data = {
    days, at: now,
    totals: {
      items: items.length, stories: list.length, multi: multiStories.length,
      multiPct: list.length ? Math.round(100 * multiStories.length / list.length) : 0,
      avgSources: multiStories.length ? Math.round(10 * multiStories.reduce((a, s) => a + s.entries.length, 0) / multiStories.length) / 10 : null,
      toSecondMin: med(multiStories.map(s => (s.entries[1].ts - s.first.ts) / 60000)),
      denied: list.filter(s => s.denied).length,
      hotChecked: ver.length, hotVerified: ver.filter(v => v.status === 'verified').length,
      sources: sources.length,
    },
    byType,
    cats,
    sources,
  };
  _cache = { days, at: now, data };
  return data;
}

module.exports = { analyze };
