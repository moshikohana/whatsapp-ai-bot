'use strict';
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Store last queried events for reference by number
let lastEvents = [];

// ─── Singleton auth client ───────────────────────────────────────
let _authClient = null;

function updateEnvToken(tokens) {
  try {
    const existing = JSON.parse(process.env.GOOGLE_TOKEN || '{}');
    const merged = { ...existing, ...tokens };
    // Don't overwrite refresh_token with null/undefined
    if (!tokens.refresh_token && existing.refresh_token) {
      merged.refresh_token = existing.refresh_token;
    }
    process.env.GOOGLE_TOKEN = JSON.stringify(merged);

    // Persist to .env file
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf-8');
      const tokenLine = `GOOGLE_TOKEN=${JSON.stringify(merged)}`;
      if (/^GOOGLE_TOKEN=/m.test(envContent)) {
        envContent = envContent.replace(/^GOOGLE_TOKEN=.*/m, tokenLine);
      } else {
        envContent += `\n${tokenLine}`;
      }
      fs.writeFileSync(envPath, envContent, 'utf-8');
      console.log('💾 Google token saved to .env');
    }
  } catch (e) {
    console.warn('⚠️ Failed to save Google token:', e.message);
  }
}

function getAuthClient() {
  if (_authClient) return _authClient;
  if (!process.env.GOOGLE_CREDENTIALS) throw new Error('GOOGLE_CREDENTIALS לא מוגדר ב-.env');
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  if (process.env.GOOGLE_TOKEN) {
    auth.setCredentials(JSON.parse(process.env.GOOGLE_TOKEN));
    auth.on('tokens', (newTokens) => {
      console.log('🔄 Google token refreshed — saving...');
      updateEnvToken(newTokens);
    });
  }
  _authClient = auth;
  return auth;
}

// Called after successful re-auth to reset the singleton
function resetAuthClient() {
  _authClient = null;
}

function getCalendar() {
  return google.calendar({ version: 'v3', auth: getAuthClient() });
}

// Local date key (YYYY-MM-DD) — avoids UTC timezone bugs
function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Extract local date from event start
function eventLocalDate(start) {
  if (!start) return null;
  if (start.date) return start.date; // all-day events are already YYYY-MM-DD
  if (start.dateTime) {
    // dateTime like "2025-04-14T10:00:00+03:00" — parse to local Date, then get local date
    const d = new Date(start.dateTime);
    return localDateKey(d);
  }
  return null;
}

// ─── Fetch events from ALL calendars (with pagination) ──────────
// Uses nextPageToken to fetch ALL events in the range, not just the first page.
// Safety cap: maxPagesPerCal prevents runaway loops on huge calendars.
async function fetchAllEvents(timeMin, timeMax, maxPerCal = 250, maxPagesPerCal = 10) {
  const calendar = getCalendar();

  // Get all calendars the user has access to
  const calList = await calendar.calendarList.list();
  const calendars = (calList.data.items || []).filter(c => c.selected !== false);

  console.log(`📅 Fetching from ${calendars.length} calendars: ${calendars.map(c => c.summary).join(', ')}`);

  // Helper: fetch ALL pages for a single calendar
  async function fetchAllPagesForCalendar(cal) {
    const collected = [];
    let pageToken = undefined;
    let pages = 0;
    while (pages < maxPagesPerCal) {
      const res = await calendar.events.list({
        calendarId: cal.id,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: maxPerCal,
        pageToken,
      });
      const items = (res.data.items || []).map(event => ({
        ...event,
        calendarName: cal.summary,
        calendarId: cal.id,
      }));
      collected.push(...items);
      pages++;
      if (!res.data.nextPageToken) break;
      pageToken = res.data.nextPageToken;
    }
    if (pages >= maxPagesPerCal) {
      console.warn(`⚠️  Calendar "${cal.summary}" hit page cap (${maxPagesPerCal} × ${maxPerCal}) — some events may be missing`);
    }
    return collected;
  }

  // Fetch events from each calendar in parallel
  const results = await Promise.allSettled(calendars.map(fetchAllPagesForCalendar));

  // Log any per-calendar failures so silent fetch errors don't hide events
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`⚠️  Calendar "${calendars[i].summary}" fetch failed:`, r.reason?.message || r.reason);
    }
  });

  // Merge and sort by start time
  const allEvents = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => {
      const aTime = a.start?.dateTime || a.start?.date || '';
      const bTime = b.start?.dateTime || b.start?.date || '';
      return aTime.localeCompare(bTime);
    });

  console.log(`📅 Total events fetched: ${allEvents.length}`);
  return allEvents;
}

