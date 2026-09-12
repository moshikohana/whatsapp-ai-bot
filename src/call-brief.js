'use strict';
/**
 * 📞 שיחה עם בוטי — תדריך קולי שאפשר לדבר איתו.
 *
 * לפני שהטלפון מצלצל, בוטי עובר על כל מה שקרה מאז השיחה הקודמת: התראות
 * האפליקציות והחם ביותר מהן, הרדיו, התראות המילים והמוקד, "דורש התייחסות",
 * תמונות של הבנות, מי כתב לו בפרטי ולא קיבל תשובה, שיחות שלא נענו (מהטלפון),
 * והיומן של היום. מכל זה מודל כותב תסריט קצר לדיבור — שתי כותרות חזקות, לא
 * עשרים — ושומר את כל החומר הגולמי, כדי שכשישאלו "מה בדיוק הוא כתב?" או
 * "מי עוד דיווח על זה?" תהיה תשובה אמיתית.
 *
 * שיחה יומית בשעה קבועה (ברירת מחדל 08:00), ושיחה ביוזמתו מהאפליקציה.
 * "השיחה הקודמת" נקבעת רק כשהוא ענה — שיחה שנדחתה לא מוחקת את מה שהיה בה.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA = path.join(__dirname, '..', 'data');
const STATE = path.join(DATA, 'call-state.json');
const LAST = path.join(DATA, 'call-last.json');
const MIN_WINDOW_MS = 30 * 60000;
const MAX_WINDOW_MS = 24 * 3600000;
const DEFAULT_WINDOW_MS = 7 * 3600000;

let _deps = { client: () => null, owner: () => '' };
function init(deps) { _deps = { ..._deps, ...deps }; _startDaily(); }

function _state() {
  try { return { enabled: true, time: '08:00', ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; }
  catch { return { enabled: true, time: '08:00' }; }
}
function _setState(patch) { const s = { ..._state(), ...patch }; fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); return s; }

const _briefs = new Map();   // id → brief (the live ones; the last is also on disk)
const _il = ts => new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
const _hm = ts => { const d = _il(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// ── Collectors: each returns plain data, never throws ────────────────
async function _news(since) {
  try {
    const na = require('./news-apps');
    const hours = Math.ceil((Date.now() - since) / 3600000) + 1;
    const stories = na.hot(hours, 40).filter(s => (s.firstTs || s.last) >= since);
    // Whether each was already known — checked now for the top few, so the
    // call can say "this one you have not heard yet".
    const np = require('./news-prior');
    np.attach(stories);
    for (const s of stories.slice(0, 4)) if (!s.prior) { try { s.prior = await np.check(s); } catch (_) {} }
    return stories.slice(0, 12).map(s => ({
      id: s.id, title: s.title, channels: Object.keys(s.apps), time: _hm(s.firstTs || s.last),
      texts: s.texts, breaking: !!s.breaking, radio: !!s.radio, score: s.score,
      known: s.prior ? s.prior.status === 'known' : null,
      knownFrom: s.prior && s.prior.status === 'known'
        ? [s.prior.apps && `${s.prior.apps.source} ${_hm(s.prior.apps.ts)}`, s.prior.groups && `${s.prior.groups.group} ${_hm(s.prior.groups.ts)}`, s.prior.radio && `רדיו ${s.prior.radio.station || ''} ${_hm(s.prior.radio.ts)}`].filter(Boolean)
        : [],
    }));
  } catch (e) { logger.warn('call news: ' + (e.message || '').substring(0, 60)); return []; }
}

function _radio(since) {
  try {
    const hs = JSON.parse(fs.readFileSync(path.join(DATA, 'broadcast', 'headlines.json'), 'utf8'));
    return hs.filter(h => h.ts >= since).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 8).map(h => ({
      time: _hm(h.ts), station: h.station, headline: h.headline, quote: h.quote || null, speaker: h.speaker || null,
      score: h.score || null, ready: !!h.pkg,
    }));
  } catch { return []; }
}

// The bot's own alerts in the window — keywords, the hub, radio mentions of
// Kellner, ready responses. The ones the call covers from elsewhere are left out.
function _alerts(since) {
  try {
    const skip = new Set(['call', 'video', 'broadcast-digest', 'lead-weekly', 'album-month', 'attention', 'broadcast-headline']);
    const a = JSON.parse(fs.readFileSync(path.join(DATA, 'jarvis-alerts.json'), 'utf8'));
    return a.filter(x => x.ts >= since && !skip.has(x.kind)).slice(-25).map(x => ({
      time: _hm(x.ts), kind: x.kind, urgency: x.urgency, title: x.title,
      summary: (x.summary || '').substring(0, 200), body: String(x.body || '').substring(0, 500),
    }));
  } catch { return []; }
}

function _attention(since) {
  try {
    const att = require('./attention');
    return att.open().map(i => ({
      id: i.id, isNew: i.ts >= since, group: i.group, sender: i.sender, what: i.what, when: i.when, where: i.where,
      deadline: i.deadline, canCalendar: !!(i.dateISO || i.date), fromImage: i.source === 'image',
    }));
  } catch { return []; }
}

function _photos(since) {
  const out = {};
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'album', 'index.json'), 'utf8'));
    for (const [name, v] of Object.entries(idx)) {
      for (const p of v.photos || []) if (p.ts >= since) {
        const o = out[name] || (out[name] = { name, count: 0, groups: new Set(), last: 0 });
        o.count++; o.groups.add(p.group); o.last = Math.max(o.last, p.ts);
      }
    }
  } catch (_) {}
  return Object.values(out).map(o => ({ name: o.name, count: o.count, groups: [...o.groups], last: _hm(o.last) }));
}

/**
 * Private chats where the last word is theirs. His own WhatsApp — the bot runs
 * on it — so this is exact, not guessed from notifications.
 */
