'use strict';

/**
 * Command Center — proactive layer that watches state and triggers alerts
 * to Moshiko on WhatsApp before he asks. Built progressively in 5 capabilities:
 *
 *   1.1  Pending media follow-up           ← THIS FILE (started)
 *   1.2  30-min interview brief            ← TODO
 *   1.3  60-min Waze ETA                   ← TODO
 *   1.4  Trending keyword auto-pitch       ← TODO
 *   1.5  Voice call → calendar/media sync  ← TODO
 *
 * Design: each capability is an independent function the runtime calls on
 * a cron schedule. Each maintains its own cooldown state in
 * data/command-center-state.json so we don't re-alert on the same item.
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'command-center-state.json');

const DEFAULT_STATE = {
  media_alerts: {},      // { [contactId]: { outreachAt: ISO, lastAlertedAt: ISO } }
  event_alerts: {},      // { [eventId]: { brief?: { alertedAt }, waze?: { alertedAt } } }
  keyword_alerts: {},    // { [keyword]: { alertedAt: ISO } }
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) };
    }
  } catch (e) {
    console.error('⚠️ command-center state read failed:', e.message);
  }
  return { ...DEFAULT_STATE };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('⚠️ command-center state save failed:', e.message);
  }
}

function fmtHoursAgo(isoDate) {
  if (!isoDate) return '—';
  const ms = Date.now() - new Date(isoDate).getTime();
  const hours = Math.round(ms / (1000 * 60 * 60));
  if (hours < 24) return `לפני ${hours} שעות`;
  const days = Math.round(hours / 24);
  return `לפני ${days} ימים`;
}

// ─── Capability #1.1: Pending media follow-up ─────────────────────────
/**
 * Returns alerts to send for media contacts that have been pending too long.
 * Caller passes hours threshold (default 6) and re-alert cooldown (default 12).
 *
 * Returns: [{ contactId, text }] — empty array if nothing to alert on.
 * Side effect: marks each returned contact as alerted in state file.
 */
function checkPendingMedia({ hoursThreshold = 6, reAlertHours = 12 } = {}) {
  const tracker = require('./media-tracker');
  const pending = tracker.getPendingContacts(hoursThreshold);
  if (!pending.length) return [];

  const state = loadState();
  const now = Date.now();
  const alerts = [];

  for (const c of pending) {
    const slot = state.media_alerts[c.id];
    const outreachIso = c.lastOutreach;

    // Reset slot if this is a fresh outreach (different from last alerted)
    const isSameOutreach = slot && slot.outreachAt === outreachIso;

    if (isSameOutreach) {
      // Same outreach we already alerted on — only re-alert after cooldown
      const lastAlerted = new Date(slot.lastAlertedAt).getTime();
      if (now - lastAlerted < reAlertHours * 60 * 60 * 1000) continue;
    }

    // Build the alert
    const hoursLabel = fmtHoursAgo(outreachIso);
    const text = [
      `🔔 *פנייה תקשורת בלי תגובה*`,
      ``,
      `📰 ${c.name} — ${c.outlet}`,
      `📌 נושא: ${c.lastTopic || '—'}`,
      `⏱ פנייה: ${hoursLabel}`,
      ``,
      `💡 לדחוף עכשיו? אמור: "תדחוף את ${c.name.split(' ')[0]}"`,
      `🔇 לא היום? אמור: "התעלם מ${c.name.split(' ')[0]}"`,
    ].join('\n');

    alerts.push({ contactId: c.id, text });

    // Update state
    state.media_alerts[c.id] = {
      outreachAt: outreachIso,
      lastAlertedAt: new Date().toISOString(),
    };
  }

  if (alerts.length) saveState(state);
  return alerts;
}

/**
 * Mark a contact alert as "ignored for this outreach" — won't alert again
 * until a new outreach is logged. Used by user "התעלם" command.
 */