// ─── Today's Schedule ────────────────────────────────────────────
async function getTodaySchedule() {
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);

  const events = await fetchAllEvents(startOfDay, endOfDay);

  lastEvents = events.map((event, i) => ({
    id: event.id,
    calendarId: event.calendarId,
    calendarName: event.calendarName,
    index: i + 1,
    summary: event.summary || 'ללא שם',
    start: event.start,
    end: event.end,
    location: event.location || null,
    description: event.description || null,
    allDay: !!event.start?.date,
  }));

  return lastEvents;
}

// ─── Get Events (N days) ─────────────────────────────────────────
async function getCalendarEvents(days = 7) {
  const now = new Date();
  const future = new Date(now.getTime() + days * 86400000);

  const events = await fetchAllEvents(now, future);

  lastEvents = events.map((event, i) => ({
    id: event.id,
    calendarId: event.calendarId,
    calendarName: event.calendarName,
    index: i + 1,
    summary: event.summary || 'ללא שם',
    start: event.start,
    end: event.end,
    location: event.location || null,
    description: event.description || null,
    allDay: !!event.start?.date,
  }));

  return lastEvents;
}

// ─── Week Schedule (grouped by day) ──────────────────────────────
async function getWeekSchedule() {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const weekEnd = new Date(now.getTime() + 7 * 86400000);

  const events = await fetchAllEvents(now, weekEnd);
  const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const days = {};

  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const key = localDateKey(d);
    days[key] = {
      name: dayNames[d.getDay()],
      date: d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long' }),
      events: [],
      isToday: i === 0,
    };
  }

  events.forEach(event => {
    const eventDate = eventLocalDate(event.start);
    if (eventDate && days[eventDate]) {
      days[eventDate].events.push({
        summary: event.summary || 'ללא שם',
        startTime: formatTimeOnly(event.start),
        endTime: formatTimeOnly(event.end),
        location: event.location,
        allDay: !!event.start?.date,
        calendar: event.calendarName,
      });
    }
  });

  return days;
}

// ─── List All Calendars ──────────────────────────────────────────
async function getAllCalendars() {
  const calendar = getCalendar();
  const res = await calendar.calendarList.list();
  return (res.data.items || []).map(cal => ({
    id: cal.id,
    name: cal.summary,
    primary: cal.primary || false,
    color: cal.backgroundColor,
  }));
}

// ─── Search Events (across all calendars) ────────────────────────
async function searchCalendarEvents(query) {
  const calendar = getCalendar();
  const now = new Date();
  const past = new Date(now.getTime() - 30 * 86400000);
  const future = new Date(now.getTime() + 90 * 86400000);

  // Search across all calendars
  const calList = await calendar.calendarList.list();
  const calendars = (calList.data.items || []).filter(c => c.selected !== false);

  const results = await Promise.allSettled(
    calendars.map(cal =>
      calendar.events.list({
        calendarId: cal.id,
        timeMin: past.toISOString(),
        timeMax: future.toISOString(),
        q: query,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 10,
      }).then(res => (res.data.items || []).map(e => ({ ...e, calendarId: cal.id, calendarName: cal.summary })))
    )
  );

  const allEvents = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value)
    .sort((a, b) => (a.start?.dateTime || a.start?.date || '').localeCompare(b.start?.dateTime || b.start?.date || ''));

  lastEvents = allEvents.map((event, i) => ({
    id: event.id,
    calendarId: event.calendarId,
    index: i + 1,
    summary: event.summary || 'ללא שם',
    start: event.start,
    end: event.end,
    startFormatted: formatEventTime(event.start),
    location: event.location || null,
    description: event.description || null,
  }));

  return lastEvents;
}

// ─── Delete Event ────────────────────────────────────────────────
async function deleteCalendarEvent(index) {
  if (!lastEvents[index - 1]) throw new Error(`אירוע מספר ${index} לא נמצא`);
  const event = lastEvents[index - 1];
  const calendar = getCalendar();
  await calendar.events.delete({ calendarId: event.calendarId || 'primary', eventId: event.id });
  return event;
}

// ─── Update Event ────────────────────────────────────────────────
async function updateCalendarEvent(index, updates) {
  if (!lastEvents[index - 1]) throw new Error(`אירוע מספר ${index} לא נמצא`);
  const event = lastEvents[index - 1];
  const calendar = getCalendar();

  const resource = {};
  if (updates.summary) resource.summary = updates.summary;
  if (updates.location) resource.location = updates.location;
  if (updates.description) resource.description = updates.description;

  const res = await calendar.events.patch({
    calendarId: event.calendarId || 'primary', eventId: event.id, resource,
  });

  return { summary: res.data.summary, start: formatEventTime(res.data.start) };
}