async function _unanswered(since) {
  const client = _deps.client();
  if (!client) return [];
  try {
    // Read in the page: on this WhatsApp build getChats() comes back with no
    // lastMessage on any chat (503 chats, 0 with one), so the wrapper cannot
    // tell who wrote last. The page's own store can.
    const rows = await Promise.race([
      client.pupPage.evaluate((since) => {
        const S = window.Store, out = [];
        const me = new Set();
        try { const u = S.User.getMaybeMePnUser && S.User.getMaybeMePnUser(); if (u) me.add(u._serialized || String(u)); } catch (_) {}
        try { const u = S.User.getMaybeMeLidUser && S.User.getMaybeMeLidUser(); if (u) me.add(u._serialized || String(u)); } catch (_) {}
        for (const c of S.Chat.getModelsArray()) {
          try {
            const id = c.id && c.id._serialized;
            if (!id || me.has(id) || c.isGroup || /@g\.us$|broadcast|newsletter/.test(id)) continue;
            const t = (c.t || 0) * 1000;
            if (t < since) continue;
            const arr = c.msgs && c.msgs.getModelsArray ? c.msgs.getModelsArray() : [];
            const m = arr[arr.length - 1];
            const name = c.formattedTitle || c.name || (c.contact && (c.contact.name || c.contact.pushname)) || '';
            out.push(m
              ? { id, name, t: (m.t || c.t || 0) * 1000, unread: c.unreadCount || 0, fromMe: !!(m.id && m.id.fromMe), type: m.type, body: String(m.body || '').slice(0, 200) }
              : { id, name, t, unread: c.unreadCount || 0, fromMe: !(c.unreadCount > 0), type: null, body: '' });
          } catch (_) {}
        }
        return out;
      }, since),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 20000)),
    ]);
    const own = new Set([_deps.owner(), client.info?.wid?._serialized].filter(Boolean));
    const out = [];
    for (const c of rows || []) {
      if (own.has(c.id) || c.fromMe || c.t < since) continue;
      const kind = { ptt: 'הודעה קולית', audio: 'הקלטה', image: 'תמונה', video: 'סרטון', document: 'קובץ', sticker: 'מדבקה', call_log: 'שיחה' }[c.type] || null;
      out.push({
        chatId: c.id, phone: c.id.endsWith('@c.us') ? c.id.split('@')[0] : null,
        name: c.name || 'איש קשר', unread: c.unread, time: _hm(c.t), ts: c.t,
        last: kind ? `[${kind}]${c.body && c.type !== 'ptt' ? ' ' + c.body.substring(0, 150) : ''}` : c.body,
      });
    }
    logger.info(`📞 private chats active in window: ${(rows || []).length}, waiting for him: ${out.length}`);
    return out.sort((a, b) => b.ts - a.ts).slice(0, 10);
  } catch (e) { logger.warn('call unanswered: ' + (e.message || '').substring(0, 60)); return []; }
}

