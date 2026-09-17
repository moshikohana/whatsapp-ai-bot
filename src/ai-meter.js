'use strict';
/**
 * 💰 כמה עולה כל פיצ'ר — ותקרה יומית.
 *
 * עד 17.9 היה רק מונה כללי, בלי פילוח, והקרדיט נגמר באמצע ראיון חי. הערכה
 * לפי מספר קריאות אמרה 25–35 דולר ביום, והמטרה היא 1–2. כאן כל קריאה למודל,
 * מכל מקום בקוד, נספרת לפי הקובץ שקרא לה, עם הטוקנים שה-API עצמו מחזיר.
 *
 * התקרה עוצרת לפי סדר: קודם התוספות (נושאים, כבר ידוע, אומת, סיכומים), אחר
 * כך סיווג הקבוצות, ובסוף — רק הרבה מעל התקרה — הרדיו והשיחה שלו.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DIR = path.join(__dirname, '..', 'data', 'ai-usage');
const CAP = () => Number(process.env.AI_DAILY_USD) || 2;

// $ per million tokens: input, output. Cache reads 0.1×, writes 1.25× input.
const PRICES = [
  [/haiku/i, 1, 5],
  [/sonnet/i, 3, 15],
  [/opus/i, 5, 25],
  [/fable/i, 5, 25],
];
function _price(model) {
  for (const [re, i, o] of PRICES) if (re.test(model || '')) return { i, o };
  return { i: 3, o: 15 };
}

// Which part of the bot a file belongs to — the order things stop in.
const TIER = {
  core: /^(index|claude|broadcast-headlines|broadcast-focus|broadcast-monitor|call-brief|web)\b/,
  feed: /^(news-feed|news-apps|grounding)\b/,
};
function tierOf(label) {
  const f = String(label || '').split(':')[0];
  if (TIER.core.test(f)) return 'core';
  if (TIER.feed.test(f)) return 'feed';
  return 'extra';
}
// Share of the cap at which each tier stops.
const STOP_AT = { extra: 0.6, feed: 0.85, core: 3 };

const _day = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
let _cur = null;
function _load() {
  const d = _day();
  if (_cur && _cur.date === d) return _cur;
  try { _cur = JSON.parse(fs.readFileSync(path.join(DIR, d + '.json'), 'utf8')); } catch { _cur = null; }
  if (!_cur || _cur.date !== d) _cur = { date: d, usd: 0, calls: 0, byLabel: {}, byModel: {}, blocked: {}, notified: false };
  return _cur;
}
let _saveTimer = null;
function _save() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, _cur.date + '.json'), JSON.stringify(_cur)); } catch (_) {}
  }, 3000);
}

/** The file (and function) that asked — the first frame outside the SDK and this file. */
function _caller() {
  const lines = String(new Error().stack || '').split('\n').slice(2);
  for (const l of lines) {
    if (/node_modules|ai-meter\.js|node:internal/.test(l)) continue;
    const m = l.match(/at (?:async )?(?:([\w.$<>]+) )?\(?(?:.*[\\/])?([\w.-]+)\.js:\d+/);
    if (!m) continue;
    const file = m[2];
    // claude.js is a helper: the real asker is further up, unless claude.js is all there is.
    if (file === 'claude') continue;
    const fn = (m[1] || '').replace(/^Object\.|^Timeout\.|^Immediate\./, '').split('.').pop();
    return fn && fn !== '<anonymous>' ? `${file}:${fn}` : file;
  }
  return 'claude';
}

function record(model, usage, label) {
  if (!usage) return;
  const c = _load();
  const p = _price(model);
  const inp = usage.input_tokens || 0, out = usage.output_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0, cw = usage.cache_creation_input_tokens || 0;
  const usd = (inp * p.i + out * p.o + cr * p.i * 0.1 + cw * p.i * 1.25) / 1e6;
  const L = c.byLabel[label] || (c.byLabel[label] = { calls: 0, in: 0, out: 0, usd: 0, tier: tierOf(label) });
  L.calls++; L.in += inp + cr + cw; L.out += out; L.usd += usd;
  const M = c.byModel[model] || (c.byModel[model] = { calls: 0, usd: 0 });
  M.calls++; M.usd += usd;
  c.calls++; c.usd += usd;
  _save();
}

let _notify = null;
function onCap(fn) { _notify = fn; }

/** May this tier call the model now? Counts refusals, tells him once a day. */
function allow(label) {
  const c = _load();
  const tier = tierOf(label);
  if (c.usd < CAP() * STOP_AT[tier]) return true;
  c.blocked[label] = (c.blocked[label] || 0) + 1;
  if (!c.notified && tier !== 'core') {
    c.notified = true;
    logger.warn(`💰 AI budget: $${c.usd.toFixed(2)} of $${CAP()} — ${tier} calls paused for today`);
    if (_notify) { try { _notify(c); } catch (_) {} }
  }
  _save();
  return false;
}

class BudgetError extends Error {
  constructor(label) { super(`AI daily budget reached (${label})`); this.name = 'BudgetError'; this.status = 0; }
}

let _installed = false;
/** Wraps the SDK once, so every `new Anthropic()` anywhere is counted. */
function install() {
  if (_installed) return;
  _installed = true;
  try {
    const A = require('@anthropic-ai/sdk');
    const proto = A.Messages && A.Messages.prototype;
    if (!proto || !proto.create) { logger.warn('💰 ai-meter: SDK shape unknown — not counting'); return; }
    const orig = proto.create;
    proto.create = function (body, ...rest) {
      const label = _caller();
      if (!allow(label)) return Promise.reject(new BudgetError(label));
      const p = orig.call(this, body, ...rest);
      if (!(body && body.stream)) {
        Promise.resolve(p).then(r => record((r && r.model) || (body && body.model), r && r.usage, label)).catch(() => {});
      }
      return p;
    };
    logger.info('💰 ai-meter: counting every model call');
  } catch (e) { logger.warn('💰 ai-meter: ' + (e.message || '').substring(0, 60)); }
}

/** היום, לפי פיצ'ר — לאפליקציה ולוואטסאפ. */
function today() {
  const c = _load();
  const rows = Object.entries(c.byLabel).map(([label, v]) => ({ label, ...v, usd: +v.usd.toFixed(4) }))
    .sort((a, b) => b.usd - a.usd);
  const byTier = {};
  for (const r of rows) byTier[r.tier] = +((byTier[r.tier] || 0) + r.usd).toFixed(4);
  return { date: c.date, usd: +c.usd.toFixed(4), cap: CAP(), calls: c.calls, byTier, rows, byModel: c.byModel, blocked: c.blocked };
}

/** Before a long, optional job: is there room left for this kind of work? */
function hasRoom(label) { return allow(label); }

module.exports = { install, record, today, onCap, allow, hasRoom, tierOf, BudgetError };
