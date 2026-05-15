'use strict';
/**
 * Calendar tool — Google Calendar, per-tenant.
 *
 * Each tenant has its own Google token at data/tenants/{id}/google-token.json.
 * Token is auto-refreshed and persisted.
 */

const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

function tokenPath(tenant) {
  return path.join(tenant.dataDir, 'google-token.json');
}

function isConfigured(tenant) {
  if (!CLIENT_ID || !CLIENT_SECRET) return false;
  return fs.existsSync(tokenPath(tenant));
}

function getAuth(tenant) {
  if (!isConfigured(tenant)) throw new Error('יומן Google לא מחובר עדיין');
  const tokens = JSON.parse(fs.readFileSync(tokenPath(tenant), 'utf8'));
  const oauth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth.setCredentials(tokens);
  oauth.on('tokens', (newTokens) => {
    try {
      const cur = JSON.parse(fs.readFileSync(tokenPath(tenant), 'utf8'));
      fs.writeFileSync(tokenPath(tenant), JSON.stringify({ ...cur, ...newTokens }, null, 2), 'utf8');
    } catch {}
  });
  return oauth;
}

function getCalendar(tenant) {
  return google.calendar({ version: 'v3', auth: getAuth(tenant) });
}

async function fetchAllEvents(tenant, timeMin, timeMax, maxPerCal = 250, maxPages = 10) {
  const cal = getCalendar(tenant);
  const calList = await cal.calendarList.list();
  const calendars = (calList.data.items || []).filter(c => c.selected !== false);
  const results = await Promise.allSettled(calendars.map(async (c) => {
    const collected = [];
    let pageToken;
    for (let p = 0; p < maxPages; p++) {
      const res = await cal.events.list({
        calendarId: c.id, timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
        singleEvents: true, orderBy: 'startTime', maxResults: maxPerCal, pageToken,
      });
      const items = (res.data.items || []).map(e => ({ ...e, calendarName: c.summary, calendarId: c.id }));
      collected.push(...items);
      if (!res.data.nextPageToken) break;
      pageToken = res.data.nextPageToken;
    }
    return collected;
  }));
  const all = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
  all.sort((a, b) => {
    const at = a.start?.dateTime || a.start?.date || '';
    const bt = b.start?.dateTime || b.start?.date || '';
    return at.localeCompare(bt);
  });
  return all;
}

const fmtTime = d => !d ? '' : (d.date ? 'כל היום' :
  new Date(d.dateTime).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }));
const fmtDate = d => !d ? '' :
  new Date(d.dateTime || d.date).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'numeric' });

async function actionToday(tenant) {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(now); end.setHours(23, 59, 59, 999);
  const events = await fetchAllEvents(tenant, start, end);
  if (!events.length) return 'אין אירועים היום.';
  return '📅 *היום:*\n' + events.map((e, i) => {
    const t = e.start?.date ? 'כל היום' : `${fmtTime(e.start)}–${fmtTime(e.end)}`;
    return `${i + 1}. ${e.summary} (${t})${e.location ? ' 📍 ' + e.location : ''}`;
  }).join('\n');
}

async function actionWeek(tenant) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const weekEnd = new Date(now.getTime() + 7 * 86400000);
  const events = await fetchAllEvents(tenant, now, weekEnd);
  if (!events.length) return 'אין אירועים השבוע.';
  const byDate = new Map();
  for (const e of events) {
    const k = fmtDate(e.start);
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(e);
  }
  let out = '📅 *השבוע:*\n';
  for (const [d, items] of byDate) {
    out += `\n*${d}*\n`;
    for (const e of items) {
      const t = e.start?.date ? 'כל היום' : `${fmtTime(e.start)}–${fmtTime(e.end)}`;
      out += `• ${e.summary} (${t})${e.location ? ' 📍' + e.location : ''}\n`;
    }
  }
  return out.trim();
}

async function actionEvents(tenant, days = 7) {
  const now = new Date();
  const end = new Date(now.getTime() + days * 86400000);
  const events = await fetchAllEvents(tenant, now, end);
  if (!events.length) return `אין אירועים ב-${days} הימים הקרובים.`;
  return events.slice(0, 30).map((e, i) => {
    const t = e.start?.date ? 'כל היום' : `${fmtTime(e.start)}–${fmtTime(e.end)}`;
    return `${i + 1}. ${e.summary} (${fmtDate(e.start)}, ${t})`;
  }).join('\n');
}

