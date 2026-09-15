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
const _lastBySource = new Map();   // source → its previous post, for context

// 🖼️ The picture that came with the post (13.9: "אם יש תמונה, תציג —
// זה ישפר את החוויה לגמרי"). Downloaded only once the post is judged news.
const MEDIA_DIR = path.join(__dirname, '..', 'data', 'news-media');
async function _saveMedia(buf, min = 2000) {
  // A video's preview from WhatsApp is small (a few KB) — min is lower for it.
  if (!buf || buf.length < min) return null;
  try {
    const sharp = require('sharp');
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const img = sharp(buf).rotate();
    fs.writeFileSync(path.join(MEDIA_DIR, name + '.jpg'), await img.clone().resize(1080, 1080, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer());
    fs.writeFileSync(path.join(MEDIA_DIR, name + '-t.jpg'), await img.clone().resize(240, 240, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer());
    // Two days of pictures is plenty; older ones go.
    if (Math.random() < 0.05) {
      for (const f of fs.readdirSync(MEDIA_DIR)) { const t = parseInt(f, 10); if (t && Date.now() - t > 3 * 86400000) { try { fs.unlinkSync(path.join(MEDIA_DIR, f)); } catch {} } }
    }
    return name;
  } catch (e) { logger.warn('📡 feed media: ' + (e.message || '').substring(0, 50)); return null; }
}
// The picture of a Telegram post: a photo, a link preview's photo, an image
// sent as a file — or a video's preview frame (Abu Ali posts video, 13.9).
async function _tgPicture(c, m) {
  const md = m && m.media;
  if (!md) return null;
  if (md.className === 'MessageMediaPhoto' || (md.className === 'MessageMediaWebPage' && md.webpage && md.webpage.photo)) return c.downloadMedia(m, {});
  if (md.className === 'MessageMediaDocument' && md.document) {
    if (String(md.document.mimeType || '').startsWith('image/')) return c.downloadMedia(m, {});
    const thumbs = md.document.thumbs || [];
    if (thumbs.length) return c.downloadMedia(m, { thumb: thumbs.length - 1 });
  }
  return null;
}
// 🎬 A Telegram video: noted (the post's link, length, size) — fetched when he taps it.
function _tgVideo(m, link) {
  const d = m && m.media && m.media.className === 'MessageMediaDocument' && m.media.document;
  if (!d || !link || !String(d.mimeType || '').startsWith('video/')) return null;
  const a = (d.attributes || []).find(x => x.className === 'DocumentAttributeVideo');
  return { m: 'tg:' + link, d: a && a.duration != null ? Math.round(+a.duration) : null, s: d.size != null ? Number(d.size) : null };
}
async function _tgMessage(link) {
  const tg = require('./telegram');
  if (!tg.isConfigured()) throw new Error('טלגרם לא מחובר');
  const { Api } = require('telegram');
  const c = await tg.getClient();
  const m1 = String(link).match(/t\.me\/c\/(\d+)\/(\d+)/), m2 = String(link).match(/t\.me\/([A-Za-z0-9_]{4,})\/(\d+)/);
  if (!m1 && !m2) throw new Error('קישור טלגרם לא מוכר');
  const peer = m1 ? new Api.PeerChannel({ channelId: BigInt(m1[1]) }) : m2[1];
  const msgs = await Promise.race([c.getMessages(peer, { ids: [parseInt((m1 || m2)[2], 10)] }), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 15000))]);
  return { c, m: msgs && msgs[0] };
}
/** The video of a Telegram post, to a file. */
async function tgVideoToFile(link, file) {
  const { c, m } = await _tgMessage(link);
  if (!m || !m.media) throw new Error('הסרטון לא נמצא בטלגרם');
  const buf = await c.downloadMedia(m, {});
  if (!buf || !buf.length) throw new Error('הסרטון לא ירד מטלגרם');
  fs.writeFileSync(file, buf);
}
/** Recent Telegram items: which carry a video (for posts noted before videos were). */
async function backfillTgVideos(hours = 12) {
  const na = require('./news-apps');
  let n = 0;
  for (const p of na.recentChannelItems(hours)) {
    if (p.via !== 'tg' || p.video || p.videoChecked || !p.link) continue;
    try { const { m } = await _tgMessage(p.link); const v = _tgVideo(m, p.link); na.setVideo(p.id, v); if (v) n++; } catch (_) { na.setVideo(p.id, null); }
  }
  return n;
}

