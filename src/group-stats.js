'use strict';
/**
 * Long-horizon per-group analytics rollup.
 *
 * The raw message cache (_msgCache in index.js) only retains ~48h / 250 msgs
 * per group, so it can't answer "who posted most over the last 2 weeks". This
 * module keeps a cheap COUNTS-ONLY rollup — per group, per Israel-day: total
 * messages, per-sender counts, per-hour counts — retained for 30 days. It's
 * tiny (integers, not message bodies) so it scales to weeks of history.
 *
 * Topic detection still needs recent bodies (from _msgCache), so the deep
 * window covers volume / top posters / busiest hours; the topic stays recent.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'group-stats.json');
const RETAIN_DAYS = 30;

let stats = {}; // { [cid]: { name, days: { 'YYYY-MM-DD': { total, sender:{n}, hour:{n} } } } }
let dirty = false;

function _dateIL(ts) { return new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); } // YYYY-MM-DD (sortable)
function _hourIL(ts) { return new Date(ts * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).trim(); }

function _prune() {
  const cutoff = _dateIL(Math.floor(Date.now() / 1000) - RETAIN_DAYS * 86400);
  for (const cid of Object.keys(stats)) {
    const days = stats[cid].days || {};
    for (const day of Object.keys(days)) if (day < cutoff) delete days[day];
    if (!Object.keys(days).length) delete stats[cid];
  }
  dirty = true;
}

(function _load() {
  try { stats = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { stats = {}; }
  _prune();
})();

// Record one message into the rollup. sender is the display name (may be empty).
function record(cid, name, ts, sender) {
  if (!cid || !ts) return;
  const day = _dateIL(ts);
  const g = stats[cid] || (stats[cid] = { name: name || '', days: {} });
  if (name) g.name = name;
  const d = g.days[day] || (g.days[day] = { total: 0, sender: {}, hour: {} });
  d.total++;
  const s = ((sender || '').trim()) || '—';
  d.sender[s] = (d.sender[s] || 0) + 1;
  const h = _hourIL(ts);
  d.hour[h] = (d.hour[h] || 0) + 1;
  dirty = true;
}

// Aggregate the last `sinceDays` Israel-days for a group. Returns null if empty.
function getStats(cid, sinceDays = 7) {
  const g = stats[cid];
  if (!g) return null;
  const cutoff = _dateIL(Math.floor(Date.now() / 1000) - sinceDays * 86400);
  const agg = { total: 0, sender: {}, hour: {}, days: 0, firstDay: null, lastDay: null };
  for (const [day, d] of Object.entries(g.days)) {
    if (day < cutoff) continue;
    agg.days++;
    agg.total += d.total;
    if (!agg.firstDay || day < agg.firstDay) agg.firstDay = day;
    if (!agg.lastDay || day > agg.lastDay) agg.lastDay = day;
    for (const [s, n] of Object.entries(d.sender)) agg.sender[s] = (agg.sender[s] || 0) + n;
    for (const [h, n] of Object.entries(d.hour)) agg.hour[h] = (agg.hour[h] || 0) + n;
  }
  return agg.total ? agg : null;
}

function save() { if (!dirty) return; try { fs.writeFileSync(FILE, JSON.stringify(stats)); dirty = false; } catch {} }

setInterval(save, 60 * 1000).unref?.();
setInterval(_prune, 6 * 3600 * 1000).unref?.();
process.on('exit', save);

module.exports = { record, getStats, save };