function ignoreMediaAlert(contactId) {
  const state = loadState();
  const tracker = require('./media-tracker');
  const c = tracker.loadContacts().find(c => c.id === contactId);
  if (!c) return false;

  state.media_alerts[contactId] = {
    outreachAt: c.lastOutreach,
    lastAlertedAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(), // far future
  };
  saveState(state);
  return true;
}

// ─── Capability #1.2: Interview brief 30 min before ───────────────────
const INTERVIEW_KEYWORDS = [
  'ראיון', 'סינק', 'תוכנית', 'תכנית', 'ערוץ', 'גלי', 'קול ברמה',
  'ynet', 'כאן', 'רדיו', 'i24', 'גלגצ', 'גלצ', 'רשת', 'הסטודיו',
  'בוקר', 'מהדורה', 'פאנל', 'שידור', 'אולפן', 'פודקאסט',
  'interview', 'podcast', 'broadcast', 'studio',
];

function isInterviewEvent(event) {
  const fields = [event.summary, event.description, event.location].filter(Boolean).join(' ').toLowerCase();
  return INTERVIEW_KEYWORDS.some(k => fields.includes(k.toLowerCase()));
}

/**
 * Try to extract topic from event — looks for "נושא: X", "— X", or summary tail
 */
function extractTopicFromEvent(event) {
  const text = [event.summary, event.description].filter(Boolean).join('\n');
  // Try "נושא: X" / "Topic: X"
  const m1 = text.match(/(?:נושא|topic)\s*[:\-—]\s*(.+)/i);
  if (m1) return m1[1].trim().split('\n')[0].substring(0, 120);
  // Try "— X" or "- X" tail in summary
  const m2 = (event.summary || '').match(/[—\-]\s*(.+)$/);
  if (m2) return m2[1].trim().substring(0, 120);
  return null;
}

/**
 * Try to identify the outlet (channel/radio/podcast) from event fields
 */
function extractOutletFromEvent(event) {
  const text = [event.summary, event.location, event.description].filter(Boolean).join(' ');
  const outlets = [
    'ערוץ 14', 'ערוץ 13', 'ערוץ 12', 'i24', 'כאן 11', 'כאן ב', 'כאן רשת ב',
    'גלי צה"ל', 'גלגצ', 'גלצ', 'קול ברמה', 'רדיו ירושלים', 'רדיו 103',
    'ynet', 'מקור ראשון', 'הארץ', 'ישראל היום', 'מעריב', 'גלובס',
  ];
  for (const o of outlets) {
    if (text.toLowerCase().includes(o.toLowerCase())) return o;
  }
  return null;
}

/**
 * Format event start time as HH:MM (Asia/Jerusalem)
 */
