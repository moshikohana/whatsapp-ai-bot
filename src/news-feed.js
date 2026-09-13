'use strict';
/**
 * 📡 ערוצי החדשות בוואטסאפ ובטלגרם — כמקור חדשות, לא רק כאימות.
 *
 * עד עכשיו "הכי חם" ו"חדשות" נבנו רק מההתראות של שלוש אפליקציות, והערוצים
 * שבוטי כבר מחובר אליהם (עמית סגל, אבו עלי אקספרס, דפנה ליאל…) שימשו רק
 * כדי לאשר ידיעה אחרי שהגיעה. אבל סקופ מגיע לרוב קודם אצל הכתבים.
 *
 * כאן כל פוסט מהמקורות שברשימות הסריקה (וואטסאפ וטלגרם) עובר סינון זול:
 * Haiku, באצוות, מחליט אם זו ידיעה (אירוע, אמירה, עובדה) או דעה/פרסומת/
 * שיחה — ולידיעה נותן כותרת של משפט. הידיעות נכנסות לאותו מאגר של התראות
 * האפליקציות, ומקובצות לאותם סיפורים.
 *
 * כתבים בעדיפות (data/news-reporters.json) — הפוסטים שלהם מסומנים ⭐ ועולים
 * בדירוג.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const REPORTERS_FILE = path.join(__dirname, '..', 'data', 'news-reporters.json');
const DEFAULT_REPORTERS = ['עמית סגל', 'דפנה ליאל', 'מוטי קסטל', 'עומרי חיים'];
// Not news, whatever the list says.
const SKIP_SOURCE = /(הלכות|הידברות|דיונים)/;
const MIN_LEN = 30;

function reporters() {
  try { return JSON.parse(fs.readFileSync(REPORTERS_FILE, 'utf8')); } catch { return DEFAULT_REPORTERS; }
}
function isReporter(name) { const n = String(name || ''); return reporters().some(r => n.includes(r)); }

// ── The sources: what is in his scan lists ─────────────────────────
let _src = null, _srcAt = 0;
function _sources() {
  if (_src && Date.now() - _srcAt < 10 * 60000) return _src;
  const wa = new Map(), tg = new Map();
  try {
    for (const p of require('./scan-presets').list() || []) {
      for (const s of p.sources || []) {
        const id = String((s && s.id) || '');
        const name = String(s.raw || s.label || '').replace(/^[^\p{L}\d]+/u, '').trim();
        if (!name || SKIP_SOURCE.test(name)) continue;
        if (id.startsWith('wa:')) wa.set(id.slice(3), name);
        // Telegram: channels only — a discussion group is chatter.
        else if (id.startsWith('tg:') && s.type === 'channel') tg.set(id.slice(3).replace(/^-100/, ''), name);
      }
    }
  } catch (_) {}
  _src = { wa, tg }; _srcAt = Date.now();
  return _src;
}

// ── Batch: posts wait here, Haiku sorts them a batch at a time ─────
const _pending = [];
const _seen = new Set();

function _push(item) {
  const k = `${item.via}|${item.source}|${item.text.replace(/\s+/g, ' ').substring(0, 80)}`;
  if (_seen.has(k)) return;
  _seen.add(k); if (_seen.size > 5000) _seen.clear();
  _pending.push(item);
}

/** מוואטסאפ: נקרא על כל הודעה בקבוצה או ערוץ. */
function onWhatsApp({ cid, body, ts }) {
  const name = _sources().wa.get(cid);
  if (!name) return;
  const text = String(body || '').trim();
  if (text.length < MIN_LEN) return;
  _push({ via: 'wa', source: name, text: text.substring(0, 1500), ts: ts || Date.now(), link: null });
}

const SYSTEM = `אתה עורך חדשות. לפניך פוסטים מערוצי חדשות וקבוצות עדכונים בוואטסאפ ובטלגרם.
לכל פוסט החלט: האם הוא ידיעה — דיווח על אירוע, אמירה של אדם, החלטה, נתון או עובדה חדשה?
לא ידיעה: דעה או פרשנות בלבד, פרסומת, ברכה, הזמנה להצטרף, בדיחה, שאלה, שיחה, קישור בלי תוכן, סקר "מה דעתכם".
לידיעה — כתוב כותרת של משפט אחד בעברית, נאמנה לפוסט, בלי להוסיף פרט שאין בו.
החזר JSON בלבד: {"items":[{"n":מספר הפוסט,"news":true|false,"headline":"כותרת או null"}]}`;