async function _calendar() {
  try {
    const { google } = require('googleapis');
    const cal = google.calendar({ version: 'v3', auth: require('./calendar').getAuthClient() });
    const cals = (await cal.calendarList.list()).data.items || [];
    const now = Date.now(), until = now + 16 * 3600000;
    const ev = [];
    for (const k of cals) {
      if (/holiday/i.test(k.id)) continue;
      try {
        const r = await cal.events.list({ calendarId: k.id, singleEvents: true, orderBy: 'startTime', maxResults: 15, timeMin: new Date(now).toISOString(), timeMax: new Date(until).toISOString() });
        for (const e of r.data.items || []) ev.push({
          title: e.summary || 'אירוע', allDay: !e.start?.dateTime, calendar: k.summary,
          time: e.start?.dateTime ? _hm(new Date(e.start.dateTime).getTime()) : 'כל היום',
          ts: new Date(e.start?.dateTime || e.start?.date).getTime(), where: e.location || null,
        });
      } catch (_) {}
    }
    return ev.sort((a, b) => a.ts - b.ts).slice(0, 10);
  } catch { return []; }
}

function _missed(list, since) {
  return (Array.isArray(list) ? list : []).filter(x => (+x.ts || 0) >= since).slice(0, 15).map(x => ({
    time: _hm(+x.ts), app: String(x.app || '').substring(0, 30), title: String(x.title || '').substring(0, 80), text: String(x.text || '').substring(0, 120),
  }));
}

// ── The script ───────────────────────────────────────────────────────
const SCRIPT_SYSTEM = `אתה בוטי, העוזר האישי של מושיקו, ואתה מתקשר אליו בשיחה קולית קצרה. לפניך כל מה שאספת מאז השיחה הקודמת.
כתוב תסריט דיבור בעברית מדוברת, חמה וקצרה — כמו עוזר אישי טוב בטלפון. משפטים קצרים. בלי אימוג'י, בלי כוכביות, בלי רשימות.
סדר ובחירה:
1. פתיחה של משפט אחד (ברכה לפי השעה, ומה פרק הזמן).
2. חדשות: רק אחת או שתיים — החזקות ביותר (כמה ערוצים, מבזק, פוליטיקה וביטחון, מה שקשור לח"כ אריאל קלנר). אם ידיעה כבר הייתה ידועה קודם, אמור את זה במילה.
3. אזכורים חשובים: קלנר ברדיו או בהתראות המוקד — אם יש. אם יש תגובה מוכנה — אמור שיש.
4. דורש התייחסות: כל אישור הגעה/בקשה פתוחים — מה, מתי, איפה, ועד מתי לענות. שאל אם להכניס ליומן כשיש תאריך.
5. תמונות חדשות של הבנות — אם יש.
6. אנשים שכתבו לו בפרטי ולא ענה, ושיחות שלא נענו — שמות, ובקצרה מה רצו.
7. היומן להיום — אם זו שיחת בוקר או שיש משהו בשעות הקרובות.
8. סיום: "רוצה לשאול משהו על מה שאמרתי?"
דלג על קטע ריק. אם כמעט לא קרה כלום — אמור את זה בקצרה.
החזר JSON בלבד:
{"segments":[{"kind":"intro|news|mention|attention|photos|people|calendar|outro","title":"כותרת קצרה למסך","say":"מה לומר","ref":"מזהה רלוונטי או null"}]}
ref: לחדשות — id הידיעה; לדורש התייחסות — id הפריט; לאנשים — chatId של הראשון; אחרת null.`;

