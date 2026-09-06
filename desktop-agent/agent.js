'use strict';
/**
 * סוכן שולחני — runs on Moshiko's PC, not on the server.
 *
 *   npm i socket.io-client
 *   set BOT_URL=https://<the bot tunnel url>
 *   set AGENT_SECRET=<same secret as the server .env>
 *   node agent.js
 *
 * It dials OUT to the bot, so nothing needs to be opened on the home router.
 * It executes only the named actions below — there is no "run any command"
 * path on purpose, because this process can act as the user.
 */
const os = require('os');
const { execFile } = require('child_process');
const { io } = require('socket.io-client');

// Settings come from agent.config.json next to this file, so nothing depends
// on shell syntax (PowerShell's `set X=Y` silently does nothing, which is
// exactly how the first run failed). Environment variables still win if set.
let fileCfg = {};
try { fileCfg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'agent.config.json'), 'utf8')); } catch {}

const BOT_URL = process.env.BOT_URL || fileCfg.botUrl || 'http://localhost:3000';
const SECRET = process.env.AGENT_SECRET || fileCfg.secret || '';
const NAME = process.env.AGENT_NAME || fileCfg.name || os.hostname();

if (!SECRET) {
  console.error('❌ חסר AGENT_SECRET.');
  console.error('   ערוך את agent.config.json שליד הקובץ הזה, או הרץ את start-agent.bat.');
  process.exit(1);
}
console.log(`🔗 מתחבר אל ${BOT_URL} בשם "${NAME}"...`);

const socket = io(BOT_URL, { transports: ['websocket', 'polling'], reconnection: true });

socket.on('connect', () => {
  socket.emit('agent:hello', { secret: SECRET, name: NAME }, (res) => {
    if (res && res.ok) console.log(`✅ מחובר לבוט כ-"${NAME}". פעולות: ${res.actions.join(', ')}`);
    else console.error('❌ הבוט דחה את החיבור:', res && res.error);
  });
});
socket.on('disconnect', () => console.log('🔌 נותק — מנסה להתחבר מחדש...'));
socket.on('connect_error', (e) => console.log('⚠️ שגיאת חיבור:', e.message));

// ── Action handlers ──────────────────────────────────────────────
const handlers = {
  async ping() {
    return { host: os.hostname(), platform: os.platform(), uptimeMin: Math.round(os.uptime() / 60) };
  },

  async screenshot() {
    // Windows: PowerShell captures the primary screen to a temp PNG.
    const out = require('path').join(os.tmpdir(), `agent-shot-${Date.now()}.png`);
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
      `$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;` +
      `$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;` +
      `$g=[System.Drawing.Graphics]::FromImage($bmp);` +
      `$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size);` +
      `$bmp.Save('${out.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png);`;
    await new Promise((res, rej) =>
      execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 25000 }, e => e ? rej(e) : res()));
    const data = require('fs').readFileSync(out).toString('base64');
    try { require('fs').unlinkSync(out); } catch {}
    return { image: data, mime: 'image/png' };
  },

  async open_url({ url }) {
    if (!/^https?:\/\//i.test(url || '')) throw new Error('כתובת לא תקינה');
    await new Promise((res, rej) =>
      execFile('cmd', ['/c', 'start', '', url], { timeout: 10000 }, e => e ? rej(e) : res()));
    return { opened: url };
  },

  async notify({ title, message }) {
    const ps = `Add-Type -AssemblyName System.Windows.Forms;` +
      `$n=New-Object System.Windows.Forms.NotifyIcon;` +
      `$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;` +
      `$n.ShowBalloonTip(8000,'${String(title || 'בוטי').replace(/'/g, "''")}','${String(message || '').replace(/'/g, "''")}',` +
      `[System.Windows.Forms.ToolTipIcon]::Info);Start-Sleep -Seconds 9;`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 15000 }, () => {});
    return { shown: true };
  },

  // Deliberately not implemented — the server also refuses it while
  // publishing is disabled. This is where browser automation will go.
  async publish() {
    throw new Error('פרסום עדיין לא מופעל בסוכן');
  },
};

socket.on('agent:action', async ({ requestId, action, params }) => {
  const fn = handlers[action];
  if (!fn) return socket.emit('agent:result', { requestId, ok: false, error: 'פעולה לא נתמכת' });
  console.log(`▶️ ${action}`, params && Object.keys(params).length ? params : '');
  try {
    const data = await fn(params || {});
    socket.emit('agent:result', { requestId, ok: true, data });
  } catch (e) {
    socket.emit('agent:result', { requestId, ok: false, error: (e.message || '').substring(0, 200) });
  }
});