function mediaPath(name, thumb) {
  const n = String(name || '');
  if (!/^\d+-[a-z0-9]+$/.test(n)) return null;
  const p = path.join(MEDIA_DIR, n + (thumb ? '-t.jpg' : '.jpg'));
  return fs.existsSync(p) ? p : null;
}

function _push(item) {
  const k = `${item.via}|${item.source}|${item.text.replace(/\s+/g, ' ').substring(0, 80)}`;
  if (_seen.has(k)) return;
  _seen.add(k); if (_seen.size > 5000) _seen.clear();
  _pending.push(item);
}

/** מוואטסאפ: נקרא על כל הודעה בקבוצה או ערוץ. */
function onWhatsApp({ cid, body, ts, media, video }) {
  const name = _sources().wa.get(cid);
  if (!name) return;
  const text = String(body || '').trim();
  if (text.length < MIN_LEN) return;
  // 🎬 A video is only noted (which message, how long, how big) — it is
  // fetched from WhatsApp when he taps it in the app, not before.
  _push({ via: 'wa', source: name, text: text.substring(0, 1500), ts: ts || Date.now(), link: null, media: media || null, video: video || null });
}

const SYSTEM = `אתה עורך חדשות. לפניך פוסטים מערוצי חדשות וקבוצות עדכונים בוואטסאפ ובטלגרם.
לכל פוסט החלט: האם הוא ידיעה — דיווח על אירוע, אמירה של אדם, החלטה, נתון או עובדה חדשה?
לא ידיעה: דעה או פרשנות בלבד, פרסומת, ברכה, הזמנה להצטרף, בדיחה, שאלה, שיחה, קישור בלי תוכן, סקר "מה דעתכם".
✅ כן ידיעה — הודעה פוליטית: אמירה של ראש הממשלה, שר, ח"כ או מפלגה (גם כשהיא תוקפת או מאשימה: "נתניהו: איזו בושה, יאיר גולן לא מגנה את הסרט"), הודעת דובר (דובר צה"ל, דובר משרד), וסרטון או מסר של מפלגה או קמפיין ("סרטון הציונות הדתית: משחררים את החסימה של שופט בג"ץ") — זו לא "פרסומת". הכותרת: מי אמר מה.
✅ כן ידיעה — גם סיפור קל, ויראלי או מגמתי על פוליטיקאי או מפלגה: רגע מביך, תגובת קהל, סרטון מאירוע, סקר. גם כשזה רק כותרת-טיזר לסרטון ("זה מה שקרה כש…") ואחריה "הצטרפו לעדכונים" — הכותרת והטיזר הם הידיעה, הקישור לא הופך אותה לפרסומת. דוגמה: "הצעירים סולדים מבנט • זה מה שקרה כשהאבא המבוגר החמיא לנפתלי" → news:true, "סרטון: צעירים סולדים מבנט כשאב מבוגר מחמיא לו", cat "פוליטיקה".
✅ כן ידיעה, גם כשהפוסט כתוב בכעס או עם דעה: טענה או חשיפה שכלי תקשורת פרסם מידע שגוי, הכחשה של דיווח, פרסום שנמחק או תוקן, עימות סביב דיווח — בעיקר בענייני ביטחון, יהודה ושומרון ופנים ישראל. פוסט שמשלב דעה עם עובדה חדשה הוא ידיעה, והכותרת לפי העובדה (למשל: "אבו עלי: ערוץ 13 פרסם בטעות שמתנחלים הציתו שדות — בפועל כיבו שריפה; הציוץ נמחק").
cat — קטגוריה: "ביטחון" (צבא, מלחמה, פיגועים, יו"ש, ביטחון פנים), "פנים ישראל" (חברה, משטרה, משפט, תקשורת בישראל), "פוליטיקה", "חוץ", "אחר".
לידיעה — כתוב כותרת של משפט אחד בעברית, נאמנה לפוסט, בלי להוסיף פרט שאין בו. פוסט באנגלית, בערבית או בפרסית — תרגם לכותרת בעברית, אף פעם לא בשפת המקור.
⚠️ תפקידים ותארים — בדיוק כמו בפוסט. "השר לביטחון לאומי" (בן גביר) הוא לא "שר הביטחון" (כ"ץ); אל תקצר תואר לתואר אחר. ואל תוסיף פעולה שלא כתובה ("קרא להתפטר" כשלא נכתב).
⚠️ השם בסוגריים המרובעים הוא הערוץ ששלח את הפוסט — לא נושא הידיעה. אל תכניס אותו לכותרת כאילו הידיעה עליו ("רכב של אבו עלי אקספרס הותקף" — שגוי).
⚠️ פוסט שהוא המשך של פוסט קודם ("כך נראה הרכב שהותקף", "תיעוד מהזירה") — הכותרת לפי ההקשר שבשורת "הקודם" אם יש; בלי הקשר — news:false.
החזר JSON בלבד: {"items":[{"n":מספר הפוסט,"news":true|false,"headline":"כותרת או null","cat":"ביטחון|פנים ישראל|פוליטיקה|חוץ|אחר"}]}`;

