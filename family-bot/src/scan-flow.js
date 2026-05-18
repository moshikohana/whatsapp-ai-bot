'use strict';
/**
 * Scan disambiguation flow — interactive multi-step poll wizard.
 *
 * Per-tenant: each user has their own active flow keyed by chatId (which
 * uniquely identifies them across all tenants, since chatId = their own
 * WhatsApp owner ID).
 *
 * Steps:
 *   1. source      — וואטסאפ / טלגרם / שניהם / pickPreset / ❌
 *   2. preset_pick — only if pickPreset selected
 *   3. type        — קבוצות / ערוצים / שניהם
 *   4. time        — שעה / מהבוקר / מהלילה / 24h / מאתמול / 3 ימים
 *   5. scope       — daily.json list / לבחור
 *   6. items       — multi-select poll of available items
 *   7. confirm     — text summary + Run / Edit / Cancel
 */

const TIMEOUT_MS = 10 * 60 * 1000;
const flows = new Map();  // chatId → flow state

// ── Option labels ────────────────────────────────────────────────
const SOURCE_OPTIONS_BASE = [
  { id: 'whatsapp', label: '💬 וואטסאפ בלבד' },
  { id: 'telegram', label: '📡 טלגרם בלבד' },
  { id: 'both',     label: '🌐 וואטסאפ + טלגרם' },
];
const SOURCE_OPTIONS = [...SOURCE_OPTIONS_BASE,
  { id: 'preset',   label: '📁 השתמש בפריסט שמור' },
  { id: 'cancel',   label: '❌ ביטול' },
];

function buildSourceOptions(hasPresets) {
  const opts = [...SOURCE_OPTIONS_BASE];
  if (hasPresets) opts.unshift({ id: 'preset', label: '📁 השתמש בפריסט שמור' });
  opts.push({ id: 'cancel', label: '❌ ביטול' });
  return opts;
}

const TYPE_OPTIONS = [
  { id: 'groups',   label: '👥 קבוצות בלבד' },
  { id: 'channels', label: '📢 ערוצים בלבד' },
  { id: 'both',     label: '🌐 קבוצות וערוצים' },
  { id: 'cancel',   label: '❌ ביטול' },
];

const TIME_OPTIONS = [
  { id: 'hour',     label: '⚡ שעה אחרונה',     minutes: 60 },
  { id: 'morning',  label: '🌅 מהבוקר (06:00)', minutes: null },
  { id: 'night',    label: '🌙 מהלילה (00:00)', minutes: null },
  { id: '24h',      label: '📅 24 שעות אחרונות', minutes: 1440 },
  { id: 'yesterday',label: '⏪ מאתמול (24:00)',  minutes: null },
  { id: '3days',    label: '🕒 3 ימים אחרונים', minutes: 4320 },
  { id: 'cancel',   label: '❌ ביטול' },
];

const SCOPE_OPTIONS = [
  { id: 'all',    label: '🌐 רשימת המעקב היומי שלי' },
  { id: 'select', label: '🎯 בחר מקורות ספציפיים' },
  { id: 'cancel', label: '❌ ביטול' },
];

const CONFIRM_OPTIONS = [
  { id: 'run',    label: '✅ הרץ עכשיו' },
  { id: 'edit',   label: '✏️ התחל מחדש' },
  { id: 'cancel', label: '❌ ביטול' },
];

// ── State helpers ───────────────────────────────────────────────
function getFlow(chatId) {
  const f = flows.get(chatId);
  if (!f) return null;
  if (Date.now() - f.lastActivity > TIMEOUT_MS) {
    flows.delete(chatId);
    return null;
  }
  return f;
}
function startFlow(chatId) {
  const f = {
    chatId, type: 'scan', step: 'source',
    selections: { source: null, type: null, time: null, scope: null, selectedItems: [] },
    availableItems: [], itemsPage: 0,
    activePollId: null, lastPollOptions: null,
    confirmedSources: null, usedPresetName: null,
    createdAt: Date.now(), lastActivity: Date.now(),
  };
  flows.set(chatId, f);
  return f;
}
function endFlow(chatId) { flows.delete(chatId); }
function updateFlow(chatId, patch) {
  const f = flows.get(chatId);
  if (!f) return null;
  Object.assign(f, patch);
  f.lastActivity = Date.now();
  return f;
}