// ─── Get Event Details ───────────────────────────────────────────
function getEventByIndex(index) {
  return lastEvents[index - 1] || null;
}

// ─── Build RRULE from recurrence options ────────────────────────
function buildRecurrenceRule(options) {
  if (!options || !options.recurrence) return null;

  const freqMap = {
    daily: 'DAILY',
    weekly: 'WEEKLY',
    monthly: 'MONTHLY',
    yearly: 'YEARLY',
    weekdays: 'WEEKLY',
    custom: 'WEEKLY',
  };

  const freq = freqMap[options.recurrence];
  if (!freq) return null;

  let rule = `RRULE:FREQ=${freq}`;

  // Weekdays = Sunday-Thursday (Israeli work week)
  if (options.recurrence === 'weekdays') {
    rule += ';BYDAY=SU,MO,TU,WE,TH';
  }

  // Custom days
  if (options.recurrence === 'custom' && options.recurrence_days?.length > 0) {
    rule += `;BYDAY=${options.recurrence_days.join(',')}`;
  }

  // Count limit
  if (options.recurrence_count) {
    rule += `;COUNT=${options.recurrence_count}`;
  }

  // Until date
  if (options.recurrence_until) {
    const until = options.recurrence_until.replace(/-/g, '') + 'T235959Z';
    rule += `;UNTIL=${until}`;
  }

  return rule;
}

// ─── Align start date to match BYDAY recurrence ─────────────────
function alignStartToRecurrenceDay(startTime, endTime, recurrenceOptions) {
  if (!recurrenceOptions) return { startTime, endTime };

  const dayMap = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  let targetDays = null;

  if (recurrenceOptions.recurrence === 'weekdays') {
    targetDays = [0, 1, 2, 3, 4]; // SU-TH
  } else if (recurrenceOptions.recurrence_days?.length > 0) {
    targetDays = recurrenceOptions.recurrence_days.map(d => dayMap[d]).filter(d => d !== undefined);
  }

  if (!targetDays || targetDays.length === 0) return { startTime, endTime };

  const currentDay = startTime.getDay();
  if (targetDays.includes(currentDay)) return { startTime, endTime };

  // Find nearest future matching day
  for (let i = 1; i <= 7; i++) {
    const nextDay = (currentDay + i) % 7;
    if (targetDays.includes(nextDay)) {
      const duration = endTime.getTime() - startTime.getTime();
      const newStart = new Date(startTime);
      newStart.setDate(newStart.getDate() + i);
      const newEnd = new Date(newStart.getTime() + duration);
      return { startTime: newStart, endTime: newEnd };
    }
  }
  return { startTime, endTime };
}

// ─── Add Event ───────────────────────────────────────────────────
async function addCalendarEvent(eventText, recurrenceOptions) {
  const calendar = getCalendar();
  let { summary, startTime, endTime } = parseEventText(eventText);

  // For recurring events, align start date to match the BYDAY rule
  ({ startTime, endTime } = alignStartToRecurrenceDay(startTime, endTime, recurrenceOptions));

  const event = {
    summary,
    start: { dateTime: startTime.toISOString(), timeZone: 'Asia/Jerusalem' },
    end: { dateTime: endTime.toISOString(), timeZone: 'Asia/Jerusalem' },
  };

  // Add recurrence rule if specified
  const rrule = buildRecurrenceRule(recurrenceOptions);
  if (rrule) {
    event.recurrence = [rrule];
  }

  const res = await calendar.events.insert({ calendarId: 'primary', resource: event });

  const result = { summary: res.data.summary, start: formatEventTime(res.data.start) };
  if (rrule) {
    result.recurrence = rrule;
    result.recurring = true;
  }
  return result;
}

