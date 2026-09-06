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

// ── File lookup ──────────────────────────────────────────────────
// He will ask for "נייר עמדה", not "נייר-עמדה-סופי-v3.docx". Substring match
// over a few known roots, newest first, is what actually fits how he speaks.
const MAX_FILE_BYTES = 32 * 1024 * 1024;   // WhatsApp rejects far bigger anyway
const FILE_ROOTS = [
  { dir: path.join(os.homedir(), 'Downloads'), label: 'הורדות' },
  { dir: path.join(os.homedir(), 'Desktop'), label: 'שולחן העבודה' },
  { dir: path.join(os.homedir(), 'Documents'), label: 'מסמכים' },
  { dir: path.join(__dirname, '..'), label: 'תיקיית הבוט' },
];
const SKIP_DIRS = new Set(['node_modules', '.git', '.wwebjs_auth', '.wwebjs_cache', 'AppData']);

function _mimeOf(name) {
  const e = path.extname(name).toLowerCase();
  return ({
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.md': 'text/markdown',
    '.zip': 'application/zip',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  })[e] || 'application/octet-stream';
}

// Real filenames are "מושיק_אוחנה_קורות_חיים.pdf" and he asks for
// "קורות חיים". A plain substring test fails on that, purely because of the
// separators — which is exactly how the first live attempt came back empty
// on a file that was sitting right there in Downloads. So: flatten
// _ - . , ( ) to spaces on BOTH sides, then match word by word in any order.
function _norm(s) {
  return String(s).toLowerCase()
    .replace(/[_\-.,()\[\]{}'"`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _lev(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Scored rather than filtered: a weak match still beats "לא נמצא", and the
// ranking is what decides. Returns [] only when nothing resembles the query.
function _scoreName(base, qNorm, qTokens) {
  const nb = _norm(base);
  const stem = _norm(path.basename(base, path.extname(base)));
  if (stem === qNorm) return 1000;               // exact name
  if (nb.includes(qNorm)) return 800;            // the whole phrase appears
  if (!qTokens.length) return 0;

  const words = nb.split(' ').filter(Boolean);
  let hit = 0, fuzzy = 0;
  for (const t of qTokens) {
    if (words.some(w => w === t)) { hit++; continue; }
    if (words.some(w => w.startsWith(t) || t.startsWith(w))) { hit++; continue; }
    if (nb.includes(t)) { hit++; continue; }
    // A typo or a different inflection shouldn't cost him the file.
    if (words.some(w => w.length > 3 && _lev(w, t) <= (t.length > 6 ? 2 : 1))) { fuzzy++; }
  }
  if (!hit && !fuzzy) return 0;
  const covered = (hit + fuzzy * 0.5) / qTokens.length;
  if (covered < 0.5) return 0;                   // barely related — drop it
  return Math.round(covered * 500) + hit * 10;
}

// Two levels deep: enough for Desktop/<project>/file, not so much that every
// request walks the whole profile.
function _searchFiles(q, maxDepth = 2) {
  const qNorm = _norm(q);
  const qTokens = qNorm.split(' ').filter(Boolean);
  const out = [];
  const walk = (dir, label, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) walk(full, label, depth + 1); continue; }
      const score = _scoreName(e.name, qNorm, qTokens);
      if (!score) continue;
      try { const st = fs.statSync(full); out.push({ full, base: e.name, size: st.size, mtime: st.mtimeMs, where: label, score }); } catch {}
    }
  };
  for (const r of FILE_ROOTS) walk(r.dir, r.label, 0);
  return out.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
}

// Newest files across the roots — the fallback when a search finds nothing,
// so he gets something to pick from instead of a flat "not found".
function _recentFiles(n = 6) {
  const all = [];
  for (const r of FILE_ROOTS.slice(0, 3)) {          // his folders, not the repo
    let entries = [];
    try { entries = fs.readdirSync(r.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      try { const st = fs.statSync(path.join(r.dir, e.name)); all.push({ name: e.name, kb: Math.round(st.size / 1024), where: r.label, mtime: st.mtimeMs }); } catch {}
    }
  }
  return all.sort((a, b) => b.mtime - a.mtime).slice(0, n);
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
  async claude_ask({ prompt, id, image, imageMime }) {
    const text = String(prompt || '').trim();
    if (!text && !image) throw new Error('empty prompt');
    const reqId = String(id || Date.now().toString(36));

    // A screenshot of the problem is how he actually reports bugs, so the
    // bridge carries images too: the file is written next to the prompt and
    // the JSON points at it, which is all a Claude session needs to read it.
    let imagePath = null;
    if (image) {
      const ext = String(imageMime || '').includes('png') ? '.png' : '.jpg';
      imagePath = path.join(INBOX, `${reqId}${ext}`);
      fs.writeFileSync(imagePath, Buffer.from(String(image), 'base64'));
    }
    fs.writeFileSync(path.join(INBOX, `${reqId}.json`),
      JSON.stringify({ id: reqId, prompt: text, image: imagePath, ts: Date.now() }, null, 2), 'utf8');
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

  // ── File transfer ──────────────────────────────────────────────
  // Scoped to a few named roots on purpose. The agent runs as the user, so
  // "read any path the bot asks for" would turn a WhatsApp message into
  // read access to the whole disk.
  async send_file({ name, index }) {
    const q = String(name || '').trim().toLowerCase();
    if (!q) throw new Error('no file name');
    const hits = _searchFiles(q);
    // A dead end is the thing to avoid: show what is actually there instead
    // of only saying no.
    if (!hits.length) return { notFound: true, query: String(name).trim(), recent: _recentFiles(6) };

    // Only ask when it is genuinely a toss-up. If the best match clearly
    // beats the runner-up, sending it beats making him answer a question.
    const clearWinner = hits.length === 1 || hits[0].score >= 800 || hits[0].score - hits[1].score >= 150;
    if (!clearWinner && !index) {
      return { ambiguous: true, matches: hits.slice(0, 8).map(h => ({ name: h.base, kb: Math.round(h.size / 1024), where: h.where })) };
    }
    const pick = hits[Math.max(0, (parseInt(index, 10) || 1) - 1)] || hits[0];
    if (pick.size > MAX_FILE_BYTES) {
      throw new Error(`file is ${Math.round(pick.size / 1048576)}MB — over the ${Math.round(MAX_FILE_BYTES / 1048576)}MB limit`);
    }
    const buf = fs.readFileSync(pick.full);
    return { name: pick.base, mime: _mimeOf(pick.base), sizeKB: Math.round(pick.size / 1024), data: buf.toString('base64') };
  },

  // Incoming: always lands in Downloads, never a caller-chosen path.
  async save_file({ name, data }) {
    if (!data) throw new Error('no data');
    const safe = path.basename(String(name || 'file')).replace(/[<>:"|?*\x00-\x1f]/g, '_') || 'file';
    const buf = Buffer.from(String(data), 'base64');
    if (buf.length > MAX_FILE_BYTES) throw new Error('file too large');
    const dir = path.join(os.homedir(), 'Downloads');
    let out = path.join(dir, safe);
    if (fs.existsSync(out)) {                       // never clobber
      const ext = path.extname(safe), stem = path.basename(safe, ext);
      out = path.join(dir, `${stem}-${Date.now().toString(36)}${ext}`);
    }
    fs.writeFileSync(out, buf);
    return { saved: path.basename(out), dir, kb: Math.round(buf.length / 1024) };
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