// ── Poll builder — caller passes presetsList for source step ───
function buildPoll(flow, ctx = {}) {
  const presetsList = ctx.presetsList || [];
  switch (flow.step) {
    case 'source':
      return { question: '🔍 *סריקה — שלב 1/5*\nמאיפה לסרוק?', options: buildSourceOptions(presetsList.length > 0) };
    case 'preset_pick': {
      const opts = presetsList.slice(0, 10).map((p) => ({
        id: `preset:${p.id}`,
        label: `${p.name} (${p.isDynamic ? (p.sourceCount || '?') : p.sources.length} מקורות)`,
      }));
      opts.push({ id: '__back__', label: '◀️ חזרה — בחר ידנית' });
      opts.push({ id: 'cancel',   label: '❌ ביטול' });
      return { question: `📁 *בחר פריסט שמור* (${presetsList.length} זמינים)`, options: opts };
    }
    case 'type':
      return { question: '🔍 *סריקה — שלב 2/5*\nאיזה סוג?', options: TYPE_OPTIONS };
    case 'time':
      return { question: '🔍 *סריקה — שלב 3/5*\nאיזה טווח זמן?', options: TIME_OPTIONS };
    case 'scope':
      return { question: '🔍 *סריקה — שלב 4/5*\nמה ההיקף?', options: SCOPE_OPTIONS };
    case 'items': {
      const PAGE_SIZE = 9;
      const start = flow.itemsPage * PAGE_SIZE;
      const slice = flow.availableItems.slice(start, start + PAGE_SIZE);
      const hasMore = (start + PAGE_SIZE) < flow.availableItems.length;
      const opts = slice.map((item, i) => ({
        id: `item:${start + i}`,
        label: `${flow.selections.selectedItems.includes(item.id) ? '✔️ ' : ''}${item.label}`,
      }));
      if (hasMore) opts.push({ id: '__next_page__', label: '⏭️ עמוד הבא' });
      opts.push({ id: '__finish__', label: '✅ סיים בחירה' });
      opts.push({ id: 'cancel', label: '❌ ביטול' });
      const selectedCount = flow.selections.selectedItems.length;
      const totalPages = Math.ceil(flow.availableItems.length / PAGE_SIZE);
      const trackedCount = (flow.availableItems || []).filter(x => x._tracked).length;
      const trackedHint = trackedCount > 0 ? `\n⭐ = מהמעקב היומי — מוצגים ראשונים.` : '';
      return {
        question: `🔍 *סריקה — בחירת מקורות (${selectedCount} נבחרו)*\nעמוד ${flow.itemsPage + 1}/${totalPages}${trackedHint}\nלחץ פריט להוסיף/להסיר. בסוף — "סיים בחירה".`,
        options: opts,
        multiple: true,
      };
    }
    case 'confirm': {
      const s = flow.selections;
      const sourceLabel = SOURCE_OPTIONS.find(o => o.id === s.source)?.label || s.source;
      const typeLabel = TYPE_OPTIONS.find(o => o.id === s.type)?.label || s.type;
      const timeLabel = TIME_OPTIONS.find(o => o.id === s.time)?.label || s.time;
      const scopeLabel = s.scope === 'all'
        ? '🌐 רשימת המעקב היומי'
        : `🎯 ${s.selectedItems.length} מקורות נבחרים`;
      const itemsList = s.scope === 'select' && s.selectedItems.length
        ? '\n\n*המקורות שנבחרו:*\n' + s.selectedItems.map((id, i) => {
            const item = flow.availableItems.find(x => x.id === id);
            return `${i + 1}. ${item?.label || id}`;
          }).join('\n')
        : '';
      return {
        question: `🔍 *אישור לפני הרצה:*\n\n${sourceLabel}\n${typeLabel}\n${timeLabel}\n${scopeLabel}${itemsList}\n\nלהריץ?`,
        options: CONFIRM_OPTIONS,
      };
    }
    default: return null;
  }
}