// ─── Parse Event Text ────────────────────────────────────────────
function parseEventText(text) {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);

  let startTime = new Date(tomorrow);
  let summary = text;
  let duration = 60;
  let dateSet = false;

  // Parse time: "ב-10:00", "בשעה 10:00", "at 10:00", "10:00", "3pm"
  const timeMatch = text.match(/(?:בשעה\s*|ב-?|at\s*)(\d{1,2}):(\d{2})|(\d{1,2})(pm|am)/i);
  if (timeMatch) {
    let hours, minutes = 0;
    if (timeMatch[1]) { hours = parseInt(timeMatch[1]); minutes = parseInt(timeMatch[2]); }
    else { hours = parseInt(timeMatch[3]); if (timeMatch[4].toLowerCase() === 'pm' && hours < 12) hours += 12; }
    startTime.setHours(hours, minutes, 0, 0);
    summary = text.replace(timeMatch[0], '').trim();
  }

  // Parse duration
  const durMatch = text.match(/(\d+)\s*שעות?|שעתיים|חצי שעה|(\d+)\s*דקות?/);
  if (durMatch) {
    if (durMatch[0].includes('שעתיים')) duration = 120;
    else if (durMatch[0].includes('חצי שעה')) duration = 30;
    else if (durMatch[1]) duration = parseInt(durMatch[1]) * 60;
    else if (durMatch[2]) duration = parseInt(durMatch[2]);
    summary = summary.replace(durMatch[0], '').trim();
  }

  // Parse specific date: DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY, YYYY-MM-DD
  // Also capture leading "ב-" or "ביום " prefix to remove from summary
  const dateMatch = text.match(/(?:ביום\s+|ב-?)?(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/);
  const isoDateMatch = !dateMatch ? text.match(/(?:ביום\s+|ב-?)?(\d{4})-(\d{2})-(\d{2})/) : null;
  if (dateMatch) {
    const day = parseInt(dateMatch[1]);
    const month = parseInt(dateMatch[2]) - 1;
    const year = parseInt(dateMatch[3]);
    startTime.setFullYear(year, month, day);
    summary = summary.replace(dateMatch[0], '').trim();
    dateSet = true;
  } else if (isoDateMatch) {
    const year = parseInt(isoDateMatch[1]);
    const month = parseInt(isoDateMatch[2]) - 1;
    const day = parseInt(isoDateMatch[3]);
    startTime.setFullYear(year, month, day);
    summary = summary.replace(isoDateMatch[0], '').trim();
    dateSet = true;
  }

  // Parse day (only if no specific date was set)
  if (!dateSet) {
    if (/מחרתיים/i.test(text)) {
      const d = new Date(); d.setDate(d.getDate() + 2);
      startTime.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
      summary = summary.replace(/מחרתיים/gi, '').trim();
      dateSet = true;
    } else if (/מחר|tomorrow/i.test(text)) {
      const d = new Date(); d.setDate(d.getDate() + 1);
      startTime.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
      summary = summary.replace(/מחר|tomorrow/gi, '').trim();
      dateSet = true;
    } else if (/היום|today/i.test(text)) {
      const d = new Date();
      startTime.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
      summary = summary.replace(/היום|today/gi, '').trim();
      dateSet = true;
    }
  }

  // Parse specific days: ביום ראשון, יום ראשון, כל יום ראשון, etc.
  if (!dateSet) {
    const dayNames = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 };
    const dayMatch = text.match(/(?:כל\s+|ב)?יום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
    if (dayMatch) {
      const targetDay = dayNames[dayMatch[1]];
      const d = new Date();
      const diff = (targetDay - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
      startTime.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
      summary = summary.replace(dayMatch[0], '').trim();
      dateSet = true;
    }
  }

  // Clean up summary: remove scheduling words, trailing prepositions, dashes
  summary = summary
    .replace(/כל\s*/g, '')
    .replace(/[-–—]\s*/g, ' ')
    .replace(/\bב\s*$/g, '')        // trailing "ב"
    .replace(/\bביום\s*$/g, '')     // trailing "ביום"
    .replace(/\s+/g, ' ')
    .trim() || text;
  const endTime = new Date(startTime.getTime() + duration * 60000);
  return { summary, startTime, endTime };
}

// ─── Format Helpers ──────────────────────────────────────────────
function formatEventTime(eventTime) {
  if (!eventTime) return 'לא ידוע';
  if (eventTime.date) {
    return new Date(eventTime.date).toLocaleDateString('he-IL', {
      weekday: 'long', month: 'long', day: 'numeric',
    });
  }
  return new Date(eventTime.dateTime).toLocaleString('he-IL', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatTimeOnly(eventTime) {
  if (!eventTime) return '';
  if (eventTime.date) return 'כל היום';
  return new Date(eventTime.dateTime).toLocaleTimeString('he-IL', {
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── Pure events fetch (no lastEvents side effect) ───────────────
// Used by Command Center to peek at upcoming events without trampling
// the user-facing lastEvents state used by "list/delete by index".
async function fetchEventsRaw(timeMin, timeMax) {
  return await fetchAllEvents(timeMin, timeMax);
}

module.exports = {
  getCalendarEvents,
  getTodaySchedule,
  getWeekSchedule,
  getAllCalendars,
  searchCalendarEvents,
  deleteCalendarEvent,
  updateCalendarEvent,
  getEventByIndex,
  addCalendarEvent,
  fetchEventsRaw,
  formatEventTime,
  formatTimeOnly,
  getAuthClient,
  resetAuthClient,
  updateEnvToken,
};