let _busy = false;
// When the model cannot be reached (no credit, 15.9 from noon), the batch goes
// back to the queue and the feed waits 5 minutes — posts used to be dropped,
// and the Netanyahu statement of 15:19 with them. A post waits up to 12 hours.
let _pauseUntil = 0;
const _LAST_FILE = path.join(__dirname, '..', 'data', 'news-feed-last.json');
async function _flush() {
  if (_busy || !_pending.length || Date.now() < _pauseUntil) return;
  _busy = true;
  try {
    // New posts first: after an outage the catch-up put 221 old posts in the
    // queue, and a post from a minute ago waited behind all of them (15.9).
    const fresh = p => Date.now() - (p.ts || 0) < 20 * 60000 ? 0 : 1;
    _pending.sort((a, b) => fresh(a) - fresh(b));
    const batch = _pending.splice(0, 25);
    // Each post with the one its channel sent just before: "כך נראה הרכב
    // שהותקף" means nothing alone (13.9 it became "Abu Ali's car was hit").
    const list = batch.map((p, i) => {
      const prev = _lastBySource.get(p.source);
      const ctx = prev && p.ts - prev.ts < 45 * 60000 && prev.text !== p.text ? `\n   (הקודם בערוץ: ${prev.text.replace(/\s+/g, ' ').substring(0, 200)})` : '';
      return `${i + 1}. [${p.source}] ${p.text.replace(/\s+/g, ' ').substring(0, 500)}${ctx}`;
    }).join('\n');
    for (const p of batch) _lastBySource.set(p.source, { ts: p.ts, text: p.text });
    const r = await require('./claude').classifyJSON(list, { system: SYSTEM, maxTokens: 2500, model: 'claude-haiku-4-5-20251001' });
    const out = [];
    // 🔎 A headline with words the post does not have is written again, from
    // the post alone ("שר הביטחון בן גביר … קרא להתפטר" from "השר לביטחון לאומי", 13.9).
    try {
      const g = require('./grounding');
      // A post in English or Arabic shares no words with a Hebrew headline —
      // checked word by word it was "rewritten from the post" in English
      // ("Israeli jets over southern Lebanon" in the news tab, 15.9). Hebrew posts only.
      const heb = s => { const t = String(s || '').replace(/[^\p{L}]/gu, ''); return t.length ? (t.match(/[֐-׿]/g) || []).length / t.length : 0; };
      const flagged = (r && Array.isArray(r.items) ? r.items : []).filter(it => it && it.news === true && it.headline && batch[(+it.n || 0) - 1] && heb(batch[(+it.n || 0) - 1].text) >= 0.5)
        .map(it => ({ it, post: batch[(+it.n || 0) - 1].text, miss: g.missingWords(it.headline, batch[(+it.n || 0) - 1].text) }))
        .filter(x => x.miss.length);
      if (flagged.length) {
        const r2 = await require('./claude').classifyJSON(flagged.map((x, i) => `${i + 1}. פוסט: ${x.post.replace(/\s+/g, ' ').substring(0, 600)}\n   כותרת: ${x.it.headline}\n   מילים שאין בפוסט: ${x.miss.join(', ')}`).join('\n\n'), {
          system: 'לכל פריט: אם בכותרת יש פרט שלא כתוב בפוסט (תואר אחר, פעולה, מקום, מספר) — כתוב אותה מחדש רק לפי הפוסט, עם התארים בדיוק כמו בפוסט. אם היא נאמנה (רק ניסוח אחר) — השאר אותה. הכותרת תמיד בעברית. החזר JSON בלבד: {"items":[{"n":מספר,"headline":"..."}]}',
          maxTokens: 1500, model: 'claude-haiku-4-5-20251001', temperature: 0,
        });
        for (const f of ((r2 && r2.items) || [])) {
          const x = flagged[(+f.n || 0) - 1];
          if (x && f.headline && f.headline !== x.it.headline) { logger.info(`📡 feed: headline fixed "${x.it.headline.substring(0, 40)}" → "${String(f.headline).substring(0, 40)}"`); x.it.headline = f.headline; }
        }
      }
    } catch (e) { logger.warn('📡 feed headline check: ' + (e.message || '').substring(0, 60)); }
    for (const it of (r && Array.isArray(r.items) ? r.items : [])) {
      const p = batch[(+it.n || 0) - 1];
      if (!p || it.news !== true || !it.headline) continue;
      it.headline = require('./news-apps').fixRole(it.headline, p.text);
      let img = null;
      if (p.media) { try { img = await _saveMedia(await Promise.race([p.media(), new Promise(r2 => setTimeout(() => r2(null), 20000))]), p.video ? 400 : 2000); } catch (_) {} }
      out.push({
        source: p.source, via: p.via, title: String(it.headline).substring(0, 240), text: '',
        cat: ['ביטחון', 'פנים ישראל', 'פוליטיקה', 'חוץ', 'אחר'].includes(it.cat) ? it.cat : undefined,
        full: p.text, ts: p.ts, link: p.link, reporter: isReporter(p.source), img,
        ...(p.video ? { video: p.video } : {}),
      });
    }
    if (!r) {
      const back = batch.filter(p => Date.now() - (p.ts || 0) < 12 * 3600000);
      _pending.unshift(...back);
      if (_pending.length > 1500) _pending.splice(1500);
      _pauseUntil = Date.now() + 5 * 60000;
      logger.warn(`📡 feed: classification failed — ${back.length} posts back in the queue, retry in 5 min (${_pending.length} waiting)`);
    } else {
      try { fs.writeFileSync(_LAST_FILE, JSON.stringify({ ts: Date.now() })); } catch (_) {}
    }
    if (out.length) {
      const added = require('./news-apps').addMany(out);
      logger.info(`📡 feed: ${batch.length} posts → ${out.length} news (${added} new) · ${out.filter(o => o.reporter).map(o => o.source).join(', ')}`);
    } else if (r) logger.info(`📡 feed: ${batch.length} posts → no news · ${[...new Set(batch.map(p => p.source))].join(', ').substring(0, 80)}`);
  } catch (e) { logger.warn('📡 feed: ' + (e.message || '').substring(0, 70)); }
  finally {
    _busy = false;
    // A backlog is worked through every few seconds, not one batch per 45.
    if (_pending.length && Date.now() >= _pauseUntil) setTimeout(_flush, 5000);
  }
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
        // A photo, or the picture of a link's preview.
        const hasPic = !!m.media;
        _push({
          via: 'tg', source: name, text: m.message.substring(0, 1500), ts: (m.date || 0) * 1000 || Date.now(), link: `https://t.me/c/${chId}/${m.id}`,
          media: hasPic ? () => _tgPicture(c, m) : null,
          video: _tgVideo(m, `https://t.me/c/${chId}/${m.id}`),
        });
      } catch (_) {}
    }, new NewMessage({}));
    _tgClient = c;
    logger.info(`📡 feed: Telegram live updates on (${_sources().tg.size} channels)`);
  } catch (e) { logger.warn('📡 feed telegram: ' + (e.message || '').substring(0, 60)); }
}