let _busy = false;
async function _flush() {
  if (_busy || !_pending.length) return;
  _busy = true;
  try {
    const batch = _pending.splice(0, 25);
    const list = batch.map((p, i) => `${i + 1}. [${p.source}] ${p.text.replace(/\s+/g, ' ').substring(0, 500)}`).join('\n');
    const r = await require('./claude').classifyJSON(list, { system: SYSTEM, maxTokens: 2500, model: 'claude-haiku-4-5-20251001' });
    const out = [];
    for (const it of (r && Array.isArray(r.items) ? r.items : [])) {
      const p = batch[(+it.n || 0) - 1];
      if (!p || it.news !== true || !it.headline) continue;
      out.push({
        source: p.source, via: p.via, title: String(it.headline).substring(0, 240), text: '',
        full: p.text, ts: p.ts, link: p.link, reporter: isReporter(p.source),
      });
    }
    if (out.length) {
      const added = require('./news-apps').addMany(out);
      logger.info(`📡 feed: ${batch.length} posts → ${out.length} news (${added} new) · ${out.filter(o => o.reporter).map(o => o.source).join(', ')}`);
    }
  } catch (e) { logger.warn('📡 feed: ' + (e.message || '').substring(0, 70)); }
  finally { _busy = false; }
}

// ── Telegram: live updates from the channels, plus a poll of the reporters ──
let _tgClient = null;
async function _hookTelegram() {
  try {
    const tg = require('./telegram');
    if (!tg.isConfigured()) return;
    const c = await tg.getClient();
    if (!c || c === _tgClient) return;
    const { NewMessage } = require('telegram/events');
    c.addEventHandler(async (ev) => {
      try {
        const m = ev.message;
        if (!m || !m.message || m.message.length < MIN_LEN) return;
        const chId = m.peerId && m.peerId.channelId ? String(m.peerId.channelId) : null;
        const name = chId && _sources().tg.get(chId);
        if (!name) return;
        _push({ via: 'tg', source: name, text: m.message.substring(0, 1500), ts: (m.date || 0) * 1000 || Date.now(), link: `https://t.me/c/${chId}/${m.id}` });
      } catch (_) {}
    }, new NewMessage({}));
    _tgClient = c;
    logger.info(`📡 feed: Telegram live updates on (${_sources().tg.size} channels)`);
  } catch (e) { logger.warn('📡 feed telegram: ' + (e.message || '').substring(0, 60)); }
}

// Updates can be missed across reconnects; the reporters matter most, so
// their last posts are read directly every ten minutes.
async function _pollReporters() {
  try {
    const tg = require('./telegram');
    if (!tg.isConfigured()) return;
    const since = Date.now() - 3 * 3600000;
    for (const [chId, name] of _sources().tg) {
      if (!isReporter(name)) continue;
      const r = await tg.readMessages({ chatName: name, limit: 8 }).catch(() => null);
      for (const m of (r && r.messages) || []) {
        const ts = (m.timestamp || 0) * 1000;
        if (ts < since || !m.body || m.body.length < MIN_LEN) continue;
        _push({ via: 'tg', source: name, text: m.body.substring(0, 1500), ts, link: m.id ? `https://t.me/c/${chId}/${m.id}` : null });
      }
    }
  } catch (e) { logger.warn('📡 feed poll: ' + (e.message || '').substring(0, 60)); }
}

let _started = false;
function start() {
  if (_started) return;
  _started = true;
  setInterval(_flush, 45000);
  setTimeout(_hookTelegram, 20000);
  setInterval(_hookTelegram, 5 * 60000);        // re-hook after a reconnect
  setTimeout(_pollReporters, 60000);
  setInterval(_pollReporters, 10 * 60000);
}

function status() { return { pending: _pending.length, wa: _sources().wa.size, tg: _sources().tg.size, reporters: reporters(), telegramLive: !!_tgClient }; }

