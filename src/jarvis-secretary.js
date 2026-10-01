'use strict';
/**
 * מזכיר — מייל ויומן לג׳רביס של המחשב.
 *
 * The PC never holds Google credentials: it asks the bot, the bot asks Google
 * with the token it already has (calendar.js owns it and its refresh). Narrow
 * endpoints rather than a proxy, so the PC can do exactly these things:
 *
 *   GET  /api/jarvis/mail/inbox      list (default: inbox, last 2 days)
 *   GET  /api/jarvis/mail/message    one message, body as text
 *   GET  /api/jarvis/mail/awaiting   threads where he wrote last and nobody answered
 *   POST /api/jarvis/mail/draft      create a DRAFT (new or reply) — nothing is sent
 *   POST /api/jarvis/mail/send-draft send a draft he approved (the PC asks him first)
 *   POST /api/jarvis/mail/mark       read / unread / star
 *   GET  /api/jarvis/calendar        events for the next N days
 *   POST /api/jarvis/calendar/event  add an event
 */
const { google } = require('googleapis');
const logger = require('./logger');

const cal = () => require('./calendar');
const gmail = () => google.gmail({ version: 'v1', auth: cal().getAuthClient() });

// Same idea as gmail.js isSpamEmail — kept local because that one isn't exported.
const NOISE_FROM = /(no-?reply|noreply|newsletter|notifications?@|mailer|marketing|promo|aliexpress|twitch|linkedin|facebookmail|temu|shein|wolt|news@|info@)/i;
const NOISE_SUBJ = /(מבצע|הנחה|קופון|sale|% off|newsletter|ניוזלטר|webinar|unsubscribe|deal|הזמנה שלך נשלחה)/i;

const hv = (headers, n) => (headers || []).find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
const nameOf = (from) => { const m = String(from).match(/^"?([^"<]+)"?\s*</); return m ? m[1].trim() : String(from).split('@')[0]; };
const addrOf = (from) => { const m = String(from).match(/<([^>]+)>/); return (m ? m[1] : String(from)).trim(); };

function bodyOf(payload) {
  const dec = (d) => Buffer.from(String(d || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const walk = (p, mime) => {
    if (!p) return '';
    if (p.mimeType === mime && p.body && p.body.data) return dec(p.body.data);
    for (const c of p.parts || []) { const r = walk(c, mime); if (r) return r; }
    return '';
  };
  let t = walk(payload, 'text/plain');
  if (!t) {
    t = walk(payload, 'text/html')
      .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  }
  return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function brief(m) {
  const h = m.payload && m.payload.headers;
  const from = hv(h, 'From');
  const subject = hv(h, 'Subject') || '(ללא נושא)';
  const labels = m.labelIds || [];
  return {
    id: m.id, threadId: m.threadId,
    from: nameOf(from), fromAddr: addrOf(from), to: hv(h, 'To'), subject,
    date: new Date(parseInt(m.internalDate, 10)).toISOString(),
    snippet: m.snippet || '',
    unread: labels.includes('UNREAD'), starred: labels.includes('STARRED'), important: labels.includes('IMPORTANT'),
    noise: NOISE_FROM.test(from) || NOISE_SUBJ.test(subject) || labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_SOCIAL'),
  };
}

async function inbox({ q = 'in:inbox newer_than:2d', max = 25 } = {}) {
  const g = gmail();
  const list = await g.users.messages.list({ userId: 'me', q, maxResults: Math.min(+max || 25, 50) });
  const ids = (list.data.messages || []).map(m => m.id);
  const msgs = await Promise.all(ids.map(id => g.users.messages.get({
    userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'],
  }).then(r => r.data).catch(() => null)));
  return msgs.filter(Boolean).map(brief);
}

async function message(id) {
  const r = await gmail().users.messages.get({ userId: 'me', id, format: 'full' });
  const b = brief(r.data);
  return { ...b, cc: hv(r.data.payload.headers, 'Cc'), body: bodyOf(r.data.payload).substring(0, 12000) };
}

/** Threads he started or answered last, older than N days, with no reply since. */
let _me = null;
async function myAddress(g) {
  if (!_me) _me = String((await g.users.getProfile({ userId: 'me' })).data.emailAddress || '').toLowerCase();
  return _me;
}

async function awaiting({ days = 3, max = 25 } = {}) {
  const g = gmail();
  const me = await myAddress(g);
  const list = await g.users.messages.list({ userId: 'me', q: `in:sent -to:${me} older_than:${+days || 3}d newer_than:30d`, maxResults: 50 });
  const seen = new Set();
  const out = [];
  for (const m of list.data.messages || []) {
    if (seen.has(m.threadId) || out.length >= max) continue;
    seen.add(m.threadId);
    const t = await g.users.threads.get({ userId: 'me', id: m.threadId, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject'] }).catch(() => null);
    const msgs = t && t.data.messages || [];
    const last = msgs[msgs.length - 1];
    if (!last || !(last.labelIds || []).includes('SENT')) continue;   // someone answered after him
    const to = hv(last.payload.headers, 'To');
    // Reports the bot mails to him, and notes-to-self, aren't waiting on anyone.
    if (NOISE_FROM.test(to) || addrOf(to).toLowerCase() === me) continue;
    out.push({
      threadId: m.threadId, to: nameOf(to), toAddr: addrOf(to), subject: hv(last.payload.headers, 'Subject'),
      sentAt: new Date(parseInt(last.internalDate, 10)).toISOString(),
      daysWaiting: Math.floor((Date.now() - parseInt(last.internalDate, 10)) / 86400000),
    });
  }
  return out;
}

function rawMessage({ to, subject, body, inReplyTo, references }) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="direction:rtl;text-align:right;font-family:Arial,sans-serif;">${
    String(body).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</body></html>`;
  const lines = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject || '').toString('base64')}?=`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${references || inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '', html,
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Creates a Gmail draft. With replyToId it threads under that message. Never sends. */
async function draft({ to, subject, body, replyToId }) {
  const g = gmail();
  let threadId;
  let inReplyTo, references;
  if (replyToId) {
    const o = await g.users.messages.get({ userId: 'me', id: replyToId, format: 'metadata', metadataHeaders: ['From', 'Reply-To', 'Subject', 'Message-ID', 'References'] });
    const h = o.data.payload.headers;
    threadId = o.data.threadId;
    to = to || hv(h, 'Reply-To') || hv(h, 'From');
    const s = hv(h, 'Subject');
    subject = subject || (/^re:/i.test(s) ? s : `Re: ${s}`);
    inReplyTo = hv(h, 'Message-ID');
    references = [hv(h, 'References'), inReplyTo].filter(Boolean).join(' ');
  }
  if (!to || !body) throw new Error('חסר נמען או תוכן');
  const r = await g.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw: rawMessage({ to, subject, body, inReplyTo, references }), ...(threadId ? { threadId } : {}) } },
  });
  return { draftId: r.data.id, to, subject, threadId: threadId || r.data.message.threadId, link: 'https://mail.google.com/mail/u/0/#drafts' };
}

async function sendDraft(draftId) {
  const r = await gmail().users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
  return { sent: true, id: r.data.id, threadId: r.data.threadId };
}

async function mark(id, { read, star }) {
  const add = [], remove = [];
  if (read === true) remove.push('UNREAD'); else if (read === false) add.push('UNREAD');
  if (star === true) add.push('STARRED'); else if (star === false) remove.push('STARRED');
  await gmail().users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds: add, removeLabelIds: remove } });
  return { ok: true };
}