// Updates can be missed across reconnects; the reporters matter most, so
// their last posts are read directly every ten minutes.
// 📡 Telegram, read directly. The live updates delivered 6 of the 44 channels
// in a week (15.9) — 38 had not one item: אבו עלי אקספרס, צה"ל, ערוץ 14,
// מוריה אסרף… Every run reads the reporters and the next 8 channels, so each
// channel is read about every 10 minutes without a burst of calls.
let _tgCursor = 0;
const _tgLastId = new Map();
async function _pollChannels() {
  try {
    const tg = require('./telegram');
    if (!tg.isConfigured()) return;
    const c = await tg.getClient();
    if (!c) return;
    const { Api } = require('telegram');
    const all = [..._sources().tg.entries()];
    const reps = all.filter(([, n]) => isReporter(n));
    const rest = all.filter(([, n]) => !isReporter(n));
    const slice = [];
    for (let i = 0; i < Math.min(8, rest.length); i++) slice.push(rest[(_tgCursor + i) % rest.length]);
    _tgCursor = rest.length ? (_tgCursor + 8) % rest.length : 0;
    const since = Date.now() - 3 * 3600000;
    let n = 0;
    for (const [chId, name] of [...reps, ...slice]) {
      try {
        const peer = new Api.PeerChannel({ channelId: BigInt(chId) });
        const msgs = await Promise.race([c.getMessages(peer, { limit: 10 }), new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 15000))]);
        const last = _tgLastId.get(chId) || 0;
        for (const m of (msgs || []).slice().reverse()) {
          if (!m || !m.id || m.id <= last || !m.message || m.message.length < MIN_LEN) continue;
          const ts = (m.date || 0) * 1000;
          if (ts < since) continue;
          const link = `https://t.me/c/${chId}/${m.id}`;
          const before = _pending.length;
          _push({ via: 'tg', source: name, text: m.message.substring(0, 1500), ts, link, media: m.media ? () => _tgPicture(c, m) : null, video: _tgVideo(m, link) });
          n += _pending.length - before;
        }
        const top = Math.max(last, ...(msgs || []).map(m => (m && m.id) || 0));
        if (top) _tgLastId.set(chId, top);
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        // Telegram asking to slow down: stop this run, the next one continues.
        if (/FLOOD|wait of/i.test(e.message || '')) { logger.warn('📡 feed poll: Telegram asked to slow down'); break; }
      }
    }
    if (n) logger.info(`📡 feed: Telegram read — ${n} new posts from ${reps.length + slice.length} channels`);
  } catch (e) { logger.warn('📡 feed poll: ' + (e.message || '').substring(0, 60)); }
}