function fmtEventTime(event) {
  const startIso = event.start?.dateTime || event.start?.date;
  if (!startIso) return '—';
  try {
    const d = new Date(startIso);
    return d.toLocaleTimeString('he-IL', {
      timeZone: 'Asia/Jerusalem',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (e) {
    return '—';
  }
}

/**
 * Build a multi-line Hebrew brief for an upcoming interview event.
 * Pulls Kellner positions for the topic and 1 web-search snippet for current news.
 */
async function buildInterviewBrief(event) {
  const topic = extractTopicFromEvent(event) || event.summary || 'ראיון';
  const outlet = extractOutletFromEvent(event) || (event.location ? event.location.split(',')[0] : null);
  const time = fmtEventTime(event);

  // Get Kellner positions matched to the topic
  let positionsText = '';
  try {
    const sp = require('./spokesperson');
    const matched = sp.matchTopicToPositions(topic);
    const top3 = (matched.positions || []).slice(0, 3);
    if (top3.length) {
      positionsText = top3.map(p => `• ${p.replace(/\n+/g, ' ').substring(0, 180)}`).join('\n');
    }
  } catch (e) {
    console.warn('⚠️ matchTopicToPositions failed:', e.message);
  }

  // Get current news on the topic (best-effort)
  let newsText = '';
  try {
    const web = require('./web');
    const query = `${topic} חדשות היום ישראל`;
    const result = await web.webSearch(query);
    if (result && !result.startsWith('❌')) {
      // Strip leading 🌐 and trim to 400 chars
      newsText = result.replace(/^🌐\s*/, '').substring(0, 400).trim();
    }
  } catch (e) {
    console.warn('⚠️ webSearch in brief failed:', e.message);
  }

  const lines = [
    `📺 *ראיון בעוד 30 דקות*`,
    ``,
  ];
  if (outlet) lines.push(`🎙 ${outlet}`);
  lines.push(`🕒 ${time}`);
  lines.push(`📌 נושא: ${topic}`);
  lines.push(``);

  if (positionsText) {
    lines.push(`🎯 *נקודות מפתח לדחיפה:*`);
    lines.push(positionsText);
    lines.push(``);
  }

  if (newsText) {
    lines.push(`📰 *רקע חדשותי:*`);
    lines.push(newsText);
    lines.push(``);
  }

  lines.push(`💡 *טיפ:* התחל בעמדה ברורה, חזור עליה פעמיים, סגור עם משפט מוטו.`);

  return lines.join('\n');
}

/**
 * Returns alerts for interviews starting in ~30 min (window: now+25 to now+35).
 * Side effect: marks each event as alerted in state.event_alerts so we don't
 * fire twice for the same event.
 */
async function checkUpcomingInterviews() {
  const calendar = require('./calendar');
  const now = new Date();
  const t25 = new Date(now.getTime() + 25 * 60 * 1000);
  const t35 = new Date(now.getTime() + 35 * 60 * 1000);

  let events;
  try {
    events = await calendar.fetchEventsRaw(t25, t35);
  } catch (e) {
    console.warn('⚠️ fetchEventsRaw in checkUpcomingInterviews failed:', e.message);
    return [];
  }

  if (!events || !events.length) return [];

  const state = loadState();
  const alerts = [];

  for (const ev of events) {
    if (!isInterviewEvent(ev)) continue;
    const eid = ev.id;
    if (!eid) continue;
    const slot = state.event_alerts[eid] || {};
    if (slot.brief) continue; // already alerted

    let text;
    try {
      text = await buildInterviewBrief(ev);
    } catch (e) {
      console.warn('⚠️ buildInterviewBrief failed:', e.message);
      continue;
    }

    alerts.push({ eventId: eid, text });
    state.event_alerts[eid] = {
      ...slot,
      brief: { alertedAt: new Date().toISOString() },
    };
  }

  if (alerts.length) saveState(state);
  return alerts;
}

// ─── Capability #1.3: 60-min Waze ETA proactive ─────────────────────
/**
 * Format an ISO time as HH:MM in Asia/Jerusalem timezone.
 */
function fmtTimeHHMM(date) {
  return date.toLocaleTimeString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Heuristic: does the event location look usable for routing?
 * Skip empty / virtual / phone-only locations.
 */
function isPhysicalLocation(loc) {
  if (!loc) return false;
  const l = String(loc).trim().toLowerCase();
  if (!l) return false;
  // Filter out obvious virtual/phone meetings
  const virtual = ['zoom', 'meet.google', 'teams', 'phone', 'טלפון', 'וירטואלי', 'online', 'webex', 'whatsapp'];
  if (virtual.some(v => l.includes(v))) return false;
  // Must have at least 2 chars (otherwise nothing to geocode)
  return l.length >= 2;
}

/**
 * Build a "leave in X min" alert for an upcoming event with a physical location.
 * Includes ETA via OSRM (best-effort), Waze link, and recommended departure time.
 */
async function buildTravelAlert(event, { bufferMinutes = 10 } = {}) {
  const navigation = require('./navigation');
  const dest = String(event.location || '').trim();
  const summary = event.summary || 'אירוע';
  const startIso = event.start?.dateTime || event.start?.date;
  const startDate = startIso ? new Date(startIso) : null;
  const eventTime = startDate ? fmtTimeHHMM(startDate) : '—';
  const wazeUrl = navigation.buildWazeLink(dest);

  // Try to get ETA — best effort, may fail if geocoding/routing breaks
  let etaSeconds = null, etaMeters = null, originName = null;
  try {
    const home = navigation.getHome();
    originName = home;
    const [o, d] = await Promise.all([
      navigation.geocode(home),
      navigation.geocode(dest),
    ]);
    const r = await navigation.route(o, d);
    etaSeconds = r.seconds;
    etaMeters = r.meters;
  } catch (e) {
    console.warn(`⚠️ ETA computation failed for "${dest}":`, e.message?.substring(0, 80));
  }

  const lines = [
    `🚦 *יוצאים בעוד שעה*`,
    ``,
    `📅 ${summary}`,
    `🕒 ${eventTime}`,
    `📍 ${dest}`,
    ``,
  ];

  if (etaSeconds && startDate) {
    lines.push(`⏱ זמן נסיעה: ~${navigation.fmtDuration(etaSeconds)}`);
    if (etaMeters) lines.push(`🛣 ${navigation.fmtDistance(etaMeters)}`);
    // Departure = event - travel - buffer
    const departAt = new Date(startDate.getTime() - etaSeconds * 1000 - bufferMinutes * 60 * 1000);
    lines.push(``);
    lines.push(`🚗 צא ב-${fmtTimeHHMM(departAt)} (כולל ${bufferMinutes} דק' באפר)`);
    if (originName) {
      lines.push(`📍 יציאה מ: ${originName}`);
    }
  } else {
    lines.push(`⚠️ לא הצלחתי לחשב זמן נסיעה — בדוק ב-Waze:`);
  }

  lines.push(``);
  lines.push(`📍 ${wazeUrl}`);
  lines.push(``);
  lines.push(`_הקש על הקישור לפתיחת Waze עם ETA חי כולל פקקים_`);

  return lines.join('\n');
}

/**
 * Returns alerts for events starting in ~60 min (window: now+55 to now+65)
 * that have a physical location. Side effect: marks each as alerted in
 * state.event_alerts[id].waze so we don't fire twice.
 */
async function checkUpcomingTravelETA({ bufferMinutes = 10 } = {}) {
  const calendar = require('./calendar');
  const now = new Date();
  const t55 = new Date(now.getTime() + 55 * 60 * 1000);
  const t65 = new Date(now.getTime() + 65 * 60 * 1000);

  let events;
  try {
    events = await calendar.fetchEventsRaw(t55, t65);
  } catch (e) {
    console.warn('⚠️ fetchEventsRaw in checkUpcomingTravelETA failed:', e.message);
    return [];
  }

  if (!events || !events.length) return [];

  const state = loadState();
  const alerts = [];

  for (const ev of events) {
    if (!isPhysicalLocation(ev.location)) continue;
    const eid = ev.id;
    if (!eid) continue;
    const slot = state.event_alerts[eid] || {};
    if (slot.waze) continue; // already alerted

    let text;
    try {
      text = await buildTravelAlert(ev, { bufferMinutes });
    } catch (e) {
      console.warn('⚠️ buildTravelAlert failed:', e.message);
      continue;
    }

    alerts.push({ eventId: eid, text });
    state.event_alerts[eid] = {
      ...slot,
      waze: { alertedAt: new Date().toISOString() },
    };
  }

  if (alerts.length) saveState(state);
  return alerts;
}

// ─── Capability #1.5: Voice call → calendar + media-tracker sync ───
/**
 * Analyze a call transcript and extract structured info for auto-sync.
 * Returns: {
 *   summary: string,
 *   isMediaCall: boolean,
 *   mediaContactId: string|null,         // matched id from media-tracker
 *   mediaContactName: string|null,
 *   outlet: string|null,
 *   interviewScheduled: { datetimeISO?: string, naturalTime?: string, topic?: string, location?: string } | null,
 *   tasks: string[],                     // human-actionable tasks
 *   _raw: object,                        // full Claude response for debugging
 * } | null on failure.
 */
async function analyzeCallTranscript(transcript) {
  if (!transcript || transcript.trim().length < 30) return null;
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch { return null; }
  if (!process.env.ANTHROPIC_API_KEY) return null;

  // Pull media contacts so Claude can match by name
  let contacts = [];
  try {
    const tr = require('./media-tracker');
    contacts = tr.loadContacts().map(c => ({
      id: c.id,
      name: c.name,
      outlet: c.outlet,
      role: c.role || null,
    }));
  } catch (e) { /* fall back: no contact matching */ }

  const contactList = contacts.length
    ? contacts.map(c => `- id="${c.id}" | ${c.name} | ${c.outlet}${c.role ? ' (' + c.role + ')' : ''}`).join('\n')
    : '(אין רשימה)';

  const today = new Date().toISOString().slice(0, 10);

  const prompt = `אתה מנתח תמלולים של שיחות טלפון של מושיקו אוחנה — דובר ח"כ אריאל קלנר.

אנשי הקשר התקשורת המוכרים (השתמש ב-id המדויק):
${contactList}

התאריך היום: ${today} (אסיה/ירושלים)

תמלול השיחה:
"""
${transcript.slice(0, 8000)}
"""

החזר רק JSON תקין (בלי הסבר חיצוני, בלי \`\`\`json), בפורמט:
{
  "summary": "סיכום קצר (1-2 משפטים) של השיחה",
  "isMediaCall": true|false,
  "mediaContactId": "id-מהרשימה" | null,
  "mediaContactName": "שם" | null,
  "outlet": "ערוץ/אאטלט" | null,
  "interviewScheduled": null | {
    "datetimeISO": "YYYY-MM-DDTHH:mm:00+03:00" | null,
    "naturalTime": "מחר ב-08:30 בבוקר" | null,
    "topic": "נושא הראיון" | null,
    "location": "מיקום" | null
  },
  "tasks": ["משימה 1", "משימה 2"]
}`;

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) return null;

    // Strip optional ```json ... ``` fences
    let raw = textBlock.text.trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn('⚠️ analyzeCallTranscript: JSON parse failed, raw start:', raw.slice(0, 120));
      return null;
    }

    return {
      summary: parsed.summary || '',
      isMediaCall: !!parsed.isMediaCall,
      mediaContactId: parsed.mediaContactId || null,
      mediaContactName: parsed.mediaContactName || null,
      outlet: parsed.outlet || null,
      interviewScheduled: parsed.interviewScheduled || null,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      _raw: parsed,
    };
  } catch (e) {
    console.warn('⚠️ analyzeCallTranscript Anthropic call failed:', e.message);
    return null;
  }
}

/**
 * Apply structured analysis to media-tracker (and optionally calendar).
 * Returns: {
 *   trackerUpdated: boolean,
 *   trackerMessage: string|null,
 *   summary: string,                  // human-readable summary of actions
 * }
 *
 * Does NOT add to calendar directly — the existing handleAudioMessage flow
 * already routes through Claude tool-use which handles calendar.add. We just
 * surface the proposed event in `summary` so Claude has a structured hint.
 */
async function applyCallAnalysis(analysis) {
  if (!analysis) return { trackerUpdated: false, trackerMessage: null, summary: '' };
  let trackerUpdated = false;
  let trackerMessage = null;

  // Auto-mark media contact as 'replied' (they responded → not pending anymore)
  if (analysis.isMediaCall && analysis.mediaContactId) {
    try {
      const tr = require('./media-tracker');
      tr.markReplied(analysis.mediaContactId);
      trackerUpdated = true;
      trackerMessage = `✅ ${analysis.mediaContactName || analysis.mediaContactId} → סומן כ"ענו" ב-media-tracker`;
    } catch (e) {
      trackerMessage = `⚠️ לא הצלחתי לעדכן media-tracker: ${e.message?.substring(0, 80)}`;
    }
  }

  const lines = [];
  if (analysis.summary) lines.push(`📞 ${analysis.summary}`);
  if (trackerMessage) lines.push(trackerMessage);
  if (analysis.interviewScheduled) {
    const i = analysis.interviewScheduled;
    const when = i.naturalTime || i.datetimeISO || '—';
    const topic = i.topic ? ` — ${i.topic}` : '';
    const loc = i.location ? ` 📍 ${i.location}` : '';
    lines.push(`📅 *ראיון מתוזמן:* ${when}${topic}${loc}`);
  }
  if (analysis.tasks && analysis.tasks.length) {
    lines.push(`✅ *משימות:*`);
    for (const t of analysis.tasks.slice(0, 5)) lines.push(`   • ${t}`);
  }

  return {
    trackerUpdated,
    trackerMessage,
    summary: lines.join('\n'),
  };
}

// ─── Capability #1.4: Trending keyword auto-pitch ───────────────────
/**
 * Draft a Kellner-style statement on a trending keyword using Anthropic API
 * with the spokesperson context (Kellner's positions/legislation/voice).
 * Returns a 2-3 sentence draft tweet/statement, or null on failure.
 */
async function draftKellnerStatement(keyword, samplePreviews = []) {
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (e) {
    console.warn('⚠️ Anthropic SDK unavailable for draftKellnerStatement');
    return null;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️ ANTHROPIC_API_KEY missing for draftKellnerStatement');
    return null;
  }

  let kellnerContext = '';
  try {
    const sp = require('./spokesperson');
    kellnerContext = sp.formatContextForClaude();
  } catch (e) { /* fall back without context */ }

  const samples = samplePreviews.slice(0, 5).map((s, i) => `${i + 1}. ${s}`).join('\n') || '(אין דגימות)';

  const prompt = `נושא חם בקבוצות וואטסאפ פוליטיות היום: "${keyword}"

דגימות מהשטח (מה אומרים):
${samples}

נסח הצהרה קצרה וחדה (2-3 משפטים, מתאים לטוויטר/X) של ח"כ אריאל קלנר על הנושא. השתמש בעמדותיו ובסגנונו האופייני (ישיר, חד, פטריוטי, ימין-קלאסי).

החזר רק את הטקסט להפצה — בלי מבוא, בלי הסבר. בעברית בלבד.`;

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: kellnerContext || 'אתה דובר של ח"כ אריאל קלנר (ליכוד) — תכתוב הצהרות בסגנונו: ישיר, חד, פטריוטי.',
      messages: [{ role: 'user', content: prompt }],
    });
    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock ? textBlock.text.trim() : null;
  } catch (e) {
    console.warn('⚠️ draftKellnerStatement Anthropic call failed:', e.message);
    return null;
  }
}

