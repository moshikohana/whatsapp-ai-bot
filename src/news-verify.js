'use strict';
/**
 * ✅ אומת במקור נוסף? — לכל ידיעה ב"הכי חם עכשיו".
 *
 * התראה מאפליקציה אחת היא טענה של מקור אחד. היא "אומתה" כשמקור עצמאי נוסף
 * מדווח על אותו אירוע: אפליקציית חדשות אחרת, קבוצה או ערוץ בוואטסאפ, ערוץ
 * טלגרם, או הרדיו. זה שונה מ"חדש או כבר ידוע" (news-prior), שמסתכל רק
 * אחורה — כאן נחשב גם מה שהגיע אחרי ההתראה, כי אימות מגיע לרוב אחריה.
 *
 * מועמדים נבחרים בהשוואת מילים (בטלגרם — חיפוש של טלגרם עצמו), וקריאה אחת
 * למודל לכל בדיקה מכריעה אילו מהם באמת אותו אירוע. ידיעה שעוד לא אומתה
 * נבדקת שוב: ברגע ההתראה, אחרי חצי שעה, שעה ושעתיים — ואז נעצרים.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const FILE = path.join(__dirname, '..', 'data', 'news-verify.json');
const RECHECK_MIN = [0, 30, 60, 120];
const WINDOW_BEFORE_MS = 12 * 3600000;

let _groups = null;
function setGroupSource(src) { _groups = src; }

function _load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function _save(m) {
  const cutoff = Date.now() - 4 * 86400000;
  for (const k of Object.keys(m)) if ((m[k].firstTs || 0) < cutoff) delete m[k];
  try { fs.writeFileSync(FILE, JSON.stringify(m)); } catch (_) {}
}

const STOP = new Set('של את על עם זה זו לא כי גם אם או אבל רק כל יש אין היה היא הוא הם אני מה מי איך כמו עוד כבר אחרי לפני בין מול עד היום אמר אמרה נגד בגלל כדי יותר פחות עכשיו אתמול מחר ראש שר דיווח צפו תיעוד פרסום ראשון בלעדי'.split(' '));
function _keywords(text, n = 3) {
  const words = String(text || '').replace(/["'״׳.,!?:;()\-–—|/\\*_~]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, n);
}

// The headline alone: the app texts add words that are not the story's.
const story_title_hint = t => String(t).split(' · ')[0];

async function _telegram(text, from) {
  try {
    const tg = require('./telegram');
    if (!tg.isConfigured()) return [];
    const { Api } = require('telegram');
    const c = await tg.getClient();
    const words = _keywords(story_title_hint(text), 3);
    if (!words.length) return [];
    // Telegram matches every word of the query; Hebrew prefixes (ה, ו, ב…)
    // make two-word queries miss. Two words first, then each word alone.
    const tries = [words.slice(0, 2).join(' '), words[0], words[1], words[2]].filter(Boolean);
    let r = { messages: [], chats: [] };
    for (const q of tries) {
      const x = await Promise.race([
        c.invoke(new Api.messages.SearchGlobal({
          q, filter: new Api.InputMessagesFilterEmpty(),
          minDate: Math.floor(from / 1000), maxDate: 0,
          offsetRate: 0, offsetPeer: new Api.InputPeerEmpty(), offsetId: 0, limit: 20,
        })),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
      ]);
      r.messages.push(...(x.messages || [])); r.chats.push(...(x.chats || []));
      logger.info(`✈️ tg search "${q}": ${(x.messages || []).length} results`);
      if (r.messages.length >= 8) break;
    }
    const titles = {}, users = {};
    for (const ch of r.chats || []) { titles[String(ch.id)] = ch.title; if (ch.username) users[String(ch.id)] = ch.username; }
    return (r.messages || []).filter(m => m.message && m.message.length > 15).map(m => {
      const pid = m.peerId && (m.peerId.channelId || m.peerId.chatId || m.peerId.userId);
      const u = users[String(pid)];
      return { type: 'telegram', name: titles[String(pid)] || 'טלגרם', ts: (m.date || 0) * 1000, text: m.message.substring(0, 800), link: u ? `https://t.me/${u}/${m.id}` : null };
    });
  } catch (e) { logger.warn('verify telegram: ' + (e.message || '').substring(0, 50)); return []; }
}

function _whatsapp(from) {
  if (!_groups) return [];
  const out = [];
  for (const [cid, msgs] of Object.entries(_groups.cache() || {})) {
    for (const m of msgs || []) {
      const ts = (m.ts || 0) * 1000;
      if (ts >= from && m.body && m.body.length >= 20) out.push({ type: 'whatsapp', cid, ts, text: m.body.substring(0, 800) });
    }
  }
  return out;
}

function _radio(from) {
  try {
    const bd = require('./broadcast-digest');
    const out = [];
    for (let t = from; t < Date.now(); t += 20 * 3600000) out.push(...bd.chunksBetween(t, Math.min(t + 20 * 3600000, Date.now())));
    const { isAd } = require('./broadcast-headlines');
    return out.filter(c => c.text && !isAd(c.text)).map(c => ({ type: 'radio', name: c.station || 'רדיו', ts: c.ts, text: c.text.substring(0, 800) }));
  } catch { return []; }
}

async function _name(cid) {
  let name = null;
  try { name = await _groups.name(cid); } catch (_) {}
  if (!name) {
    try {
      for (const p of require('./scan-presets').list() || []) {
        const s = (p.sources || []).find(x => x && x.id === `wa:${cid}`);
        if (s) { name = s.raw || String(s.label || '').replace(/^[^\p{L}\d]+/u, '').trim(); break; }
      }
    } catch (_) {}
  }
  return name || 'קבוצת וואטסאפ';
}

const _running = new Set();

async function check(story) {
  const key = story.id;
  if (!key || _running.has(key)) return null;
  _running.add(key);
  try {
    const t0 = story.firstTs || story.last;
    const from = t0 - WINDOW_BEFORE_MS;
    const text = [story.title, ...Object.values(story.texts || {})].join(' · ').substring(0, 600);
    const { overlap } = require('./news-apps');
    // Other news apps already on the story are independent confirmation.
    const appSources = Object.keys(story.apps || {});
    const pool = [..._whatsapp(from), ..._radio(from)]
      .map(c => ({ ...c, n: overlap(text, c.text) })).filter(c => c.n >= 3.5)
      .sort((a, b) => b.n - a.n).slice(0, 9);
    const tgs = (await _telegram(text, from)).map(c => ({ ...c, n: overlap(text, c.text) })).filter(c => c.n >= 2).slice(0, 5);
    const cands = [...pool, ...tgs];
    let hits = [];
    if (cands.length) {
      const list = cands.map((c, i) => `${i + 1}. [${c.type}] ${c.text.replace(/\s+/g, ' ').substring(0, 350)}`).join('\n');
      const r = await require('./claude').classifyJSON(`ידיעה:\n"${text}"\n\nמועמדים:\n${list}`, {
        system: 'אתה עורך חדשות שבודק אימות. אילו מהמועמדים מדווחים על אותו אירוע ספציפי שבידיעה — אותם אנשים או גופים, אותו מעשה או אמירה — ' +
          'גם בניסוח אחר או כחלק מסיכום? לא: אותו נושא כללי, אותו חג או מועד, או אירוע דומה אחר. כשיש ספק — לא. ' +
          'החזר JSON בלבד: {"same": [מספרים]}',
        maxTokens: 60, model: 'claude-sonnet-4-6',
      });
      const nums = Array.isArray(r && r.same) ? r.same.map(Number).filter(x => x >= 1 && x <= cands.length) : [];
      hits = nums.map(x => cands[x - 1]);
    }
    const sources = [];
    // Every other source already in the story confirms it — an app, a channel, a reporter.
    const _t = { wa: 'whatsapp', tg: 'telegram' };
    for (const a of appSources.slice(1)) sources.push({ type: _t[(story.vias || {})[a]] || 'app', name: a, ts: story.apps[a] });
    // What 'new or already known' found before the push is confirmation too:
    // the same event, from somewhere else, earlier.
    try {
      const pr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'news-prior.json'), 'utf8'))[key];
      if (pr && pr.groups) sources.push({ type: 'whatsapp', name: pr.groups.group, ts: pr.groups.ts, excerpt: pr.groups.excerpt });
      if (pr && pr.radio) sources.push({ type: 'radio', name: pr.radio.station || 'רדיו', ts: pr.radio.ts, excerpt: pr.radio.excerpt });
      if (pr && pr.apps && !appSources.includes(pr.apps.source)) sources.push({ type: 'app', name: pr.apps.source, ts: pr.apps.ts, excerpt: pr.apps.excerpt });
    } catch (_) {}
    const seen = new Set(sources.map(x => `${x.type}|${x.name}`));
    const own = new Set(appSources.map(a => String(a).trim()));
    for (const h of hits.sort((a, b) => a.ts - b.ts)) {
      const name = h.type === 'whatsapp' ? await _name(h.cid) : h.name;
      // A reporter's own post found again in Telegram is not a second source.
      if (own.has(String(name).trim()) || [...own].some(o => o && String(name).includes(o))) continue;
      const k = `${h.type}|${name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      sources.push({ type: h.type, name, ts: h.ts, excerpt: h.text.replace(/\s+/g, ' ').substring(0, 200), full: h.text.substring(0, 800), link: h.link || null });
    }
    const m = _load();
    const prev = m[key] || { checks: 0 };
    const res = {
      firstTs: t0, checkedAt: Date.now(), checks: (prev.checks || 0) + 1,
      status: sources.length ? 'verified' : 'single',
      sources: sources.slice(0, 6),
    };
    m[key] = res; _save(m);
    logger.info(`✅ verify: "${String(story.title).substring(0, 40)}" → ${res.status} (${sources.map(s => s.type + ':' + s.name).join(', ').substring(0, 120)})`);
    return res;
  } finally { _running.delete(key); }
}

// Due for a (re)check: never checked, or still single and the next step passed.
function _due(v, t0) {
  if (!v) return true;
  if (v.status === 'verified' || v.checks >= RECHECK_MIN.length) return false;
  // From the push, and at least 25 minutes after the last check: a story
  // first seen when it was already three hours old ran all its rechecks in
  // one minute, each seeing the same thing.
  const next = Math.max(t0 + RECHECK_MIN[v.checks] * 60000, (v.checkedAt || 0) + 25 * 60000);
  return Date.now() >= next;
}

let _queue = [], _busy = false;
const _queued = new Set();
function attach(stories) {
  const m = _load();
  for (const s of stories) {
    const v = m[s.id];
    if (v) s.verify = v;
    if (s.id && _due(v, s.firstTs || s.last) && !_queued.has(s.id) && !_running.has(s.id)) { _queued.add(s.id); _queue.push(s); }
  }
  _drain();
  return stories;
}
async function _drain() {
  if (_busy) return;
  _busy = true;
  try {
    while (_queue.length) {
      const s = _queue.shift();
      try { await check(s); } catch (e) { logger.warn('verify: ' + (e.message || '').substring(0, 60)); }
      finally { _queued.delete(s.id); }
    }
  }
  finally { _busy = false; }
}

function peek(stories) { const m = _load(); for (const s of stories) if (m[s.id]) s.verify = m[s.id]; return stories; }

module.exports = { setGroupSource, check, attach, peek };
