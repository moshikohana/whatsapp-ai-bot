'use strict';
/**
 * קורא לוגים — turns raw pm2 output into something a person can read.
 *
 * The logs already exist; the problem is that reading them means SSH, pm2,
 * grep, and knowing which of four files to look in. Tonight made the cost of
 * that obvious: the bot was down and the reason was sitting in a log nobody
 * could see without a terminal.
 *
 * So: classify every line into a handful of categories that mean something
 * ("a message arrived", "the browser died", "it restarted"), keep the
 * timestamp, and drop the noise — TensorFlow banners, dbus chatter, and the
 * QR ASCII art are 90% of the volume and 0% of the meaning.
 */
const fs = require('fs');
const path = require('path');

const PM2_DIR = '/root/.pm2/logs';
const GUARD_LOG = '/var/log/bot-memory-guard.log';

const INSTANCES = [
  { id: 'moshiko', label: 'הבוט של מושיקו', out: 'whatsapp-bot-out.log', err: 'whatsapp-bot-error.log', dir: '/opt/whatsapp-ai-bot' },
  { id: 'wife',    label: 'הבוט של אשתו',   out: 'wife-bot-out.log',      err: 'wife-bot-error.log',      dir: '/opt/wife-bot' },
];

// Lines that carry no information for a human reading "what happened".
const NOISE = [
  /tensorflow|oneDNN|cpu_feature_guard|compiler flags|TF-TRT/i,
  /dbus-daemon|dbus-run-session|org\.a11y|Activating service/i,
  /^[\s▄▀█░▒▓╔╚╠║╝╗═]+$/,
  /^\s*$/,
  /Fontconfig|Gtk-WARNING|libva error|GLib-GObject/i,
];

// Order matters — first match wins.
const RULES = [
  { kind: 'message_in',  icon: '📥', label: 'הודעה נכנסה',      re: /msg_create:\s*type=(\w+)\s+from=([^\s]+)/,
    detail: m => `${_typeHe(m[1])} מ־${_shortId(m[2])}` },
  { kind: 'reply_out',   icon: '📤', label: 'הבוט ענה',          re: /\bבוטי\b.*direction.*out|✅ נשלח|תשובה נשלחה/ },
  { kind: 'crash',       icon: '💥', label: 'קריסה',             re: /שגיאת אתחול|Execution context was destroyed|uncaughtException|FATAL/i,
    detail: m => (m.input || '').replace(/.*?(שגיאת אתחול|Protocol error)/, '$1').substring(0, 110) },
  { kind: 'logout',      icon: '🔌', label: 'נותק מוואטסאפ',     re: /נותק:\s*LOGOUT|disconnected:\s*LOGOUT|❌ נותק/i },
  { kind: 'qr',          icon: '📱', label: 'ממתין לסריקת QR',   re: /סרוק QR|QR RECEIVED/i },
  { kind: 'auth',        icon: '🔐', label: 'אומת בהצלחה',       re: /🔐 אומת|authenticated/i },
  { kind: 'ready',       icon: '✅', label: 'עלה ומוכן',          re: /מוכן לשימוש|Client is ready|Warm-up.*complete/i },
  { kind: 'agent',       icon: '🖥️', label: 'הסוכן במחשב',       re: /Desktop agent (connected|disconnected)/,
    detail: m => m[1] === 'connected' ? 'התחבר' : 'התנתק' },
  { kind: 'restart',     icon: '🔄', label: 'הופעל מחדש',        re: /Shutting down|🛑|Reconnect attempt/i },
  { kind: 'guest_block', icon: '🔒', label: 'פקודה חסומה לאורח', re: /guest blocked \[([^\]]+)\]:\s*(.*)/,
    detail: m => `${m[1]} — "${(m[2] || '').substring(0, 40)}"` },
  { kind: 'error',       icon: '⚠️', label: 'שגיאה',             re: /^.*(❌|ERROR|Error:|failed|נכשל)/i,
    detail: m => (m.input || '').substring(0, 110) },
];

const TYPE_HE = { chat: 'הודעת טקסט', image: 'תמונה', video: 'סרטון', document: 'קובץ', ptt: 'הודעה קולית', audio: 'אודיו', sticker: 'סטיקר', location: 'מיקום', notification_template: 'התראה', album: 'אלבום', revoked: 'הודעה שנמחקה' };
const _typeHe = t => TYPE_HE[t] || t;