// ── Time helper ────────────────────────────────────────────────
function timeOptionToMinutes(timeId) {
  const now = new Date();
  switch (timeId) {
    case 'hour':       return 60;
    case '24h':        return 1440;
    case '3days':      return 4320;
    case 'morning': {
      const t = new Date(now); t.setHours(6, 0, 0, 0);
      if (t > now) t.setDate(t.getDate() - 1);
      return Math.round((now - t) / 60000);
    }
    case 'night': {
      const t = new Date(now); t.setHours(0, 0, 0, 0);
      return Math.round((now - t) / 60000);
    }
    case 'yesterday': {
      const t = new Date(now); t.setDate(t.getDate() - 1); t.setHours(0, 0, 0, 0);
      return Math.round((now - t) / 60000);
    }
    default: return 1440;
  }
}

// ── Apply vote (caller passes presetsList for resolving preset:id) ──
function applyVote(flow, selected, ctx = {}) {
  const presetsList = ctx.presetsList || [];
  flow.lastActivity = Date.now();
  if (selected === 'cancel' || selected === '❌ ביטול') return { cancel: true };

  const matchOption = (opts, id) =>
    opts.find(o => o.id === id || o.label === id);

  switch (flow.step) {
    case 'source': {
      const o = matchOption(buildSourceOptions(presetsList.length > 0), selected);
      if (!o || o.id === 'cancel') return { error: 'בחירה לא תקפה' };
      if (o.id === 'preset') {
        if (presetsList.length === 0) return { error: 'אין פריסטים שמורים' };
        flow.step = 'preset_pick';
        return { ok: true };
      }
      flow.selections.source = o.id;
      flow.step = 'type';
      return { ok: true };
    }
    case 'preset_pick': {
      if (selected === '__back__') { flow.step = 'source'; return { ok: true }; }
      const m = String(selected).match(/^preset:(.+)$/);
      if (!m) return { error: 'בחירה לא תקפה' };
      const preset = presetsList.find(p => p.id === m[1]);
      if (!preset) return { error: 'הפריסט לא נמצא' };

      if (preset.isDynamic) {
        flow.selections.source = 'whatsapp';  // daily.json is WA by convention
        flow.selections.type = 'both';
        flow.selections.scope = 'all';
        flow.usedPresetName = preset.name;
        flow.step = 'time';
        return { ok: true, presetName: preset.name };
      }
      const hasWa = preset.sources.some(s => s.source === 'wa');
      const hasTg = preset.sources.some(s => s.source === 'tg');
      const hasGroups = preset.sources.some(s => s.type === 'group');
      const hasChannels = preset.sources.some(s => s.type === 'channel');
      flow.selections.source = (hasWa && hasTg) ? 'both' : (hasWa ? 'whatsapp' : 'telegram');
      flow.selections.type = (hasGroups && hasChannels) ? 'both' : (hasGroups ? 'groups' : 'channels');
      flow.selections.scope = 'select';
      flow.selections.selectedItems = preset.sources.map(s => s.id);
      flow.availableItems = preset.sources;
      flow.confirmedSources = preset.sources;
      flow.usedPresetName = preset.name;
      flow.step = 'time';
      return { ok: true, presetName: preset.name };
    }
    case 'type': {
      const o = matchOption(TYPE_OPTIONS, selected);
      if (!o || o.id === 'cancel') return { error: 'בחירה לא תקפה' };
      flow.selections.type = o.id;
      flow.step = 'time';
      return { ok: true };
    }
    case 'time': {
      const o = matchOption(TIME_OPTIONS, selected);
      if (!o || o.id === 'cancel') return { error: 'בחירה לא תקפה' };
      flow.selections.time = o.id;
      if (flow.usedPresetName) flow.step = 'confirm';
      else flow.step = 'scope';
      return { ok: true };
    }
    case 'scope': {
      const o = matchOption(SCOPE_OPTIONS, selected);
      if (!o || o.id === 'cancel') return { error: 'בחירה לא תקפה' };
      flow.selections.scope = o.id;
      if (o.id === 'all') flow.step = 'confirm';
      else { flow.step = 'items'; return { ok: true, needsItems: true }; }
      return { ok: true };
    }
    case 'items': {
      const PAGE_SIZE = 9;
      if (selected === '__next_page__') {
        if ((flow.itemsPage + 1) * PAGE_SIZE < flow.availableItems.length) flow.itemsPage += 1;
        return { ok: true };
      }
      if (selected === '__finish__') {
        if (flow.selections.selectedItems.length === 0) return { error: 'לא בחרת אף מקור. בחר לפחות אחד או לחץ ❌ ביטול.' };
        flow.step = 'confirm';
        return { ok: true };
      }
      const m = String(selected).match(/^item:(\d+)$/);
      if (m) {
        const idx = parseInt(m[1], 10);
        const item = flow.availableItems[idx];
        if (!item) return { error: 'פריט לא תקין' };
        const cur = flow.selections.selectedItems;
        if (cur.includes(item.id)) flow.selections.selectedItems = cur.filter(x => x !== item.id);
        else cur.push(item.id);
        return { ok: true };
      }
      return { error: 'בחירה לא תקפה' };
    }
    case 'confirm': {
      const o = matchOption(CONFIRM_OPTIONS, selected);
      if (!o || o.id === 'cancel') return { cancel: true };
      if (o.id === 'edit') return { restart: true };
      if (o.id === 'run') {
        const params = {
          source: flow.selections.source,
          type: flow.selections.type,
          sinceMinutes: timeOptionToMinutes(flow.selections.time),
          timeLabel: TIME_OPTIONS.find(t => t.id === flow.selections.time)?.label || '',
          scope: flow.selections.scope,
          selectedItems: flow.selections.scope === 'select'
            ? flow.selections.selectedItems.map(id => flow.availableItems.find(x => x.id === id)).filter(Boolean)
            : [],
        };
        return { execute: true, params };
      }
      return { error: 'בחירה לא תקפה' };
    }
    default: return { error: 'מצב לא תקף' };
  }
}

