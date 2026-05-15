'use strict';
/**
 * Scan disambiguation flow — interactive multi-step poll wizard.
 *
 * Triggered when the user requests a "סריקה / סקירה" without enough detail
 * (platform / type / time / scope). Walks them through 5 polls + a final
 * confirmation, then executes the actual scan.
 *
 * Steps:
 *   1. source      — וואטסאפ / טלגרם / שניהם / ❌
 *   2. type        — קבוצות / ערוצים / שניהם / ❌
 *   3. time        — שעה / מהבוקר / מהלילה / 24h / מאתמול / 3 ימים / ❌
 *   4. scope       — כל המקורות / לבחור / ❌
 *   5. items       — only if scope=select. multi-select poll of available items
 *                    (paginated 10 per page with "המשך" / "סיים בחירה")
 *   6. confirm     — text summary + poll: ✅ הרץ / ✏️ ערוך / ❌ ביטול
 *
 * On confirm → flow ends with { execute: true, params: {...} }.
 * Caller (index.js) reads params and runs the actual scan.
 */

const TIMEOUT_MS = 10 * 60 * 1000;  // 10 min idle → auto-cancel

const flows = new Map();  // chatId → flow state

const STEPS = ['source', 'preset_pick', 'type', 'time', 'scope', 'items', 'confirm'];

const presets = require('./scan-presets');

// ── Option labels (Hebrew) ──────────────────────────────────────
function buildSourceOptions() {
  const opts = [
    { id: 'whatsapp', label: '💬 וואטסאפ בלבד' },
    { id: 'telegram', label: '📡 טלגרם בלבד' },
    { id: 'both',     label: '🌐 וואטסאפ + טלגרם' },
  ];
  // If presets exist — surface a shortcut at the top so the user can skip
  // platform/type/scope/items selection entirely.
  if (presets.list().length > 0) {
    opts.unshift({ id: 'preset', label: '📁 השתמש בפריסט שמור' });
  }
  opts.push({ id: 'cancel', label: '❌ ביטול' });
  return opts;
}
// Backward-compat — old code can still import the static list of base options
const SOURCE_OPTIONS = [
  { id: 'whatsapp', label: '💬 וואטסאפ בלבד' },
  { id: 'telegram', label: '📡 טלגרם בלבד' },
  { id: 'both',     label: '🌐 וואטסאפ + טלגרם' },
  { id: 'preset',   label: '📁 השתמש בפריסט שמור' },
  { id: 'cancel',   label: '❌ ביטול' },
];

const TYPE_OPTIONS = [
  { id: 'groups',   label: '👥 קבוצות בלבד' },
  { id: 'channels', label: '📢 ערוצים בלבד' },
  { id: 'both',     label: '🌐 קבוצות וערוצים' },
  { id: 'cancel',   label: '❌ ביטול' },
];

const TIME_OPTIONS = [
  { id: 'hour',    label: '⚡ שעה אחרונה',        minutes: 60 },
  { id: 'morning', label: '🌅 מהבוקר (06:00)',    minutes: null }, // computed
  { id: 'night',   label: '🌙 מהלילה (00:00)',    minutes: null }, // computed
  { id: '24h',     label: '📅 24 שעות אחרונות',  minutes: 1440 },
  { id: 'yesterday', label: '⏪ מאתמול (24:00)', minutes: null }, // computed
  { id: '3days',   label: '🕒 3 ימים אחרונים',  minutes: 4320 },
  { id: 'cancel',  label: '❌ ביטול' },
];