/**
 * Check for trending keywords (≥minGroups unique groups today) and return
 * pitch alerts with Kellner-style draft statements. Side effect: marks each
 * keyword as alerted in state.keyword_alerts so we don't fire twice for the
 * same keyword in the same calendar day.
 */
async function checkTrendingKeywords({ minGroups = 5, minHits = 3, minRatio = 1.5 } = {}) {
  let trends;
  try {
    const ka = require('./keyword-alerts');
    trends = ka.getTrends({ minHits, minRatio });
  } catch (e) {
    console.warn('⚠️ getTrends in checkTrendingKeywords failed:', e.message);
    return [];
  }

  if (!trends || !trends.length) return [];

  // Filter to keywords that appeared in ≥ minGroups distinct groups today
  const hot = trends.filter(t => (t.groups || []).length >= minGroups);
  if (!hot.length) return [];

  const state = loadState();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const alerts = [];

  // Pull recent message previews per keyword for the draft prompt
  let recentPreviewsByKw = {};
  try {
    const ka = require('./keyword-alerts');
    const log = ka.getActiveGroups ? null : null; // placeholder: we'll read raw log via fs below
    const fs2 = require('fs');
    const path2 = require('path');
    const LOG_PATH = path2.join(__dirname, '..', 'data', 'keyword-alerts-log.json');
    if (fs2.existsSync(LOG_PATH)) {
      const logRaw = JSON.parse(fs2.readFileSync(LOG_PATH, 'utf8'));
      const entries = (logRaw.entries || []).slice(-200); // last 200 entries plenty
      for (const e of entries) {
        if (!recentPreviewsByKw[e.keyword]) recentPreviewsByKw[e.keyword] = [];
        recentPreviewsByKw[e.keyword].push(e.preview);
      }
    }
  } catch (e) { /* non-critical */ }

  for (const t of hot) {
    const slot = state.keyword_alerts[t.keyword];
    // Only alert once per keyword per day
    if (slot && slot.alertedAt && slot.alertedAt.slice(0, 10) === today) continue;

    const samples = (recentPreviewsByKw[t.keyword] || []).slice(-5);
    let draft = null;
    try {
      draft = await draftKellnerStatement(t.keyword, samples);
    } catch (e) {
      console.warn('⚠️ draftKellnerStatement threw:', e.message);
    }

    const lines = [
      `🔥 *מגמה חמה — דחיפה מומלצת*`,
      ``,
      `🔑 "${t.keyword}" — מופיע ב-${t.groups.length} קבוצות היום`,
    ];
    if (t.direction === 'new') {
      lines.push(`📊 חדש (אתמול: 0, היום: ${t.today})`);
    } else {
      lines.push(`📊 ${t.today} אזכורים היום (אתמול: ${t.yesterday}, ×${t.ratio.toFixed(1)})`);
    }
    if (t.groups && t.groups.length) {
      const shown = t.groups.slice(0, 5).join(', ');
      const more = t.groups.length > 5 ? ` (+${t.groups.length - 5})` : '';
      lines.push(`📍 ${shown}${more}`);
    }
    lines.push(``);
    if (draft) {
      lines.push(`📝 *ניסוח מוצע בסגנון קלנר:*`);
      lines.push(draft);
      lines.push(``);
    }
    lines.push(`❓ *מה לעשות?*`);
    lines.push(`• אמור "תפרסם" — אשלח את הטיוטה לאישורך לפני פרסום`);
    lines.push(`• אמור "תשלח לתקשורת" — אעביר לאנשי קשר תקשורת רלוונטיים`);
    lines.push(`• אמור "התעלם מ${t.keyword}" — לא היום`);

    alerts.push({ keyword: t.keyword, draft, text: lines.join('\n') });

    state.keyword_alerts[t.keyword] = {
      alertedAt: new Date().toISOString(),
      draft: draft || null,
      groups: t.groups,
      todayCount: t.today,
    };
  }

  if (alerts.length) saveState(state);
  return alerts;
}