async function actionAdd(tenant, eventText) {
  const cal = getCalendar(tenant);
  const parsed = parseEventText(eventText);
  if (!parsed) return `❌ לא הצלחתי להבין את הטקסט. תרשום: "כותרת בתאריך DD/MM בשעה HH:MM"`;
  const event = {
    summary: parsed.summary,
    start: { dateTime: parsed.start.toISOString(), timeZone: 'Asia/Jerusalem' },
    end: { dateTime: parsed.end.toISOString(), timeZone: 'Asia/Jerusalem' },
  };
  if (parsed.location) event.location = parsed.location;
  const res = await cal.events.insert({ calendarId: 'primary', requestBody: event });
  return `✅ אירוע נוסף: "${res.data.summary}" — ${fmtDate(res.data.start)} ${fmtTime(res.data.start)}`;
}

async function actionDelete(tenant, index) {
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 86400000);
  const events = await fetchAllEvents(tenant, now, future);
  if (!index || index < 1 || index > events.length) return `❌ אינדקס לא תקין. יש ${events.length} אירועים קרובים.`;
  const target = events[index - 1];
  const cal = getCalendar(tenant);
  await cal.events.delete({ calendarId: target.calendarId || 'primary', eventId: target.id });
  return `✅ נמחק: "${target.summary}" (${fmtDate(target.start)} ${fmtTime(target.start)})`;
}

function parseEventText(text) {
  const now = new Date();
  let summary = text;
  const tm = text.match(/\b(\d{1,2}):(\d{2})\b/);
  let hours = null, minutes = null;
  if (tm) { hours = parseInt(tm[1]); minutes = parseInt(tm[2]); summary = summary.replace(tm[0], '').trim(); }
  let day = now.getDate(), month = now.getMonth(), year = now.getFullYear();
  if (/\bמחר\b/.test(text)) {
    const d = new Date(now); d.setDate(d.getDate() + 1);
    day = d.getDate(); month = d.getMonth(); year = d.getFullYear();
    summary = summary.replace('מחר', '').trim();
  } else if (/\bהיום\b/.test(text)) {
    summary = summary.replace('היום', '').trim();
  } else {
    const dm = text.match(/\b(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?\b/);
    if (dm) {
      day = parseInt(dm[1]); month = parseInt(dm[2]) - 1;
      if (dm[3]) year = parseInt(dm[3].length === 2 ? '20' + dm[3] : dm[3]);
      summary = summary.replace(dm[0], '').trim();
    }
  }
  if (hours === null) return null;
  let dt = new Date(year, month, day, hours, minutes, 0);
  if (dt < now && !/\bמחר\b/.test(text)) dt.setDate(dt.getDate() + 1);
  let durationMin = 60;
  const dur = text.match(/(?:למשך|ל-)\s*(\d+)\s*(דקות|דק|שעות|שעה)/);
  if (dur) {
    const n = parseInt(dur[1]);
    durationMin = /שעה|שעות/.test(dur[2]) ? n * 60 : n;
    summary = summary.replace(dur[0], '').trim();
  }
  summary = summary.replace(/\b(תקבע|פגישה|אירוע|תשים|תוסיף|לי|ב-)\b/g, ' ').replace(/\s+/g, ' ').trim() || 'אירוע';
  return { summary, start: dt, end: new Date(dt.getTime() + durationMin * 60000), location: null };
}

async function run({ action, event_text, index, days }, { tenant }) {
  if (!tenant) return '❌ tenant חסר';
  if (!isConfigured(tenant)) return '❌ יומן Google עדיין לא חובר. שלח "חבר יומן" כדי לקבל קישור.';
  try {
    switch (action) {
      case 'today':  return await actionToday(tenant);
      case 'week':   return await actionWeek(tenant);
      case 'events': return await actionEvents(tenant, days);
      case 'add':    return await actionAdd(tenant, event_text);
      case 'delete': return await actionDelete(tenant, index);
      default: return `❌ פעולה לא מוכרת: ${action}`;
    }
  } catch (e) {
    return `❌ שגיאה ביומן: ${e.message?.substring(0, 100)}`;
  }
}

module.exports = { run, isConfigured };
