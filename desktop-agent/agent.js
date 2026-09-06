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

// ── Claude bridge ────────────────────────────────────────────────
// The whole point of this agent is that the owner can keep improving the bot
// from his phone. A prompt sent in WhatsApp lands as a file in inbox/, the
// Claude Code session already open on this PC picks it up and continues the
// SAME conversation (full context, no cold start), and drops its answer in
// outbox/ — which we watch here and push back to WhatsApp.
const BRIDGE = fileCfg.bridgeDir || path.join(__dirname, '..', '.claude-bridge');
const INBOX = path.join(BRIDGE, 'inbox');
const OUTBOX = path.join(BRIDGE, 'outbox');
for (const d of [BRIDGE, INBOX, OUTBOX]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
console.log('[..] Claude bridge: ' + BRIDGE);

// Polled rather than fs.watch: on Windows the watch event fires before the
// file is fully written, which truncates replies.
setInterval(() => {
  let names = [];
  try { names = fs.readdirSync(OUTBOX).filter(n => n.endsWith('.txt')); } catch { return; }
  for (const n of names) {
    const f = path.join(OUTBOX, n);
    let body = '';
    try {
      if (Date.now() - fs.statSync(f).mtimeMs < 1200) continue;   // still being written
      body = fs.readFileSync(f, 'utf8');
    } catch { continue; }
    if (!body.trim()) continue;
    try { fs.unlinkSync(f); } catch {}
    console.log(`[<] reply ${n} (${body.length} chars)`);
    socket.emit('agent:push', { kind: 'claude', id: n.replace(/\.txt$/, ''), text: body });
  }
}, 2000);
socket.on('connect_error', (e) => console.log('[!] Connection error:', e.message));

// Run a PowerShell snippet and resolve when it exits.
function ps(script, timeout = 30000) {
  // Force UTF-8 on stdout, otherwise Hebrew comes back as "?????".
  const wrapped = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + script;
  return new Promise((res, rej) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
      { timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (e, so, se) => e ? rej(new Error(se || e.message)) : res(so));
  });
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

  // Hands a prompt to the Claude Code session running on this PC. It does NOT
  // execute anything itself — it writes a file and returns. Everything that
  // happens next is a human-supervised Claude session, which is precisely why
  // this belongs in the whitelist and isn't a shell escape.
  async claude_ask({ prompt, id }) {
    const text = String(prompt || '').trim();
    if (!text) throw new Error('empty prompt');
    const reqId = String(id || Date.now().toString(36));
    fs.writeFileSync(path.join(INBOX, `${reqId}.json`),
      JSON.stringify({ id: reqId, prompt: text, ts: Date.now() }, null, 2), 'utf8');
    let waiting = 0;
    try { waiting = fs.readdirSync(INBOX).filter(n => n.endsWith('.json')).length; } catch {}
    return { queued: true, id: reqId, waiting };
  },

  // What is still unanswered, so he isn't left guessing whether it arrived.
  async claude_queue() {
    let items = [];
    try {
      items = fs.readdirSync(INBOX).filter(n => n.endsWith('.json')).map(n => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(INBOX, n), 'utf8'));
          return { id: j.id, prompt: String(j.prompt || '').substring(0, 80), ts: j.ts };
        } catch { return null; }
      }).filter(Boolean).sort((a, b) => a.ts - b.ts);
    } catch {}
    return { items };
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

  async clip_set({ text }) {
    if (!text) throw new Error('no text');
    const f = path.join(os.tmpdir(), `clip-${Date.now()}.txt`);
    fs.writeFileSync(f, String(text), 'utf8');
    await ps(`Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 '${f}')`, 15000);
    try { fs.unlinkSync(f); } catch {}
    return { copied: String(text).length };
  },

  async clip_get() {
    const out = await ps('Get-Clipboard -Raw', 15000);
    return { text: (out || '').toString().trim().substring(0, 3000) };
  },

  async lock() {
    execFile('rundll32.exe', ['user32.dll,LockWorkStation'], () => {});
    return { locked: true };
  },

  async windows() {
    const out = await ps(`Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | ` +
      `Select-Object -First 15 ProcessName,MainWindowTitle | ConvertTo-Json -Compress`, 20000);
    let list = [];
    try { const j = JSON.parse(out); list = Array.isArray(j) ? j : [j]; } catch {}
    return { windows: list.map(w => ({ app: w.ProcessName, title: String(w.MainWindowTitle || '').substring(0, 70) })) };
  },

  async downloads() {
    const dir = path.join(os.homedir(), 'Downloads');
    let files = [];
    try {
      files = fs.readdirSync(dir)
        .map(n => { try { const s = fs.statSync(path.join(dir, n)); return { name: n, mtime: s.mtimeMs, kb: Math.round(s.size / 1024) }; } catch { return null; } })
        .filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 10);
    } catch {}
    return { files };
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