let _started = false;
/**
 * 🔁 הערוצים מהשעות האחרונות, עוד פעם — אחרי הפעלה. פוסט שנדחה בטעות (הסיפור
 * של ערוץ 13 ב-13.9) או שנפל עם קבוצה שלא פוענחה מקבל הזדמנות שנייה. פוסט
 * שכבר נכנס כידיעה לא נשלח שוב.
 */
function catchUp(hours = 4) {
  try {
    const src = require('./news-prior')._groupSource();
    if (!src) return 0;
    const cache = src.cache() || {};
    const known = new Set(require('./news-apps').pushesBetween(Date.now() - (hours + 1) * 3600000, Date.now())
      .map(p => String(p.full || '').replace(/\s+/g, ' ').substring(0, 80)).filter(Boolean));
    let n = 0;
    for (const [cid, msgs] of Object.entries(cache)) {
      if (!_sources().wa.get(cid)) continue;
      for (const m of msgs || []) {
        const ts = (m.ts || 0) * 1000;
        if (ts < Date.now() - hours * 3600000 || !m.body) continue;
        if (known.has(String(m.body).trim().replace(/\s+/g, ' ').substring(0, 80))) continue;
        const before = _pending.length;
        onWhatsApp({ cid, body: m.body, ts });
        n += _pending.length - before;
      }
    }
    if (n) logger.info(`📡 feed: catch-up — ${n} channel posts from the last ${hours}h judged again`);
    return n;
  } catch (e) { logger.warn('📡 feed catch-up: ' + (e.message || '').substring(0, 60)); return 0; }
}