async function prepare({ missed = [], reason = 'manual', since = null } = {}) {
  const st = _state();
  const until = Date.now();
  let from = since || st.lastCallAt || (until - DEFAULT_WINDOW_MS);
  from = Math.max(from, until - MAX_WINDOW_MS);
  from = Math.min(from, until - MIN_WINDOW_MS);
  const t0 = Date.now();
  const [news, people, calendar] = await Promise.all([_news(from), _unanswered(from), _calendar()]);
  const raw = {
    window: { from: _hm(from), to: _hm(until), hours: Math.round((until - from) / 360000) / 10 },
    now: _il(until).toLocaleString('he-IL'), reason,
    news, radio: _radio(from), alerts: _alerts(from), attention: _attention(from),
    photos: _photos(from), people, missedCalls: _missed(missed, from), calendar,
  };
  const counts = {
    news: news.length, radio: raw.radio.length, alerts: raw.alerts.length, attention: raw.attention.length,
    photos: raw.photos.reduce((a, p) => a + p.count, 0), people: people.length, missed: raw.missedCalls.length, calendar: calendar.length,
  };
  let segments = null;
  try {
    const r = await require('./claude').classifyJSON(JSON.stringify(raw).substring(0, 24000), { system: SCRIPT_SYSTEM, maxTokens: 1800 });
    if (r && Array.isArray(r.segments)) segments = r.segments.filter(s => s && s.say).map(s => ({
      kind: String(s.kind || 'info'), title: String(s.title || '').substring(0, 80), say: String(s.say).substring(0, 900), ref: s.ref || null,
    }));
  } catch (e) { logger.warn('call script: ' + (e.message || '').substring(0, 60)); }
  if (!segments || !segments.length) {
    segments = [{ kind: 'intro', title: 'שלום', say: `היי מושיקו. עברתי על מה שהיה מאז ${raw.window.from}, אבל לא הצלחתי לנסח תדריך. אפשר לשאול אותי ישר.`, ref: null }];
  }
  const brief = {
    id: `${until.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    from, until, reason, counts, raw, segments, preparedMs: Date.now() - t0, history: [],
  };
  _briefs.set(brief.id, brief);
  if (_briefs.size > 10) _briefs.delete([..._briefs.keys()][0]);
  try { fs.writeFileSync(LAST, JSON.stringify(brief)); } catch (_) {}
  logger.info(`📞 call brief ${brief.id}: ${JSON.stringify(counts)} in ${brief.preparedMs}ms, ${segments.length} segments`);
  return brief;
}

function _get(id) {
  if (_briefs.has(id)) return _briefs.get(id);
  try { const b = JSON.parse(fs.readFileSync(LAST, 'utf8')); if (b.id === id) { _briefs.set(id, b); return b; } } catch (_) {}
  return null;
}

/** השיחה נענתה והסתיימה: מכאן והלאה "מאז השיחה הקודמת". */
function done(id) {
  const b = _get(id);
  if (!b) return false;
  _setState({ lastCallAt: b.until, lastCallId: id });
  return true;
}

const ASK_SYSTEM = `אתה בוטי בשיחה קולית עם מושיקו. כבר הקראת לו תדריך, ולפניך כל החומר שממנו הוא נכתב, והשיחה עד עכשיו.
ענה על מה שהוא אמר או שאל — בעברית מדוברת, קצר: משפט עד שלושה. בלי אימוג'י ובלי רשימות. אם השאלה על פרט — תן את הפרט המדויק מהחומר (מי, מה נכתב, מתי, איפה).
אם אין לך את זה בחומר — אמור בכנות שאין לך, והצע מה כן יש.
פעולות שאתה יכול לבצע כשהוא מבקש במפורש:
 calendar — הכנסת פריט "דורש התייחסות" ליומן (ref = id הפריט)
 done — סימון פריט "דורש התייחסות" כטופל (ref = id)
 open_chat — פתיחת הצ'אט בוואטסאפ עם מי שכתב לו (ref = chatId)
 next — להמשיך לנושא הבא בתדריך;  repeat — לחזור על הנושא האחרון;  end — לסיים את השיחה
החזר JSON בלבד: {"say":"מה לענות","action":"calendar|done|open_chat|next|repeat|end|null","ref":"מזהה או null"}`;

async function ask(id, question, segmentIndex = null) {
  const b = _get(id);
  if (!b) return { say: 'השיחה הזאת כבר לא פתוחה אצלי. תתקשר שוב ואכין תדריך חדש.', action: null };
  const cur = segmentIndex != null ? b.segments[segmentIndex] : null;
  const prompt = JSON.stringify({
    material: b.raw,
    script: b.segments.map((s, i) => `${i + 1}. ${s.say}`),
    currentTopic: cur ? { index: segmentIndex + 1, kind: cur.kind, say: cur.say, ref: cur.ref } : null,
    conversation: b.history.slice(-10),
    he_said: String(question || '').substring(0, 500),
  }).substring(0, 26000);
  let r = null;
  try { r = await require('./claude').classifyJSON(prompt, { system: ASK_SYSTEM, maxTokens: 500 }); } catch (e) { logger.warn('call ask: ' + (e.message || '').substring(0, 60)); }
  const out = { say: (r && r.say) || 'לא הבנתי, אפשר לנסח שוב?', action: r && r.action && r.action !== 'null' ? r.action : null, ref: (r && r.ref) || null };
  // Actions on the server side run here; the phone does the rest (open_chat, next…).
  if (out.action === 'calendar' || out.action === 'done') {
    const att = require('./attention');
    const refId = out.ref || (cur && cur.kind === 'attention' ? cur.ref : null);
    try {
      if (out.action === 'calendar') { const x = await att.toCalendar(refId); att.markDone(refId); out.say += ` נכנס ליומן: ${x.when}.`; }
      else { att.markDone(refId); }
    } catch (e) { out.say = e.code === 'NO_DATE' ? 'אין בהזמנה תאריך מדויק, אז לא הכנסתי כדי לא לנחש.' : 'לא הצלחתי לבצע את זה עכשיו.'; out.action = null; }
  }
  if (out.action === 'open_chat') {
    const p = (b.raw.people || []).find(x => x.chatId === out.ref) || (b.raw.people || [])[0];
    out.phone = p ? p.phone : null;
  }
  b.history.push({ he: question, boti: out.say });
  try { fs.writeFileSync(LAST, JSON.stringify(b)); } catch (_) {}
  return out;
}

/** Daily call: at the set time, one push that makes the phone ring. */
let _dailyTimer = null;
function _startDaily() {
  if (_dailyTimer) return;
  _dailyTimer = setInterval(() => {
    try {
      const st = _state();
      if (!st.enabled) return;
      const d = _il(Date.now());
      const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (st.lastDailyDate === today) return;
      const [h, m] = String(st.time || '08:00').split(':').map(Number);
      const mins = d.getHours() * 60 + d.getMinutes();
      if (mins < h * 60 + m || mins > h * 60 + m + 90) return;
      _setState({ lastDailyDate: today });
      require('./jarvis-api').pushAlert({
        title: '📞 בוטי מתקשר — תדריך הבוקר', summary: 'שיחת הבוקר היומית', body: 'שיחת הבוקר היומית עם בוטי.',
        kind: 'call', urgency: 'high',
      });
      logger.info('📞 daily call pushed');
    } catch (e) { logger.warn('call daily: ' + (e.message || '').substring(0, 60)); }
  }, 60000);
}

function settings(patch = null) {
  if (patch) {
    const p = {};
    if (typeof patch.enabled === 'boolean') p.enabled = patch.enabled;
    if (/^\d{1,2}:\d{2}$/.test(patch.time || '')) p.time = patch.time.padStart(5, '0');
    _setState(p);
  }
  const s = _state();
  return { enabled: s.enabled, time: s.time, lastCallAt: s.lastCallAt || null };
}

module.exports = { init, prepare, ask, done, settings };