/**
 * Get the most recent draft for a keyword (used by user "תפרסם" CTA handler).
 */
function getKeywordDraft(keyword) {
  const state = loadState();
  return state.keyword_alerts[keyword] || null;
}

/**
 * Mark a keyword as ignored — won't re-alert until tomorrow.
 */
function ignoreKeywordAlert(keyword) {
  const state = loadState();
  state.keyword_alerts[keyword] = {
    ...(state.keyword_alerts[keyword] || {}),
    alertedAt: new Date().toISOString(),
    ignored: true,
  };
  saveState(state);
  return true;
}

module.exports = {
  // State (exposed for tests)
  loadState,
  saveState,

  // Capability #1.1
  checkPendingMedia,
  ignoreMediaAlert,

  // Capability #1.2
  isInterviewEvent,
  extractTopicFromEvent,
  extractOutletFromEvent,
  buildInterviewBrief,
  checkUpcomingInterviews,

  // Capability #1.3
  isPhysicalLocation,
  buildTravelAlert,
  checkUpcomingTravelETA,

  // Capability #1.4
  draftKellnerStatement,
  checkTrendingKeywords,
  getKeywordDraft,
  ignoreKeywordAlert,

  // Capability #1.5
  analyzeCallTranscript,
  applyCallAnalysis,
};