const SCOPE_OPTIONS = [
  { id: 'all',    label: '🌐 רשימת המעקב היומי (daily.json)' },
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
    chatId,
    type: 'scan',
    step: 'source',
    selections: {
      source: null, type: null, time: null, scope: null,
      selectedItems: [],
    },
    availableItems: [],     // populated when entering 'items' step
    itemsPage: 0,           // pagination cursor
    activePollId: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
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

// ── Build the poll for the current step ────────────────────────
function buildPoll(flow) {
  switch (flow.step) {
    case 'source':
      return { question: '🔍 *סריקה — שלב 1/5*\nמאיפה לסרוק?', options: buildSourceOptions() };
    case 'preset_pick': {
      const all = presets.list();
      const opts = all.slice(0, 10).map((p, i) => {
        const count = p.isDynamic ? (p.sourceCount || '?') : p.sources.length;
        return {
          id: `preset:${p.id}`,
          label: `${p.name} (${count} מקורות)`,
        };
      });
      opts.push({ id: '__back__', label: '◀️ חזרה — בחר ידנית' });
      opts.push({ id: 'cancel',   label: '❌ ביטול' });
      return { question: `📁 *בחר פריסט שמור* (${all.length} זמינים)`, options: opts };
    }
    case 'type':
      return { question: '🔍 *סריקה — שלב 2/5*\nאיזה סוג?', options: TYPE_OPTIONS };
    case 'time':
      return { question: '🔍 *סריקה — שלב 3/5*\nאיזה טווח זמן?', options: TIME_OPTIONS };
    case 'scope':
      return { question: '🔍 *סריקה — שלב 4/5*\nמה ההיקף?', options: SCOPE_OPTIONS };
    case 'items': {
      // Paginated multi-select poll. WhatsApp Poll limit = 12 options.
      // We need to fit: PAGE_SIZE items + optional "next" + "finish" + "cancel".
      // PAGE_SIZE=9 → max 9+1+1+1 = 12 = limit. Safe.
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
      const trackedHint = trackedCount > 0
        ? `\n⭐ = מהמעקב היומי (daily.json) — מוצגים ראשונים.`
        : '';
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

      // flow.confirmedSources is populated by advanceScanFlow before this step
      // (it pre-fetches from daily.json for 'all' or copies user picks for 'select').
      const sources = flow.confirmedSources || [];
      const groupCount = sources.filter(x => x.type === 'group').length;
      const channelCount = sources.filter(x => x.type === 'channel').length;
      const waCount = sources.filter(x => x.source === 'wa').length;
      const tgCount = sources.filter(x => x.source === 'tg').length;

      const breakdown = [];
      if (groupCount > 0) breakdown.push(`👥 ${groupCount} קבוצות`);
      if (channelCount > 0) breakdown.push(`📢 ${channelCount} ערוצים`);
      const platformBreak = [];
      if (waCount > 0) platformBreak.push(`💬 ${waCount} וואטסאפ`);
      if (tgCount > 0) platformBreak.push(`📡 ${tgCount} טלגרם`);

      const scopeLabel = s.scope === 'all'
        ? `🌐 רשימת המעקב היומי — *${sources.length} מקורות*${breakdown.length ? ` (${breakdown.join(' · ')})` : ''}`
        : `🎯 *${sources.length} מקורות נבחרים*${breakdown.length ? ` (${breakdown.join(' · ')})` : ''}`;

      // Always show the full list of sources to be scanned (this is what the
      // user explicitly asked for — see what's about to run)
      const itemsList = sources.length > 0
        ? '\n\n*המקורות לסריקה:*\n' + sources.slice(0, 30).map((item, i) =>
            `${i + 1}. ${item.label || item.raw}`
          ).join('\n') + (sources.length > 30 ? `\n... ועוד ${sources.length - 30}` : '')
        : '\n\n_אין מקורות לסריקה — דאג להוסיף ל-data/daily.json או לבחור ספציפיים_';

      const platformLine = platformBreak.length ? `\n${platformBreak.join(' · ')}` : '';

      return {
        question: `🔍 *אישור לפני הרצה:*\n\n${sourceLabel}\n${typeLabel}\n${timeLabel}${platformLine}\n${itemsList}\n\nלהריץ?`,
        options: CONFIRM_OPTIONS,
      };
    }
    default:
      return null;
  }
}

// ── Compute concrete minutes for time-window options ───────────
function timeOptionToMinutes(timeId) {
  const now = new Date();
  switch (timeId) {
    case 'hour':       return 60;
    case '24h':        return 1440;
    case '3days':      return 4320;
    case 'morning': {
      // 06:00 today; if past midnight already, count from today's 06:00
      const t = new Date(now); t.setHours(6, 0, 0, 0);
      if (t > now) t.setDate(t.getDate() - 1);
      return Math.round((now - t) / 60000);
    }
    case 'night': {
      // midnight today (00:00 of current day)
      const t = new Date(now); t.setHours(0, 0, 0, 0);
      return Math.round((now - t) / 60000);
    }
    case 'yesterday': {
      // from 00:00 yesterday
      const t = new Date(now); t.setDate(t.getDate() - 1); t.setHours(0, 0, 0, 0);
      return Math.round((now - t) / 60000);
    }
    default: return 1440;
  }
}

// ── Apply a vote, return { ok, error, finished, execute, params } ─
// `selected` is the option ID (or label — caller passes whichever)
function applyVote(flow, selected) {
  flow.lastActivity = Date.now();
  // Universal cancel
  if (selected === 'cancel' || selected === '❌ ביטול') {
    return { cancel: true };
  }

  const matchOption = (opts, id) =>
    opts.find(o => o.id === id || o.label === id);

  switch (flow.step) {
    case 'source': {
      const o = matchOption(SOURCE_OPTIONS, selected);
      if (!o || o.id === 'cancel') return { error: 'בחירה לא תקפה' };
      // Preset shortcut: skip type/scope/items steps
      if (o.id === 'preset') {
        if (presets.list().length === 0) return { error: 'אין פריסטים שמורים' };
        flow.step = 'preset_pick';
        return { ok: true };
      }
      flow.selections.source = o.id;
      flow.step = 'type';
      return { ok: true };
    }
    case 'preset_pick': {
      if (selected === '__back__') {
        flow.step = 'source';
        return { ok: true };
      }
      const m = String(selected).match(/^preset:(.+)$/);
      if (!m) return { error: 'בחירה לא תקפה' };
      const preset = presets.getById(m[1]);
      if (!preset) return { error: 'הפריסט לא נמצא' };

      // ── Dynamic preset (daily.json) — defer source resolution to runtime ──
      // Don't hydrate confirmedSources here; let advanceScanFlow's existing
      // resolveDailyScanSources() do it when the confirm step is reached.
      // This way new entries added to daily.json show up automatically.
      if (preset.isDynamic) {
        flow.selections.source = 'whatsapp'; // daily.json is WA-only by convention
        flow.selections.type = 'both';
        flow.selections.scope = 'all';
        flow.usedPresetName = preset.name;
        flow.step = 'time';
        return { ok: true, presetName: preset.name };
      }

      // ── Static preset — hydrate from saved sources ──
      const hasWa = preset.sources.some(s => s.source === 'wa');
      const hasTg = preset.sources.some(s => s.source === 'tg');
      const hasGroups = preset.sources.some(s => s.type === 'group');
      const hasChannels = preset.sources.some(s => s.type === 'channel');
      flow.selections.source = (hasWa && hasTg) ? 'both' : (hasWa ? 'whatsapp' : 'telegram');
      flow.selections.type = (hasGroups && hasChannels) ? 'both' : (hasGroups ? 'groups' : 'channels');
      flow.selections.scope = 'select';
      flow.selections.selectedItems = preset.sources.map(s => s.id);
      flow.availableItems = preset.sources;  // for confirm display
      flow.confirmedSources = preset.sources; // skip resolve in advanceScanFlow
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
      // ── If the user came in via a saved preset, skip scope/items entirely.
      // For static presets — confirmedSources is already populated.
      // For the dynamic daily.json preset — only usedPresetName is set; the
      // sources get resolved in advanceScanFlow when entering 'confirm'.
      // Either way: presets imply "source list already decided".
      if (flow.usedPresetName) {
        flow.step = 'confirm';
      } else {
        flow.step = 'scope';
      }
      return { ok: true };
    }
    case 'scope': {
      const o = matchOption(SCOPE_OPTIONS, selected);
      if (!o || o.id === 'cancel') return { error: 'בחירה לא תקפה' };
      flow.selections.scope = o.id;
      if (o.id === 'all') {
        flow.step = 'confirm';
      } else {
        flow.step = 'items';
        // caller must populate availableItems before showing the items poll
        return { ok: true, needsItems: true };
      }
      return { ok: true };
    }
    case 'items': {
      // Multi-select votes arrive individually as the user toggles each.
      // Handle: '__next_page__', '__finish__', or 'item:N'
      // IMPORTANT: PAGE_SIZE must match buildPoll's value (9, due to
      // WhatsApp's 12-option-per-poll cap).
      const PAGE_SIZE = 9;
      if (selected === '__next_page__') {
        if ((flow.itemsPage + 1) * PAGE_SIZE < flow.availableItems.length) {
          flow.itemsPage += 1;
        }
        return { ok: true };
      }
      if (selected === '__finish__') {
        if (flow.selections.selectedItems.length === 0) {
          return { error: 'לא בחרת אף מקור. בחר לפחות אחד או לחץ ❌ ביטול.' };
        }
        flow.step = 'confirm';
        return { ok: true };
      }
      const m = String(selected).match(/^item:(\d+)$/);
      if (m) {
        const idx = parseInt(m[1], 10);
        const item = flow.availableItems[idx];
        if (!item) return { error: 'פריט לא תקין' };
        // Toggle
        const cur = flow.selections.selectedItems;
        if (cur.includes(item.id)) {
          flow.selections.selectedItems = cur.filter(x => x !== item.id);
        } else {
          cur.push(item.id);
        }
        return { ok: true };
      }
      return { error: 'בחירה לא תקפה' };
    }
    case 'confirm': {
      const o = matchOption(CONFIRM_OPTIONS, selected);
      if (!o || o.id === 'cancel') return { cancel: true };
      if (o.id === 'edit') return { restart: true };
      if (o.id === 'run') {
        // Build the final execution params
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
    default:
      return { error: 'מצב לא תקף' };
  }
}

// ── Trigger detection ────────────────────────────────────────────
// Should the bot show the disambiguation menu for this user message?
function shouldShowMenu(text) {
  if (!text) return false;
  const t = text.trim();

  // Explicit triggers — always menu
  if (/^(תפריט\s+(?:סריקה|סקירה)|סריקה\s+(?:אינטראקטיבית|מותאמת)|סקירה\s+(?:אינטראקטיבית|מותאמת))/i.test(t)) {
    return true;
  }

  // Very short standalone — "סקירה", "סריקה", "תעשה סריקה" — show menu
  // (the user has no time/source/type context, so we need to ask)
  if (/^(?:תעשה\s+(?:לי\s+)?)?(?:סקירה|סריקה)\s*[\?\.!]?$/i.test(t)) return true;
  if (/^(?:תסרוק|תסרוק לי)\s*[\?\.!]?$/i.test(t)) return true;

  // Has "סקירה/סריקה" but missing BOTH platform AND specific source-type
  const hasScan = /\b(?:סריקה|סקירה|תסרוק)\b/i.test(t);
  if (!hasScan) return false;
  const mentionsPlatform = /\b(טלגרם|telegram|וואטסאפ|whatsapp|וואטסטפ)\b/i.test(t);
  const mentionsType = /\b(קבוצות|ערוצים|הקבוצות|הערוצים)\b/i.test(t);
  if (!mentionsPlatform && !mentionsType) return true;

  return false;
}

module.exports = {
  flows,
  startFlow,
  endFlow,
  getFlow,
  updateFlow,
  buildPoll,
  applyVote,
  shouldShowMenu,
  timeOptionToMinutes,
  STEPS,
};
