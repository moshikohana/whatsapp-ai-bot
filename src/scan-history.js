'use strict';
const fs = require('fs');
const path = require('path');

const SCANS_ROOT = path.join(__dirname, '..', 'data', 'scans');
const IL_TZ = 'Asia/Jerusalem';

// ── Israel-local date/time helpers ───────────────────────────────
function ilParts(ts) {
  // Uses Intl to get Israel-local Y/M/D/H/M reliably (DST-safe)
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IL_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => (parts.find(p => p.type === t) || {}).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,   // YYYY-MM-DD
    time: `${get('hour')}-${get('minute')}`,                 // HH-MM
    timeColon: `${get('hour')}:${get('minute')}`,            // HH:MM
  };
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('[scan-history] mkdir failed:', dir, err.message);
  }
}

// ── saveScan ─────────────────────────────────────────────────────
/**
 * Persist a scan to disk under data/scans/YYYY-MM-DD/HH-MM-<kind>.json.
 * @param {Object} scan
 * @returns {{path: string, filename: string} | null}
 */
function saveScan(scan) {
  try {
    if (!scan || typeof scan !== 'object') {
      console.error('[scan-history] saveScan: invalid scan object');
      return null;
    }
    const kind = scan.kind || 'manual';
    const ts = typeof scan.timestamp === 'number' ? scan.timestamp : Date.now();
    const { date, time } = ilParts(ts);

    const dayDir = path.join(SCANS_ROOT, date);
    ensureDir(dayDir);

    // Collision-safe filename: HH-MM-<kind>.json, then -2, -3, ... if needed
    let filename = `${time}-${kind}.json`;
    let full = path.join(dayDir, filename);
    let n = 2;
    while (fs.existsSync(full)) {
      filename = `${time}-${kind}-${n}.json`;
      full = path.join(dayDir, filename);
      n++;
    }

    const payload = {
      kind,
      timestamp: ts,
      windowLabel: scan.windowLabel || '',
      groupStats: Array.isArray(scan.groupStats) ? scan.groupStats : [],
      totalMessages: typeof scan.totalMessages === 'number' ? scan.totalMessages : 0,
      activeGroups: typeof scan.activeGroups === 'number' ? scan.activeGroups : 0,
      skippedGroups: Array.isArray(scan.skippedGroups) ? scan.skippedGroups : [],
      hotGroup: scan.hotGroup || null,
      scanOutput: typeof scan.scanOutput === 'string' ? scan.scanOutput : '',
    };
    if (Array.isArray(scan.rawMessages)) payload.rawMessages = scan.rawMessages;

    fs.writeFileSync(full, JSON.stringify(payload, null, 2), 'utf8');
    return { path: full, filename };
  } catch (err) {
    console.error('[scan-history] saveScan failed:', err.message);
    return null;
  }
}

// ── listScans ────────────────────────────────────────────────────
/**
 * List scan metadata, newest first.
 * @param {{date?: string, kind?: string, limit?: number}} [opts]
 * @returns {Array<{filename, kind, timestamp, time, totalMessages, activeGroups, date, path}>}
 */
function listScans(opts) {
  const { date, kind, limit = 20 } = opts || {};
  try {
    if (!fs.existsSync(SCANS_ROOT)) return [];

    const days = date
      ? [date]
      : fs.readdirSync(SCANS_ROOT).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();

    const results = [];
    for (const day of days) {
      const dayDir = path.join(SCANS_ROOT, day);
      if (!fs.existsSync(dayDir)) continue;
      let files;
      try { files = fs.readdirSync(dayDir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const full = path.join(dayDir, f);
        let data;
        try {
          data = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (err) {
          console.error('[scan-history] skip unreadable:', full, err.message);
          continue;
        }
        if (kind && data.kind !== kind) continue;
        const { time: timeStr, timeColon } = ilParts(data.timestamp || Date.now());
        results.push({
          filename: f,
          kind: data.kind,
          timestamp: data.timestamp,
          time: timeColon,
          date: day,
          totalMessages: data.totalMessages || 0,
          activeGroups: data.activeGroups || 0,
          windowLabel: data.windowLabel || '',
          hotGroup: data.hotGroup || null,
          path: full,
        });
      }
    }

    results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return results.slice(0, Math.max(0, limit));
  } catch (err) {
    console.error('[scan-history] listScans failed:', err.message);
    return [];
  }
}

// ── loadScan ─────────────────────────────────────────────────────
/**
 * Load a full scan payload by filename. Searches all day folders if needed.
 * @param {string} filename  - e.g. "08-30-daily.json" or full path
 * @returns {Object | null}
 */
function loadScan(filename) {
  try {
    if (!filename) return null;

    // If a full path was passed, use it directly
    if (path.isAbsolute(filename) && fs.existsSync(filename)) {
      return JSON.parse(fs.readFileSync(filename, 'utf8'));
    }

    if (!fs.existsSync(SCANS_ROOT)) return null;

    // Normalize: filename may be "08-18-manual.json" OR
    // "2026-05-04/08-18-manual.json" (the format the listScans/today
    // actions return). Try both: relative-from-SCANS_ROOT first, then
    // search each day folder for the basename.
    const direct = path.join(SCANS_ROOT, filename);
    if (fs.existsSync(direct)) {
      return JSON.parse(fs.readFileSync(direct, 'utf8'));
    }

    const basename = path.basename(filename);
    const days = fs.readdirSync(SCANS_ROOT)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();

    for (const day of days) {
      const candidate = path.join(SCANS_ROOT, day, basename);
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf8'));
      }
    }
    return null;
  } catch (err) {
    console.error('[scan-history] loadScan failed:', err.message);
    return null;
  }
}

// ── getLatestScan ────────────────────────────────────────────────
/**
 * Most recent scan (optionally filtered by kind). Returns full payload or null.
 * @param {string} [kind]
 * @returns {Object | null}
 */
function getLatestScan(kind) {
  try {
    const [latest] = listScans({ kind, limit: 1 });
    if (!latest) return null;
    return JSON.parse(fs.readFileSync(latest.path, 'utf8'));
  } catch (err) {
    console.error('[scan-history] getLatestScan failed:', err.message);
    return null;
  }
}

module.exports = {
  saveScan,
  listScans,
  loadScan,
  getLatestScan,
};