/**
 * פוסט מוואטסאפ — אין לו קישור (אין קישור ציבורי להודעה בקבוצה). רוב
 * הערוצים מפרסמים את אותו פוסט גם בטלגרם: מחפשים שם את אותו נוסח, ומחזירים
 * קישור להודעה עצמה. (13.9: "אבו עלי אקספרס" על תימן, בלי שום קישור.)
 */
async function telegramTwin(text, ts, sourceName = '') {
  try {
    const tg = require('./telegram');
    if (!tg.isConfigured()) return null;
    const { Api } = require('telegram');
    const c = await tg.getClient();
    // Whole words only: "\u05E9\u05D4\u05D7\u05D5\u05EA'\u05D9\u05DD" cut at the geresh is not a word Telegram knows.
    const words = String(text || '').replace(/https?:\/\/\S+/g, ' ').split(/\s+/)
      .map(w => w.replace(/^[^\u0590-\u05FFa-zA-Z0-9]+|[^\u0590-\u05FFa-zA-Z0-9]+$/g, ''))
      .filter(w => w.length >= 3);
    const plain = words.filter(w => /^[\u0590-\u05FFa-zA-Z0-9]+$/.test(w));
    const tries = [plain.slice(1, 5).join(' '), plain.slice(0, 3).join(' '), plain.slice(2, 4).join(' ')]
      .filter((q, i, a) => q.split(' ').length >= 2 && a.indexOf(q) === i);
    // The same post: most of its first words are there \u2014 a prefix like
    // "\u05EA\u05D9\u05DE\u05DF:" on one side only must not break it.
    const probe = words.slice(0, 12).map(w => w.replace(/[^\u0590-\u05FFa-zA-Z0-9]/g, '')).filter(Boolean);
    const same = msg => { const t = String(msg).replace(/[^\u0590-\u05FFa-zA-Z0-9]/g, ''); return probe.filter(w => t.includes(w)).length >= Math.ceil(probe.length * 0.7); };
    for (const q of tries) {
      const r = await Promise.race([
        c.invoke(new Api.messages.SearchGlobal({
          q, filter: new Api.InputMessagesFilterEmpty(),
          minDate: Math.floor(((ts || Date.now()) - 6 * 3600000) / 1000), maxDate: 0,
          offsetRate: 0, offsetPeer: new Api.InputPeerEmpty(), offsetId: 0, limit: 15,
        })),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
      ]);
      logger.info(`📡 twin "${q}": ${(r.messages || []).length} in Telegram`);
      const users = {}, titles = {};
      for (const ch of r.chats || []) { if (ch.username) users[String(ch.id)] = ch.username; titles[String(ch.id)] = ch.title || ''; }
      // The channel that wrote it, not one that copied it: by title first,
      // then the earliest.
      const key = String(sourceName).replace(/[^֐-׿a-zA-Z0-9]/g, '');
      const pidOf = m => String(m.peerId && (m.peerId.channelId || m.peerId.chatId) || '');
      const hits = (r.messages || []).filter(m => m.message && same(m.message) && pidOf(m));
      const own = key ? hits.find(m => String(titles[pidOf(m)] || '').replace(/[^֐-׿a-zA-Z0-9]/g, '').includes(key)) : null;
      const m = own || hits.sort((a, b) => a.date - b.date)[0];
      if (m) {
        const pid = pidOf(m);
        return users[pid] ? `https://t.me/${users[pid]}/${m.id}` : `https://t.me/c/${pid}/${m.id}`;
      }
    }
  } catch (e) { logger.warn('news-feed twin: ' + (e.message || '').substring(0, 50)); }
  return null;
}

/** קישור מתוך הפוסט עצמו: כתבה קודם, אחר כך ערוץ טלגרם או וואטסאפ. */
function linkInText(text) {
  const urls = (String(text || '').match(/(?:https?:\/\/|www\.|t\.me\/|chat\.whatsapp\.com\/)[^\s*_)]+/g) || [])
    .map(u => /^https?:/.test(u) ? u : 'https://' + u);
  const join = u => /t\.me\/|whatsapp\.com/.test(u);
  return urls.find(u => !join(u)) || urls.find(u => /t\.me\//.test(u)) || urls[0] || null;
}

module.exports = { start, onWhatsApp, isReporter, reporters, status, telegramTwin, linkInText };
