'use strict';
/**
 * Boti desktop agent — runs on the owner's PC, not on the server.
 *
 *   double-click start-agent.bat        (or: node agent.js)
 *   settings live in agent.config.json  { botUrl, secret, name }
 *
 * It dials OUT to the bot, so nothing needs to be opened on the home router.
 * It executes only the named actions below — there is deliberately no
 * "run any command" path, because this process can act as the user.
 *
 * NOTE: console output is English on purpose. The Windows console does not
 * do bidi properly and rendered Hebrew log lines reversed.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { io } = require('socket.io-client');

// Settings come from agent.config.json next to this file, so nothing depends
// on shell syntax (PowerShell's `set X=Y` silently does nothing, which is
// exactly how the first run failed). Environment variables still win if set.
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent.config.json'), 'utf8')); } catch {}

const BOT_URL = process.env.BOT_URL || fileCfg.botUrl || 'http://localhost:3000';
const SECRET = process.env.AGENT_SECRET || fileCfg.secret || '';
const NAME = process.env.AGENT_NAME || fileCfg.name || os.hostname();

if (!SECRET) {
  console.error('[X] Missing secret. Edit agent.config.json next to this file.');
  process.exit(1);
}
console.log(`[..] Connecting to ${BOT_URL} as "${NAME}"`);

const socket = io(BOT_URL, { transports: ['websocket', 'polling'], reconnection: true });

socket.on('connect', () => {
  socket.emit('agent:hello', { secret: SECRET, name: NAME }, (res) => {
    if (res && res.ok) console.log(`[OK] Connected. Actions: ${res.actions.join(', ')}`);
    else console.error('[X] Bot rejected the connection:', res && res.error);
  });
});
socket.on('disconnect', () => console.log('[..] Disconnected - reconnecting...'));
socket.on('connect_error', (e) => console.log('[!] Connection error:', e.message));

// Run a PowerShell snippet and resolve when it exits.
function ps(script, timeout = 30000) {
  return new Promise((res, rej) =>
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, maxBuffer: 8 * 1024 * 1024 }, (e, so, se) => e ? rej(new Error(se || e.message)) : res(so)));
}

// ── Action handlers ──────────────────────────────────────────────
const handlers = {
  async ping() {
    return { host: os.hostname(), platform: os.platform(), uptimeMin: Math.round(os.uptime() / 60) };
  },

  // Captures ALL monitors at true resolution. The first version used
  // PrimaryScreen.Bounds, which grabs only the main display and — because the
  // process wasn't DPI-aware — returned scaled (cropped-looking) pixels.
  async screenshot({ primaryOnly } = {}) {
    const out = path.join(os.tmpdir(), `agent-shot-${Date.now()}.png`);
    const outEsc = out.replace(/\\/g, '\\\\');
    const region = primaryOnly
      ? '[System.Windows.Forms.Screen]::PrimaryScreen.Bounds'
      : '[System.Windows.Forms.SystemInformation]::VirtualScreen';
    const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DPIAware { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@;
[DPIAware]::SetProcessDPIAware() | Out-Null;
$b = ${region};
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size);
$bmp.Save('${outEsc}', [System.Drawing.Imaging.ImageFormat]::Png);
Write-Output ("$($b.Width)x$($b.Height)");
`;
    const dims = (await ps(script, 40000)).trim();
    let buf = fs.readFileSync(out);
    try { fs.unlinkSync(out); } catch {}

    // Keep the payload sane for WhatsApp: re-encode very large desktops.
    let mime = 'image/png';
    if (buf.length > 3 * 1024 * 1024) {
      const jpg = out.replace(/\.png$/, '.jpg');
      fs.writeFileSync(out, buf);
      await ps(`Add-Type -AssemblyName System.Drawing;
$i=[System.Drawing.Image]::FromFile('${outEsc}');
$c=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {$_.MimeType -eq 'image/jpeg'};
$p=New-Object System.Drawing.Imaging.EncoderParameters 1;
$p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, 85);
$i.Save('${jpg.replace(/\\/g, '\\\\')}', $c, $p); $i.Dispose();`, 30000).catch(() => {});
      if (fs.existsSync(jpg)) { buf = fs.readFileSync(jpg); mime = 'image/jpeg'; try { fs.unlinkSync(jpg); } catch {} }
      try { fs.unlinkSync(out); } catch {}
    }
    return { image: buf.toString('base64'), mime, dims, sizeKB: Math.round(buf.length / 1024) };
  },

  async open_url({ url }) {
    if (!/^https?:\/\//i.test(url || '')) throw new Error('invalid url');
    await new Promise((res, rej) =>
      execFile('cmd', ['/c', 'start', '', url], { timeout: 10000 }, e => e ? rej(e) : res()));
    return { opened: url };
  },

  async notify({ title, message }) {
    const esc = s => String(s || '').replace(/'/g, "''");
    ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$n=New-Object System.Windows.Forms.NotifyIcon;
$n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true;
$n.ShowBalloonTip(8000,'${esc(title || 'Boti')}','${esc(message)}',[System.Windows.Forms.ToolTipIcon]::Info);
Start-Sleep -Seconds 9;`, 15000).catch(() => {});
    return { shown: true };
  },

  // Deliberately not implemented — the server also refuses it while
  // publishing is disabled. This is where browser automation will go.
  async publish() {
    throw new Error('publishing is not enabled in the agent yet');
  },
};

socket.on('agent:action', async ({ requestId, action, params }) => {
  const fn = handlers[action];
  if (!fn) return socket.emit('agent:result', { requestId, ok: false, error: 'unsupported action' });
  console.log(`[>] ${action}`, params && Object.keys(params).length ? JSON.stringify(params) : '');
  try {
    const data = await fn(params || {});
    socket.emit('agent:result', { requestId, ok: true, data });
    console.log(`[OK] ${action} done`);
  } catch (e) {
    socket.emit('agent:result', { requestId, ok: false, error: (e.message || '').substring(0, 200) });
    console.log(`[X] ${action} failed: ${(e.message || '').substring(0, 120)}`);
  }
});