// ── Trigger detection (text → should we open menu?) ─────────────
function shouldShowMenu(text) {
  if (!text) return false;
  const t = text.trim();
  if (/^(תפריט\s+(?:סריקה|סקירה)|סריקה\s+(?:אינטראקטיבית|מותאמת)|סקירה\s+(?:אינטראקטיבית|מותאמת))/i.test(t)) return true;
  if (/^(?:תעשה\s+(?:לי\s+)?)?(?:סקירה|סריקה)\s*[\?\.!]?$/i.test(t)) return true;
  if (/^(?:תסרוק|תסרוק לי)\s*[\?\.!]?$/i.test(t)) return true;
  const hasScan = /\b(?:סריקה|סקירה|תסרוק)\b/i.test(t);
  if (!hasScan) return false;
  const mentionsPlatform = /\b(טלגרם|telegram|וואטסאפ|whatsapp|וואטסטפ)\b/i.test(t);
  const mentionsType = /\b(קבוצות|ערוצים|הקבוצות|הערוצים)\b/i.test(t);
  if (!mentionsPlatform && !mentionsType) return true;
  return false;
}

module.exports = {
  flows, startFlow, endFlow, getFlow, updateFlow,
  buildPoll, applyVote, shouldShowMenu, timeOptionToMinutes,
};
