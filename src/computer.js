'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const HOME = os.homedir();

const DIRS = {
  'desktop':       path.join(HOME, 'OneDrive', 'שולחן העבודה'),
  'שולחן עבודה':  path.join(HOME, 'OneDrive', 'שולחן העבודה'),
  'שולחן':        path.join(HOME, 'OneDrive', 'שולחן העבודה'),
  'documents':     path.join(HOME, 'OneDrive', 'מסמכים'),
  'מסמכים':        path.join(HOME, 'OneDrive', 'מסמכים'),
  'downloads':     path.join(HOME, 'Downloads'),
  'הורדות':        path.join(HOME, 'Downloads'),
  'onedrive':      path.join(HOME, 'OneDrive'),
  'pictures':      path.join(HOME, 'OneDrive', 'תמונות'),
  'תמונות':        path.join(HOME, 'OneDrive', 'תמונות'),
  'videos':        path.join(HOME, 'OneDrive', 'Videos'),
  'סרטונים':       path.join(HOME, 'OneDrive', 'Videos'),
};

function getSystemInfo() {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  const memPct   = Math.round((usedMem / totalMem) * 100);
  const cpus     = os.cpus();
  const cpuName  = cpus[0]?.model.replace(/\s+/g, ' ').trim() || 'לא ידוע';
  const uptime   = os.uptime();
  const hours    = Math.floor(uptime / 3600);
  const mins     = Math.floor((uptime % 3600) / 60);
  const user     = os.userInfo().username;
  const hostname = os.hostname();

  let diskInfo = '';
  try {
    const stat = fs.statfsSync('C:\\');
    const total = stat.blocks * stat.bsize;
    const free  = stat.bfree  * stat.bsize;
    const used  = total - free;
    diskInfo = `\n💾 *דיסק C:* ${fmt(used)} / ${fmt(total)} (${Math.round(used/total*100)}%)`;
  } catch {}

  return `💻 *המחשב שלך*

👤 ${user} @ ${hostname}
⚙️ ${cpuName} (${cpus.length} ליבות)
🧠 זיכרון: ${fmt(usedMem)} / ${fmt(totalMem)} (${memPct}%)${diskInfo}
⏱️ דלוק כבר ${hours} שעות ו-${mins} דקות`;
}

function listFiles(dirArg) {
  const key = (dirArg || 'desktop').toLowerCase().trim();
  const dir = DIRS[key];

  if (!dir) {
    const available = Object.keys(DIRS).filter(k => !/^[a-z]/.test(k)).join(', ');
    return `❌ תיקייה לא מוכרת: "${dirArg}"\n\nתיקיות: ${available}`;
  }

  if (!fs.existsSync(dir)) return `❌ התיקייה לא קיימת: ${dir}`;

  const items   = fs.readdirSync(dir, { withFileTypes: true });
  const folders = items.filter(i => i.isDirectory()).slice(0, 10).map(i => `📁 ${i.name}`);
  const files   = items.filter(i => i.isFile()).slice(0, 20).map(i => {
    const ext  = path.extname(i.name).toLowerCase();
    const icon = ext === '.pdf' ? '📕' : ext === '.docx' ? '📝' : ext === '.xlsx' ? '📊'
               : ext === '.jpg' || ext === '.png' ? '🖼️' : ext === '.mp4' ? '🎬'
               : ext === '.zip' || ext === '.rar' ? '📦' : ext === '.pptx' ? '📊'
               : ext === '.js' || ext === '.py' ? '💻' : '📄';
    return `${icon} ${i.name}`;
  });

  const all   = [...folders, ...files];
  const extra = items.length - all.length;

  return `📂 *${path.basename(dir)}* (${items.length} פריטים)\n\n` +
    (all.length ? all.join('\n') : '📭 ריק') +
    (extra > 0 ? `\n\n...ועוד ${extra} פריטים` : '');
}

