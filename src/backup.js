'use strict';
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const BOT_ROOT    = path.join(__dirname, '..');
const DATA_DIR    = path.join(BOT_ROOT, 'data');
const BACKUPS_DIR = path.join(BOT_ROOT, 'backups');

// ── Helpers ──────────────────────────────────────────────────────
/**
 * Returns today's date in Israel local time as 'YYYY-MM-DD'.
 * Uses the 'en-CA' locale which already outputs ISO-style YYYY-MM-DD.
 */
function getIsraelDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function ensureBackupsDir() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
}

// ── runBackup() ──────────────────────────────────────────────────
/**
 * Zips the bot's data/ directory into backups/data-YYYY-MM-DD.zip
 * using Windows PowerShell's Compress-Archive. Overwrites any existing
 * file for today. Catches all errors; never throws.
 *
 * @returns {Promise<{success: boolean, path: string, size: number, durationMs: number, error?: string}>}
 */
async function runBackup() {
  const start = Date.now();
  const dateStr = getIsraelDateString();
  const zipName = `data-${dateStr}.zip`;
  const zipPath = path.join(BACKUPS_DIR, zipName);

  try {
    ensureBackupsDir();

    // Guard: data/ must exist
    if (!fs.existsSync(DATA_DIR)) {
      return {
        success: false,
        path: zipPath,
        size: 0,
        durationMs: Date.now() - start,
        error: `data directory missing: ${DATA_DIR}`,
      };
    }

    // Build the PowerShell command. We cd to BOT_ROOT via `cwd`
    // so relative paths `data\*` and `backups\...` resolve correctly.
    const psCmd = `Compress-Archive -Path 'data\\*' -DestinationPath 'backups\\${zipName}' -Force`;
    const fullCmd = `powershell.exe -NoProfile -NonInteractive -Command "${psCmd}"`;

    await new Promise((resolve, reject) => {
      exec(fullCmd, { cwd: BOT_ROOT, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          err.stdout = stdout;
          return reject(err);
        }
        resolve({ stdout, stderr });
      });
    });

    // Confirm file exists and measure size
    if (!fs.existsSync(zipPath)) {
      return {
        success: false,
        path: zipPath,
        size: 0,
        durationMs: Date.now() - start,
        error: 'zip file not found after Compress-Archive completed',
      };
    }

    const stat = fs.statSync(zipPath);
    return {
      success: true,
      path: zipPath,
      size: stat.size,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      path: zipPath,
      size: 0,
      durationMs: Date.now() - start,
      error: (err && err.message) ? err.message : String(err),
    };
  }
}

// ── pruneOldBackups() ────────────────────────────────────────────
/**
 * Deletes backups/data-YYYY-MM-DD.zip files whose filename date is
 * older than `keepDays` days ago (Israel local time).
 *
 * @param {{keepDays?: number}} options
 * @returns {{deleted: number, kept: number}}
 */
function pruneOldBackups({ keepDays = 7 } = {}) {
  let deleted = 0;
  let kept = 0;
  try {
    if (!fs.existsSync(BACKUPS_DIR)) return { deleted: 0, kept: 0 };

    // Compute cutoff: anything with a date strictly before cutoffDate is deleted.
    const now = new Date();
    const cutoff = new Date(now.getTime() - keepDays * 24 * 3600 * 1000);
    const cutoffStr = getIsraelDateString(cutoff);

    const files = fs.readdirSync(BACKUPS_DIR);
    const re = /^data-(\d{4}-\d{2}-\d{2})\.zip$/;

    for (const f of files) {
      const m = f.match(re);
      if (!m) continue;
      const fileDate = m[1];
      // Lexicographic comparison works because format is YYYY-MM-DD.
      if (fileDate < cutoffStr) {
        try {
          fs.unlinkSync(path.join(BACKUPS_DIR, f));
          deleted++;
        } catch {
          // If we couldn't delete, count it as kept so the caller sees reality.
          kept++;
        }
      } else {
        kept++;
      }
    }
  } catch {
    // Swallow — pruning is best-effort.
  }
  return { deleted, kept };
}

// ── scheduleDailyBackup() ────────────────────────────────────────
/**
 * Schedules a daily backup + prune at 23:00 Asia/Jerusalem via node-cron.
 * The caller injects node-cron so this module doesn't hard-require it.
 *
 * @param {object} cronLib - typically `require('node-cron')`
 * @returns {object} the scheduled task handle (call .stop() to cancel)
 */
function scheduleDailyBackup(cronLib) {
  if (!cronLib || typeof cronLib.schedule !== 'function') {
    throw new Error('scheduleDailyBackup: cronLib with .schedule() required');
  }

  const task = cronLib.schedule(
    '0 23 * * *',
    async () => {
      const startIso = new Date().toISOString();
      console.log(`[backup] daily run started at ${startIso}`);
      try {
        const res = await runBackup();
        if (res.success) {
          const kb = (res.size / 1024).toFixed(1);
          console.log(`[backup] zip ok → ${res.path} (${kb} KB, ${res.durationMs} ms)`);
        } else {
          console.log(`[backup] zip FAILED → ${res.error}`);
        }
        const pruneRes = pruneOldBackups();
        console.log(`[backup] prune done → deleted=${pruneRes.deleted}, kept=${pruneRes.kept}`);
      } catch (err) {
        console.log(`[backup] unexpected error: ${err && err.message ? err.message : err}`);
      }
      console.log(`[backup] daily run finished`);
    },
    { timezone: 'Asia/Jerusalem' }
  );

  console.log(`[backup] scheduled daily at 23:00 Asia/Jerusalem`);
  return task;
}

module.exports = {
  runBackup,
  pruneOldBackups,
  scheduleDailyBackup,
  // Exported for testing / ad-hoc use:
  getIsraelDateString,
};