function start() {
  if (_started) return;
  _started = true;
  // Back after an outage (no credit, a crash): the hours since the last batch
  // that was judged, up to 12 — not just the last 4.
  setTimeout(() => {
    let h = 4;
    try { const t = JSON.parse(fs.readFileSync(_LAST_FILE, 'utf8')).ts; if (t) h = Math.min(12, Math.max(4, Math.ceil((Date.now() - t) / 3600000) + 1)); } catch (_) {}
    catchUp(h);
  }, 3 * 60000);
  setInterval(_flush, 45000);
  setTimeout(_hookTelegram, 20000);
  setInterval(_hookTelegram, 5 * 60000);        // re-hook after a reconnect
  setTimeout(_pollChannels, 60000);
  setInterval(_pollChannels, 2 * 60000);
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

/**
 * תמונות לידיעות שכבר נשמרו בלי תמונה — מכל פוסט שיש לו קישור לטלגרם
 * (ערוץ, או אותו פוסט שנמצא לפוסט מוואטסאפ). פעם אחת לכל פריט.
 */
async function backfillMedia(hours = 24, force = false) {
  const tg = require('./telegram');
  if (!tg.isConfigured()) return { done: 0 };
  const { Api } = require('telegram');
  const c = await tg.getClient();
  const na = require('./news-apps');
  let done = 0, tried = 0;
  for (const p of na.recentChannelItems(hours)) {
    if (p.img || (p.imgChecked && !force) || !p.link) continue;
    const m1 = String(p.link).match(/t\.me\/c\/(\d+)\/(\d+)/), m2 = String(p.link).match(/t\.me\/([A-Za-z0-9_]{4,})\/(\d+)/);
    if (!m1 && !m2) continue;
    tried++;
    try {
      const peer = m1 ? new Api.PeerChannel({ channelId: BigInt(m1[1]) }) : m2[1];
      const msgs = await Promise.race([c.getMessages(peer, { ids: [parseInt((m1 || m2)[2], 10)] }), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000))]);
      const m = msgs && msgs[0];
      const img = m ? await _saveMedia(await _tgPicture(c, m)) : null;
      logger.info('🖼️ backfill ' + p.link + ': ' + (m ? (m.media ? m.media.className : 'no media') : 'not found') + (img ? ' → saved' : ''));
      na.setImg(p.id, img);
      if (img) done++;
    } catch (e) { logger.warn('🖼️ backfill ' + p.link + ': ' + (e.message || '').substring(0, 80)); na.setImg(p.id, null); }
  }
  logger.info(`🖼️ feed backfill: ${done} pictures of ${tried} posts`);
  return { done, tried };
}

module.exports = { tgVideoToFile, backfillTgVideos, catchUp, saveMedia: _saveMedia, start, onWhatsApp, isReporter, reporters, status, telegramTwin, linkInText, mediaPath, backfillMedia };