async function events(days = 7) {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + Math.min(+days || 7, 60) * 86400000);
  const evs = await cal().fetchEventsRaw(from, to);
  return (evs || []).map(e => ({
    id: e.id, summary: e.summary || '(ללא כותרת)', location: e.location || '',
    start: e.start && (e.start.dateTime || e.start.date), end: e.end && (e.end.dateTime || e.end.date),
    allDay: !!(e.start && e.start.date && !e.start.dateTime), calendar: e.calendarName || '',
  }));
}

function attach(app, guard) {
  const wrap = (fn) => async (req, res) => {
    try { res.json({ ok: true, ...(await fn(req)) }); } catch (e) {
      logger.warn('secretary: ' + (e.message || '').substring(0, 120));
      res.status(500).json({ ok: false, error: (e.message || 'failed').substring(0, 200) });
    }
  };
  app.get('/api/jarvis/mail/inbox', guard, wrap(async (req) => ({ mails: await inbox({ q: req.query.q || undefined, max: req.query.max }) })));
  app.get('/api/jarvis/mail/message', guard, wrap(async (req) => ({ mail: await message(String(req.query.id || '')) })));
  app.get('/api/jarvis/mail/awaiting', guard, wrap(async (req) => ({ threads: await awaiting({ days: req.query.days }) })));
  app.post('/api/jarvis/mail/draft', guard, wrap(async (req) => ({ draft: await draft(req.body || {}) })));
  app.post('/api/jarvis/mail/send-draft', guard, wrap(async (req) => {
    const id = String((req.body || {}).draftId || '');
    if (!id) throw new Error('חסר draftId');
    logger.info('📧 JARVIS sending approved draft ' + id);
    return await sendDraft(id);
  }));
  app.post('/api/jarvis/mail/mark', guard, wrap(async (req) => mark(String((req.body || {}).id || ''), req.body || {})));
  app.get('/api/jarvis/calendar', guard, wrap(async (req) => ({ events: await events(req.query.days) })));
  app.post('/api/jarvis/calendar/event', guard, wrap(async (req) => {
    const { summary, startLocal, endLocal, location } = req.body || {};
    if (!summary || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startLocal || '') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(endLocal || '')) {
      throw new Error('צריך summary, startLocal ו-endLocal בפורמט YYYY-MM-DDTHH:MM');
    }
    const ev = await cal().insertEvent({ summary, startLocal, endLocal, location });
    return { event: { id: ev.id, summary: ev.summary, start: ev.start, link: ev.htmlLink } };
  }));
}

module.exports = { attach, inbox, message, awaiting, draft, sendDraft, mark, events };
