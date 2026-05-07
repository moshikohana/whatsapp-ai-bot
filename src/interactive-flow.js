'use strict';
/**
 * Interactive multi-step flows using WhatsApp polls.
 *
 * WhatsApp limits us to: polls, plain text. Buttons/List messages are
 * blocked for non-Business-API accounts. Polls work as quick-tap menus —
 * the user picks from up to 12 options without typing.
 *
 * State machine per chatId. Flow types:
 *   - "calendar_event": create a calendar event with 4 polls + 1 free-text
 *
 * Each flow tracks:
 *   - type
 *   - currentStep (which poll/text input is active)
 *   - collected data so far
 *   - the poll message id we sent (so vote_update can match it)
 *   - createdAt (auto-expire after 10 min of inactivity)
 */

const FLOW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const flows = new Map(); // chatId → flow object

function getFlow(chatId) {
  const f = flows.get(chatId);
  if (!f) return null;
  if (Date.now() - f.lastActivity > FLOW_TIMEOUT_MS) {
    flows.delete(chatId);
    return null;
  }
  return f;
}

function startFlow(chatId, type, initialData = {}) {
  const f = {
    chatId,
    type,
    step: 0,
    data: { ...initialData },
    pollMessageIds: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  flows.set(chatId, f);
  return f;
}

function updateFlow(chatId, updates) {
  const f = flows.get(chatId);
  if (!f) return null;
  Object.assign(f, updates);
  f.lastActivity = Date.now();
  return f;
}

function endFlow(chatId) {
  flows.delete(chatId);
}

// ── Calendar event flow definition ───────────────────────────────
// 4 polls + 1 free-text. Each step has options + how to interpret a
// vote OR a typed alternative.

function getDateOptions() {
  const tz = 'Asia/Jerusalem';
  const today = new Date();
  const opts = [];
  // 0..6 days ahead
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const dayHe = d.toLocaleDateString('he-IL', { timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit' });
    let label;
    if (i === 0) label = `🟢 היום (${dayHe.split(',')[1]?.trim() || ''})`;
    else if (i === 1) label = `🟡 מחר (${dayHe.split(',')[1]?.trim() || ''})`;
    else label = `${dayHe}`;
    opts.push({ label, iso: d.toISOString().slice(0, 10) });
  }
  opts.push({ label: '✏️ תאריך אחר (תקליד)', iso: 'OTHER' });
  return opts;
}

const TIME_OPTIONS = [
  { label: '08:00', value: '08:00' },
  { label: '09:00', value: '09:00' },
  { label: '10:00', value: '10:00' },
  { label: '11:00', value: '11:00' },
  { label: '12:00', value: '12:00' },
  { label: '13:00', value: '13:00' },
  { label: '14:00', value: '14:00' },
  { label: '15:00', value: '15:00' },
  { label: '16:00', value: '16:00' },
  { label: '17:00', value: '17:00' },
  { label: '✏️ שעה אחרת', value: 'OTHER' },
];

const DURATION_OPTIONS = [
  { label: '30 דקות', minutes: 30 },
  { label: '45 דקות', minutes: 45 },
  { label: '1 שעה', minutes: 60 },
  { label: '1.5 שעות', minutes: 90 },
  { label: '2 שעות', minutes: 120 },
  { label: '3 שעות', minutes: 180 },
];

const LOCATION_OPTIONS = [
  { label: '🏛️ הכנסת', value: 'הכנסת' },
  { label: '🏢 משרד הלשכה', value: 'משרד הלשכה' },
  { label: '💻 זום', value: 'זום' },
  { label: '☎️ שיחת טלפון', value: 'שיחת טלפון' },
  { label: '✏️ מיקום אחר', value: 'OTHER' },
  { label: '⏭️ דלג על מיקום', value: 'SKIP' },
];

const RECURRENCE_OPTIONS = [
  { label: '🔂 חד-פעמי', value: 'NONE' },
  { label: '📆 כל יום (חוץ משישי-שבת)', value: 'WEEKDAYS' },
  { label: '📆 כל יום ללא יוצא מן הכלל', value: 'DAILY' },
  { label: '📆 שבועי (אותו יום בשבוע)', value: 'WEEKLY' },
  { label: '📆 חודשי (אותו תאריך)', value: 'MONTHLY' },
];

const REMINDER_OPTIONS = [
  { label: '⏰ 10 דק׳ לפני', value: '10' },
  { label: '⏰ 30 דק׳ לפני', value: '30' },
  { label: '⏰ שעה לפני', value: '60' },
  { label: '⏰ יום לפני (בבוקר)', value: '1440' },
  { label: '🔕 בלי תזכורת', value: 'NONE' },
];

const CONFIRM_OPTIONS = [
  { label: '✅ אשר והוסף ליומן', value: 'CONFIRM' },
  { label: '✏️ שנה תאריך', value: 'EDIT_date' },
  { label: '✏️ שנה שעה', value: 'EDIT_time' },
  { label: '✏️ שנה משך', value: 'EDIT_duration' },
  { label: '✏️ שנה מיקום', value: 'EDIT_location' },
  { label: '✏️ שנה נושא', value: 'EDIT_title' },
  { label: '❌ בטל', value: 'CANCEL' },
];

// Steps: 0=date, 1=time, 2=duration, 3=location, 4=title (text), 5=recurrence, 6=reminder, 7=conflict_check, 8=confirm
const CALENDAR_STEPS = ['date', 'time', 'duration', 'location', 'title', 'recurrence', 'reminder', 'conflict_check', 'confirm'];

function getStepName(flow) {
  return CALENDAR_STEPS[flow.step];
}

function isWaitingForText(flow) {
  return getStepName(flow) === 'title';
}

function getOptionsForStep(flow) {
  const step = getStepName(flow);
  switch (step) {
    case 'date': return getDateOptions();
    case 'time': return TIME_OPTIONS.map(o => ({ label: o.label, value: o.value }));
    case 'duration': return DURATION_OPTIONS.map(o => ({ label: o.label, value: String(o.minutes) }));
    case 'location': return LOCATION_OPTIONS;
    case 'recurrence': return RECURRENCE_OPTIONS;
    case 'reminder': return REMINDER_OPTIONS;
    case 'conflict_check': return [
      { label: '✅ המשך בכל זאת', value: 'IGNORE_CONFLICT' },
      { label: '⏰ שנה שעה', value: 'EDIT_time' },
      { label: '📅 שנה תאריך', value: 'EDIT_date' },
      { label: '❌ בטל', value: 'CANCEL' },
    ];
    case 'confirm': return CONFIRM_OPTIONS;
    default: return [];
  }
}

function getStepPrompt(flow) {
  const step = getStepName(flow);
  const d = flow.data;
  const total = '7';   // user-facing steps (excluding conflict_check which only appears if conflicts exist)
  switch (step) {
    case 'date': return `📅 *פגישה חדשה — שלב 1/${total}*\nמתי הפגישה?`;
    case 'time': return `📅 *שלב 2/${total}* · *${d.dateLabel}*\nבאיזו שעה?`;
    case 'duration': return `📅 *שלב 3/${total}* · ${d.dateLabel} ${d.time}\nכמה זמן?`;
    case 'location': return `📅 *שלב 4/${total}* · ${d.dateLabel} ${d.time} · ${d.duration}\nאיפה?`;
    case 'title': return `📅 *שלב 5/${total}* · ${d.dateLabel} ${d.time}${d.location ? ` · ${d.location}` : ''}\n\n*כתוב את שם/נושא הפגישה:*\n_(טקסט חופשי, למשל "פגישה עם רפי ביטון על חוק הגיוס")_`;
    case 'recurrence': return `📅 *שלב 6/${total}* · ${d.title}\nהאם הפגישה חוזרת?`;
    case 'reminder': return `📅 *שלב 7/${total}* · תזכורת לפני האירוע?`;
    case 'conflict_check': {
      const conflicts = (d.conflicts || []).map(c => `  • ${c.summary} (${c.timeStr})`).join('\n');
      return `⚠️ *זוהו פגישות חופפות:*\n${conflicts}\n\nאיך להתקדם?`;
    }
    case 'confirm': {
      const recLabel = d.recurrenceLabel && d.recurrence !== 'NONE' ? `\n🔁 ${d.recurrenceLabel}` : '';
      const remLabel = d.reminderLabel && d.reminderMinutes !== 'NONE' ? `\n⏰ תזכורת: ${d.reminderLabel}` : '';
      return `📋 *סיכום לאישור:*\n\n` +
        `📌 *${d.title}*\n` +
        `📅 ${d.dateLabel}\n` +
        `🕐 ${d.time} (${d.duration})\n` +
        (d.location ? `📍 ${d.location}` : '') +
        recLabel + remLabel +
        `\n\n*להוסיף ליומן?*`;
    }
    default: return '';
  }
}

/**
 * Process a vote on the active poll. Returns the next step + updates.
 */
function applyVote(flow, selectedLabel) {
  const step = getStepName(flow);
  const d = flow.data;
  switch (step) {
    case 'date': {
      const opts = getDateOptions();
      const opt = opts.find(o => o.label === selectedLabel);
      if (!opt) return { error: `לא זיהיתי "${selectedLabel}"` };
      if (opt.iso === 'OTHER') {
        return { needsText: 'תקליד תאריך בפורמט DD/MM (למשל 15/06):' };
      }
      d.dateISO = opt.iso;
      d.dateLabel = opt.label;
      flow.step += 1;
      return { ok: true };
    }
    case 'time': {
      const opt = TIME_OPTIONS.find(o => o.label === selectedLabel);
      if (!opt) return { error: `לא זיהיתי "${selectedLabel}"` };
      if (opt.value === 'OTHER') {
        return { needsText: 'תקליד שעה בפורמט HH:MM (למשל 14:30):' };
      }
      d.time = opt.value;
      flow.step += 1;
      return { ok: true };
    }
    case 'duration': {
      const opt = DURATION_OPTIONS.find(o => o.label === selectedLabel);
      if (!opt) return { error: `לא זיהיתי "${selectedLabel}"` };
      d.durationMinutes = opt.minutes;
      d.duration = opt.label;
      flow.step += 1;
      return { ok: true };
    }
    case 'location': {
      const opt = LOCATION_OPTIONS.find(o => o.label === selectedLabel);
      if (!opt) return { error: `לא זיהיתי "${selectedLabel}"` };
      if (opt.value === 'OTHER') {
        return { needsText: 'תקליד מיקום:' };
      }
      d.location = opt.value === 'SKIP' ? null : opt.value;
      flow.step += 1;
      return { ok: true };
    }
    case 'recurrence': {
      const opt = RECURRENCE_OPTIONS.find(o => o.label === selectedLabel);
      if (!opt) return { error: `לא זיהיתי "${selectedLabel}"` };
      d.recurrence = opt.value;
      d.recurrenceLabel = opt.label;
      flow.step += 1;
      return { ok: true };
    }
    case 'reminder': {
      const opt = REMINDER_OPTIONS.find(o => o.label === selectedLabel);
      if (!opt) return { error: `לא זיהיתי "${selectedLabel}"` };
      d.reminderMinutes = opt.value;
      d.reminderLabel = opt.label;
      flow.step += 1;
      return { ok: true, runConflictCheck: true };
    }
    case 'conflict_check': {
      const trim = selectedLabel;
      if (trim.includes('המשך בכל זאת')) { flow.step += 1; return { ok: true }; }
      if (trim.includes('שנה שעה')) {
        flow.step = CALENDAR_STEPS.indexOf('time');
        d.time = null;
        d.conflicts = undefined; // force re-detect after new time
        flow.editMode = true;
        return { ok: true, jumpedTo: 'time' };
      }
      if (trim.includes('שנה תאריך')) {
        flow.step = CALENDAR_STEPS.indexOf('date');
        d.dateISO = null;
        d.dateLabel = null;
        d.conflicts = undefined;
        flow.editMode = true;
        return { ok: true, jumpedTo: 'date' };
      }
      if (trim.includes('בטל')) return { cancel: true };
      return { error: 'בחירה לא ידועה' };
    }
    case 'confirm': {
      const opt = CONFIRM_OPTIONS.find(o => o.label === selectedLabel);
      if (!opt) return { error: `לא זיהיתי "${selectedLabel}"` };
      if (opt.value === 'CANCEL') return { cancel: true };
      if (opt.value === 'CONFIRM') return { commit: true };
      // EDIT_<field> — jump back to that step, clear that field, set editMode flag
      const editMap = { 'EDIT_date': 'date', 'EDIT_time': 'time', 'EDIT_duration': 'duration', 'EDIT_location': 'location', 'EDIT_title': 'title' };
      const targetStep = editMap[opt.value];
      if (!targetStep) return { error: 'בחירה לא ידועה' };
      flow.step = CALENDAR_STEPS.indexOf(targetStep);
      flow.editMode = true;  // when user finishes this step, jump back to conflict_check (or confirm)
      // Clear the field so the user can re-enter. Editing date/time also
      // invalidates the conflict cache so we re-detect with the new value.
      const clearMap = {
        'date': () => { d.dateISO = null; d.dateLabel = null; d.conflicts = undefined; },
        'time': () => { d.time = null; d.conflicts = undefined; },
        'duration': () => { d.durationMinutes = null; d.duration = null; d.conflicts = undefined; },
        'location': () => { d.location = null; },
        'title': () => { d.title = null; },
      };
      clearMap[targetStep]?.();
      return { ok: true, jumpedTo: targetStep };
    }
    default:
      return { error: 'מצב לא ידוע' };
  }
}

/**
 * Process free-text input — used either when step expects text (title)
 * OR when user types instead of voting (e.g. custom date "15/06").
 */
function applyText(flow, text) {
  const step = getStepName(flow);
  const d = flow.data;
  const t = (text || '').trim();
  switch (step) {
    case 'date': {
      // Custom date format: DD/MM or DD/MM/YYYY
      const m = t.match(/^(\d{1,2})[./\-](\d{1,2})(?:[./\-](\d{2,4}))?$/);
      if (!m) return { error: 'פורמט תאריך לא תקין. דוגמה: 15/06' };
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      const year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)) : new Date().getFullYear();
      const dt = new Date(year, month, day);
      if (Number.isNaN(dt.getTime())) return { error: 'תאריך לא חוקי.' };
      d.dateISO = dt.toISOString().slice(0, 10);
      d.dateLabel = dt.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
      flow.step += 1;
      return { ok: true };
    }
    case 'time': {
      const m = t.match(/^(\d{1,2}):?(\d{2})$/);
      if (!m) return { error: 'פורמט שעה לא תקין. דוגמה: 14:30' };
      const hh = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      if (hh > 23 || mm > 59) return { error: 'שעה לא חוקית.' };
      d.time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      flow.step += 1;
      return { ok: true };
    }
    case 'location': {
      d.location = t;
      flow.step += 1;
      return { ok: true };
    }
    case 'title': {
      if (t.length < 2) return { error: 'הנושא קצר מדי.' };
      d.title = t.substring(0, 200);
      flow.step += 1;
      return { ok: true };
    }
    default:
      return { error: 'לא נדרש קלט טקסט בשלב זה.' };
  }
}

module.exports = {
  flows,
  getFlow,
  startFlow,
  updateFlow,
  endFlow,
  getStepName,
  isWaitingForText,
  getOptionsForStep,
  getStepPrompt,
  applyVote,
  applyText,
  CALENDAR_STEPS,
};