function readFile(filename) {
  // Search in all known dirs
  for (const dir of [...new Set(Object.values(DIRS))]) {
    const full = path.join(dir, filename);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(filename).toLowerCase();
      if (['.jpg','.png','.gif','.pdf','.zip','.exe','.mp4','.mp3','.rar'].includes(ext)) {
        const stat = fs.statSync(full);
        return `📄 *${filename}*\n📦 ${fmt(stat.size)}\n📂 ${full}`;
      }
      try {
        const content = fs.readFileSync(full, 'utf-8');
        const trimmed = content.length > 3000 ? content.substring(0, 3000) + '\n\n...(חתוך)' : content;
        return `📄 *${filename}:*\n\`\`\`\n${trimmed}\n\`\`\``;
      } catch {
        return `❌ לא ניתן לקרוא (binary?)`;
      }
    }
  }
  return `❌ "${filename}" לא נמצא`;
}

function searchFiles(query) {
  const results = [];
  for (const dir of [...new Set(Object.values(DIRS))]) {
    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        if (item.toLowerCase().includes(query.toLowerCase())) {
          results.push(`📄 ${item} (${path.basename(dir)})`);
          if (results.length >= 15) break;
        }
      }
    } catch {}
    if (results.length >= 15) break;
  }
  if (!results.length) return `🔍 לא מצאתי קבצים עם "${query}"`;
  return `🔍 *תוצאות חיפוש: "${query}"*\n\n` + results.join('\n');
}

function runCommand(cmd) {
  // Safety: block dangerous commands
  const blocked = ['format', 'del /s', 'rm -rf', 'shutdown', 'restart', 'reg delete', 'diskpart'];
  if (blocked.some(b => cmd.toLowerCase().includes(b))) {
    return Promise.resolve('❌ פקודה חסומה מסיבות בטיחות');
  }

  return new Promise((resolve) => {
    exec(cmd, { timeout: 15000, encoding: 'utf-8', shell: 'cmd.exe' }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) {
        resolve(`❌ שגיאה: ${err.message.substring(0, 200)}`);
        return;
      }
      const output = (stdout || '') + (stderr ? '\n⚠️ ' + stderr : '');
      const trimmed = output.length > 2000 ? output.substring(0, 2000) + '\n...(חתוך)' : output;
      resolve(`💻 *פלט:*\n\`\`\`\n${trimmed || '(ללא פלט)'}\n\`\`\``);
    });
  });
}

function getProcesses() {
  return new Promise((resolve) => {
    exec('powershell -Command "Get-Process | Sort-Object -Property CPU -Descending | Select-Object -First 10 Name,CPU,WorkingSet | Format-Table -AutoSize"',
      { timeout: 10000, encoding: 'utf-8' }, (err, stdout) => {
        if (err) { resolve('❌ שגיאה בקריאת תהליכים'); return; }
        resolve(`⚡ *תהליכים פעילים (Top 10):*\n\`\`\`\n${stdout.trim()}\n\`\`\``);
      });
  });
}

function getBattery() {
  return new Promise((resolve) => {
    exec('powershell -Command "(Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus).EstimatedChargeRemaining"',
      { timeout: 5000, encoding: 'utf-8' }, (err, stdout) => {
        const pct = parseInt(stdout?.trim());
        if (isNaN(pct)) { resolve('🔌 מחובר לחשמל (ללא סוללה)'); return; }
        const icon = pct > 80 ? '🔋' : pct > 30 ? '🪫' : '⚠️';
        resolve(`${icon} סוללה: *${pct}%*`);
      });
  });
}

function getWifi() {
  return new Promise((resolve) => {
    exec('netsh wlan show interfaces', { timeout: 5000, encoding: 'utf-8' }, (err, stdout) => {
      if (err || !stdout) { resolve('📶 לא מחובר ל-WiFi'); return; }
      const ssid = stdout.match(/SSID\s*:\s*(.+)/)?.[1]?.trim() || 'לא ידוע';
      const signal = stdout.match(/Signal\s*:\s*(.+)/)?.[1]?.trim() || '';
      resolve(`📶 WiFi: *${ssid}* ${signal}`);
    });
  });
}

function fmt(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

module.exports = { getSystemInfo, listFiles, readFile, searchFiles, runCommand, getProcesses, getBattery, getWifi };
