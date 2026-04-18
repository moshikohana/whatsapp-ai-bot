'use strict';
const { google } = require('googleapis');

// Store last queried emails for reference by number
let lastEmails = [];

// ─── Singleton auth client (shared token persistence via calendar.js) ─
let _authClient = null;

function getAuth() {
  if (_authClient) return _authClient;
  if (!process.env.GOOGLE_CREDENTIALS) throw new Error('GOOGLE_CREDENTIALS לא מוגדר ב-.env');
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  if (!process.env.GOOGLE_TOKEN) throw new Error('GOOGLE_TOKEN לא מוגדר — הרץ: node setup-google.js');
  auth.setCredentials(JSON.parse(process.env.GOOGLE_TOKEN));
  auth.on('tokens', (newTokens) => {
    console.log('🔄 Gmail token refreshed — saving...');
    // Delegate to calendar's updateEnvToken to keep both in sync
    try { require('./calendar').updateEnvToken(newTokens); } catch (_) {}
  });
  _authClient = auth;
  return auth;
}

function resetAuth() {
  _authClient = null;
}

function getGmail() {
  return google.gmail({ version: 'v1', auth: getAuth() });
}

function headerVal(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function parseFrom(from) {
  const match = from.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : from.split('@')[0];
}

function formatDate(internalDate) {
  return new Date(parseInt(internalDate)).toLocaleString('he-IL', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function formatDateFull(internalDate) {
  return new Date(parseInt(internalDate)).toLocaleString('he-IL', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

async function fetchMessages(gmail, ids) {
  return Promise.all(ids.map(id =>
    gmail.users.messages.get({
      userId: 'me', id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'To', 'Date', 'Cc'],
    })
  ));
}

// ─── Get Unread Emails ───────────────────────────────────────────
async function getUnreadEmails(maxResults = 8) {
  const gmail = getGmail();
  const list = await gmail.users.messages.list({
    userId: 'me', q: 'is:unread in:inbox', maxResults,
  });

  if (!list.data.messages?.length) return '📭 אין מיילים שלא נקראו — הכל נקי! 🎉';

  const msgs = await fetchMessages(gmail, list.data.messages.map(m => m.id));

  lastEmails = msgs.map((r, i) => ({
    id: r.data.id,
    threadId: r.data.threadId,
    index: i + 1,
    subject: headerVal(r.data.payload.headers, 'Subject') || '(ללא נושא)',
    from: headerVal(r.data.payload.headers, 'From'),
    fromName: parseFrom(headerVal(r.data.payload.headers, 'From')),
    to: headerVal(r.data.payload.headers, 'To'),
    date: formatDate(r.data.internalDate),
    labels: r.data.labelIds || [],
    snippet: r.data.snippet,
  }));

  let text = `📧 *תיבת דואר — ${lastEmails.length} שלא נקראו*\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  lastEmails.forEach(m => {
    const star = m.labels.includes('STARRED') ? ' ⭐' : '';
    text += `*${m.index}.* *${m.subject}*${star}\n`;
    text += `    👤 ${m.fromName}  ·  🕐 ${m.date}\n\n`;
  });

  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `📖 */קרא [#]* · ↩️ */השב [#] [טקסט]*\n`;
  text += `✅ */סמן [#]* · ⭐ */כוכב [#]* · 🗑️ */זרוק [#]*`;

  return text;
}

// ─── Search Emails ───────────────────────────────────────────────
async function searchEmails(query, maxResults = 8) {
  const gmail = getGmail();
  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });

  if (!list.data.messages?.length) return `📭 לא נמצאו מיילים עבור: "${query}"`;

  const msgs = await fetchMessages(gmail, list.data.messages.map(m => m.id));

  lastEmails = msgs.map((r, i) => ({
    id: r.data.id,
    threadId: r.data.threadId,
    index: i + 1,
    subject: headerVal(r.data.payload.headers, 'Subject') || '(ללא נושא)',
    from: headerVal(r.data.payload.headers, 'From'),
    fromName: parseFrom(headerVal(r.data.payload.headers, 'From')),
    to: headerVal(r.data.payload.headers, 'To'),
    date: formatDate(r.data.internalDate),
    labels: r.data.labelIds || [],
    snippet: r.data.snippet,
  }));

  let text = `🔍 *חיפוש: "${query}"* — ${lastEmails.length} תוצאות\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  lastEmails.forEach(m => {
    const unread = m.labels.includes('UNREAD') ? ' 🔵' : '';
    const star = m.labels.includes('STARRED') ? ' ⭐' : '';
    text += `*${m.index}.* *${m.subject}*${unread}${star}\n`;
    text += `    👤 ${m.fromName}  ·  🕐 ${m.date}\n\n`;
  });

  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `📖 */קרא [#]* · ↩️ */השב [#] [טקסט]*\n`;
  text += `✅ */סמן [#]* · ⭐ */כוכב [#]* · 🗑️ */זרוק [#]*`;

  return text;
}

// ─── Read Full Email ─────────────────────────────────────────────
async function readEmail(index) {
  if (!lastEmails[index - 1]) throw new Error(`מייל מספר ${index} לא נמצא. שלח /אימייל קודם`);

  const gmail = getGmail();
  const email = lastEmails[index - 1];

  const msg = await gmail.users.messages.get({
    userId: 'me', id: email.id, format: 'full',
  });

  const headers = msg.data.payload.headers;
  const subject = headerVal(headers, 'Subject') || '(ללא נושא)';
  const from = headerVal(headers, 'From');
  const to = headerVal(headers, 'To');
  const cc = headerVal(headers, 'Cc');
  const date = formatDateFull(msg.data.internalDate);

  // Extract body text
  let body = extractBody(msg.data.payload);
  if (body.length > 1500) body = body.substring(0, 1500) + '\n\n_...קוצר לתצוגה_';

  let text = `📧 *${subject}*\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  text += `👤 *מאת:* ${parseFrom(from)}\n`;
  text += `📬 *אל:* ${to}\n`;
  if (cc) text += `📋 *עותק:* ${cc}\n`;
  text += `🕐 *תאריך:* ${date}\n\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  text += body || '_אין תוכן טקסט_';
  text += `\n\n━━━━━━━━━━━━━━━━━━━━\n`;
  text += `↩️ */השב ${index} [טקסט]* · ✅ */סמן ${index}* · 🗑️ */זרוק ${index}*`;

  return text;
}

function extractBody(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    // Prefer text/plain
    const textPart = findPart(payload.parts, 'text/plain');
    if (textPart?.body?.data) return Buffer.from(textPart.body.data, 'base64').toString('utf-8');
    // Fallback: text/html → strip tags
    const htmlPart = findPart(payload.parts, 'text/html');
    if (htmlPart?.body?.data) {
      let html = Buffer.from(htmlPart.body.data, 'base64').toString('utf-8');
      return html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
    }
  }
  return '';
}

function findPart(parts, mimeType) {
  for (const part of parts) {
    if (part.mimeType === mimeType) return part;
    if (part.parts) {
      const found = findPart(part.parts, mimeType);
      if (found) return found;
    }
  }
  return null;
}

// ─── Send Email ──────────────────────────────────────────────────
async function sendEmail(to, subject, body) {
  const gmail = getGmail();

  // Convert newlines to <br> for HTML
  const htmlBody = body.replace(/\n/g, '<br>');
  const html = `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"></head><body style="direction:rtl; text-align:right; font-family:Arial,sans-serif;">${htmlBody}</body></html>`;

  const raw = Buffer.from(
    `To: ${to}\r\n` +
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/html; charset=utf-8\r\n\r\n` +
    html
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return `✅ *נשלח בהצלחה!*\n📬 אל: ${to}\n📌 נושא: ${subject}`;
}

// ─── Reply to Email ──────────────────────────────────────────────
async function replyToEmail(index, replyText) {
  if (!lastEmails[index - 1]) throw new Error(`מייל מספר ${index} לא נמצא`);

  const gmail = getGmail();
  const email = lastEmails[index - 1];

  const original = await gmail.users.messages.get({
    userId: 'me', id: email.id, format: 'metadata',
    metadataHeaders: ['Subject', 'From', 'Message-ID'],
  });

  const headers = original.data.payload.headers;
  const originalFrom = headerVal(headers, 'From');
  const originalSubject = headerVal(headers, 'Subject');
  const messageId = headerVal(headers, 'Message-ID');
  const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;

  const raw = Buffer.from(
    `To: ${originalFrom}\r\n` +
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\n` +
    `In-Reply-To: ${messageId}\r\n` +
    `References: ${messageId}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    replyText
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: email.threadId },
  });

  return `↩️ *תשובה נשלחה!*\n📬 אל: ${parseFrom(originalFrom)}\n📌 ${subject}`;
}

// ─── Mark as Read ────────────────────────────────────────────────
async function markAsRead(index) {
  if (!lastEmails[index - 1]) throw new Error(`מייל מספר ${index} לא נמצא`);
  const gmail = getGmail();
  await gmail.users.messages.modify({
    userId: 'me', id: lastEmails[index - 1].id,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
  return `✅ מייל *"${lastEmails[index - 1].subject}"* סומן כנקרא`;
}

// ─── Trash Email ─────────────────────────────────────────────────
async function trashEmail(index) {
  if (!lastEmails[index - 1]) throw new Error(`מייל מספר ${index} לא נמצא`);
  const gmail = getGmail();
  await gmail.users.messages.trash({ userId: 'me', id: lastEmails[index - 1].id });
  return `🗑️ מייל *"${lastEmails[index - 1].subject}"* הועבר לפח`;
}

// ─── Star Email ──────────────────────────────────────────────────
async function starEmail(index) {
  if (!lastEmails[index - 1]) throw new Error(`מייל מספר ${index} לא נמצא`);
  const gmail = getGmail();
  const email = lastEmails[index - 1];
  const isStarred = email.labels.includes('STARRED');

  await gmail.users.messages.modify({
    userId: 'me', id: email.id,
    requestBody: isStarred
      ? { removeLabelIds: ['STARRED'] }
      : { addLabelIds: ['STARRED'] },
  });

  return isStarred
    ? `☆ הכוכב הוסר מ-*"${email.subject}"*`
    : `⭐ כוכב נוסף ל-*"${email.subject}"*`;
}

// ─── Gmail Stats ─────────────────────────────────────────────────
async function getGmailStats() {
  const gmail = getGmail();
  const [prof, unread, starred] = await Promise.all([
    gmail.users.getProfile({ userId: 'me' }),
    gmail.users.messages.list({ userId: 'me', q: 'is:unread in:inbox', maxResults: 1 }),
    gmail.users.messages.list({ userId: 'me', q: 'is:starred', maxResults: 1 }),
  ]);

  const unreadCount = unread.data.resultSizeEstimate || 0;
  const starredCount = starred.data.resultSizeEstimate || 0;

  let text = `📊 *Gmail — סטטיסטיקות*\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  text += `📬 *כתובת:* ${prof.data.emailAddress}\n`;
  text += `📨 *הודעות:* ${prof.data.messagesTotal?.toLocaleString()}\n`;
  text += `🧵 *שיחות:* ${prof.data.threadsTotal?.toLocaleString()}\n`;
  text += `🔵 *שלא נקראו:* ${unreadCount}\n`;
  text += `⭐ *מסומנים:* ${starredCount}\n\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `📧 /אימייל · 🔍 /אימייל [חיפוש] · ✉️ /שלחמייל`;

  return text;
}

module.exports = {
  getUnreadEmails,
  searchEmails,
  readEmail,
  sendEmail,
  replyToEmail,
  markAsRead,
  trashEmail,
  starEmail,
  getGmailStats,
  resetAuth,
};