// Group JIDs are meaningless numbers; say what kind of chat it was instead.
function _shortId(id) {
  if (!id) return '';
  if (id.includes('@g.us') || id.includes('@g')) return 'קבוצה';
  if (id.includes('status@broadcast')) return 'סטטוס';
  if (id.includes('@lid')) return 'צ׳אט אישי';
  if (id.includes('@newsle')) return 'ערוץ';
  const num = id.split('@')[0];
  return num.length > 6 ? `…${num.slice(-4)}` : num;
}

// pm2 writes "2026-09-06T20:28:23: message" when --time is on, and bare lines
// otherwise. Accept both so nothing is silently skipped.
const STAMP = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-][\d:]+)?):\s?/;
function _parseLine(line) {
  const m = line.match(STAMP);
  if (!m) return { ts: null, text: line };
  // The app stamps its own console output, and pm2 stamps again for any
  // process started with --time. Strip whatever is left so the second copy
  // doesn't show up inside the message text.
  const text = line.slice(m[0].length).replace(STAMP, '');
  return { ts: Date.parse(m[1]) || null, text };
}

function _tail(file, maxBytes = 400 * 1024) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n');
  } catch { return []; }
}

function _classify(text) {
  for (const r of RULES) {
    const m = text.match(r.re);
    if (!m) continue;
    m.input = text;
    return { kind: r.kind, icon: r.icon, label: r.label, detail: r.detail ? r.detail(m) : '' };
  }
  return null;
}

// The event stream for one instance, newest first.
function readInstance(inst, limit = 400) {
  const lines = [..._tail(path.join(PM2_DIR, inst.out)), ..._tail(path.join(PM2_DIR, inst.err), 120 * 1024)];
  const events = [];
  for (const raw of lines) {
    if (!raw || NOISE.some(re => re.test(raw))) continue;
    const { ts, text } = _parseLine(raw.replace(/^\d+\|[\w-]+\s*\|\s?/, ''));   // strip pm2's "4|whatsapp | "
    if (!text || NOISE.some(re => re.test(text))) continue;
    const c = _classify(text);
    if (!c) continue;
    events.push({ ts, ...c, raw: text.substring(0, 200) });
  }
  events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return events.slice(0, limit);
}

// Counts over a window, so "is it healthy" is answerable at a glance.
function summarize(events, sinceMs) {
  const since = Date.now() - sinceMs;
  // Events with no timestamp are excluded rather than assumed recent. pm2
  // only writes times when the process was started with --time, and the
  // owner's was not; counting those undated lines as "this hour" turned a
  // whole log file into a fake spike.
  const dated = events.filter(e => e.ts);
  const recent = dated.filter(e => e.ts >= since);
  const by = {};
  for (const e of recent) by[e.kind] = (by[e.kind] || 0) + 1;
  return {
    undated: events.length - dated.length,
    window_events: recent.length,
    messages: by.message_in || 0,
    crashes: by.crash || 0,
    errors: by.error || 0,
    restarts: by.restart || 0,
    logouts: by.logout || 0,
    blocked: by.guest_block || 0,
    last_event_ts: recent.length ? recent[0].ts : null,
  };
}

function readGuard(limit = 60) {
  return _tail(GUARD_LOG, 60 * 1024)
    .filter(Boolean)
    .slice(-limit)
    .map(l => {
      const m = l.match(/^([\d-]+ [\d:]+)\s+(ok|RESTART)\s+(.*)$/);
      if (!m) return null;
      return { time: m[1], level: m[2] === 'ok' ? 'ok' : 'restart', text: m[3] };
    })
    .filter(Boolean)
    .reverse();
}

function readDiagnostics(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'data', 'diagnostics.json'), 'utf8')).slice(-20).reverse(); }
  catch { return []; }
}

function snapshot() {
  const out = { generated: Date.now(), instances: [], guard: readGuard(), };
  for (const inst of INSTANCES) {
    const events = readInstance(inst);
    out.instances.push({
      id: inst.id,
      label: inst.label,
      running: fs.existsSync(path.join(PM2_DIR, inst.out)),
      hour: summarize(events, 60 * 60 * 1000),
      day: summarize(events, 24 * 60 * 60 * 1000),
      events: events.slice(0, 200),
      diagnostics: readDiagnostics(inst.dir),
    });
  }
  return out;
}

module.exports = { snapshot, readInstance, summarize, INSTANCES };
