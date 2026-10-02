'use strict';
/**
 * טלפון → מחשב, ותדריך הבוקר.
 *
 * The phone (or WhatsApp "ג׳רביס …") drops a task here; the PC JARVIS polls,
 * claims it, works on it with its full brain, posts progress, and asks here
 * when it needs a yes/no — so the answer can come from the phone. Polling,
 * not a socket: same reasoning as the rest of /api/jarvis — every step can be
 * exercised with curl, and a PC that sleeps simply picks up where it left off.
 *
 *   POST /api/jarvis/pc/tasks             phone/WhatsApp → queue a task
 *   GET  /api/jarvis/pc/tasks             phone: recent tasks and their state
 *   GET  /api/jarvis/pc/tasks/next        PC: claim the oldest queued task
 *   POST /api/jarvis/pc/tasks/:id         PC: progress / waiting(question) / done / failed
 *   POST /api/jarvis/pc/tasks/:id/answer  phone: yes / no to a waiting question
 *   GET  /api/jarvis/pc/tasks/:id         PC: poll for that answer
 *   GET  /api/jarvis/pc/status            is the PC on (polled in the last 90s)
 *   POST /api/jarvis/pc/board             PC → its life board, so the phone sees it
 *   GET  /api/jarvis/pc/board             phone: the board
 *   GET  /api/jarvis/morning              the morning call's text — templated, no model
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA = path.join(__dirname, '..', 'data');
const TASKS_FILE = path.join(DATA, 'pc-tasks.json');
const BOARD_FILE = path.join(DATA, 'pc-board.json');
const KEEP = 60;

let _tasks = null;
let _pcSeen = 0;
let _hud = { dev: [], jobs: [], settings: null, whatsNew: null, updated: 0 };
const _hudEvents = [];
let _hudSeq = 0;
const doneHandlers = [];

const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const save = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v, null, 2)); } catch (e) { logger.warn('pc-tasks save: ' + e.message); } };
function tasks() { if (!_tasks) _tasks = load(TASKS_FILE, []); return _tasks; }
function persist() { _tasks = tasks().slice(-KEEP); save(TASKS_FILE, _tasks); }
const pushAlert = (a) => { try { require('./jarvis-api').pushAlert(a); } catch (_) {} };

function enqueue(text, from = 'phone') {
  const t = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    text: String(text).trim().substring(0, 4000), from,
    status: 'queued', progress: '', result: '', question: '', answer: '',
    created: Date.now(), updated: Date.now(),
  };
  tasks().push(t);
  persist();
  logger.info(`🖥️ PC task queued from ${from}: ${t.text.substring(0, 60)}`);
  return t;
}

function onDone(cb) { if (typeof cb === 'function') doneHandlers.push(cb); }
function pcOnline() { return Date.now() - _pcSeen < 90 * 1000; }

function update(id, patch) {
  const t = tasks().find(x => x.id === id);
  if (!t) return null;
  const before = t.status;
  for (const k of ['status', 'progress', 'result', 'question']) if (patch[k] !== undefined) t[k] = String(patch[k]).substring(0, 8000);
  if (patch.status === 'waiting') t.answer = '';
  // The server brain hands a task back for the PC (needs files, browser, video…).
  if (patch.pcOnly) t.pcOnly = true;
  t.updated = Date.now();
  persist();
  if (t.status === 'waiting' && before !== 'waiting') {
    pushAlert({ title: '🖥️ המחשב מחכה לאישור שלך', summary: t.question.substring(0, 120), body: `${t.question}\n\nהמשימה: ${t.text}`, kind: 'pc-task', urgency: 'high', link: `pctask:${t.id}` });
  }
  if ((t.status === 'done' || t.status === 'failed') && before !== t.status) {
    pushAlert({ title: t.status === 'done' ? '🖥️ המחשב סיים' : '🖥️ המשימה נכשלה', summary: t.text.substring(0, 80), body: (t.result || '').replace(/[*_]/g, '').substring(0, 1500), kind: 'pc-task', link: `pctask:${t.id}` });
    for (const cb of doneHandlers) { try { cb(t); } catch (_) {} }
  }
  return t;
}

// ── 🌅 morning brief — a template over data the bot already has; no tokens ──
async function morning() {
  const tz = 'Asia/Jerusalem';
  const now = new Date();
  const day = now.toLocaleDateString('he-IL', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
  const parts = [`בוקר טוב מושיקו. היום ${day}.`];
  const sec = require('./jarvis-secretary');

  try {
    const evs = (await sec.events(1)).filter(e => {
      const d = new Date(e.start);
      return d.toLocaleDateString('en-CA', { timeZone: tz }) === now.toLocaleDateString('en-CA', { timeZone: tz });
    });
    if (!evs.length) parts.push('היומן היום פנוי.');
    else parts.push(`ביומן ${evs.length === 1 ? 'אירוע אחד' : evs.length + ' אירועים'}: ` + evs.slice(0, 4).map(e =>
      (e.allDay ? '' : new Date(e.start).toLocaleTimeString('he-IL', { timeZone: tz, hour: '2-digit', minute: '2-digit' }) + ' ') + e.summary).join(', ') + '.');
  } catch (e) { parts.push('את היומן לא הצלחתי לקרוא.'); }

  try {
    const mails = (await sec.inbox({ q: 'is:unread in:inbox newer_than:1d', max: 25 })).filter(m => !m.noise);
    if (!mails.length) parts.push('אין מיילים חשובים חדשים.');
    else {
      const who = [...new Set(mails.map(m => m.from))].slice(0, 3).map(n => (/^[֐-׿]/.test(n) ? 'מ' : 'מ-') + n).join(', ');
      parts.push(`${mails.length === 1 ? 'מייל חשוב אחד' : mails.length + ' מיילים חשובים'} מחכים לך, בין השאר ${who}.`);
    }
  } catch (e) { /* the call goes on without mail */ }

  const night = tasks().filter(t => t.status === 'done' && t.updated > Date.now() - 10 * 3600 * 1000);
  if (night.length) parts.push(`בלילה המחשב סיים ${night.length === 1 ? 'משימה' : night.length + ' משימות'}: ${night.slice(0, 2).map(t => t.text.substring(0, 50)).join('; ')}.`);

  const board = load(BOARD_FILE, { items: [] }).items || [];
  const waiting = board.filter(i => i.status === 'waiting' || (i.owner === 'moshiko' && i.status !== 'done'));
  const dueToday = board.filter(i => i.status !== 'done' && i.due && i.due <= now.toLocaleDateString('en-CA', { timeZone: tz }));
  if (waiting.length) parts.push(`${waiting.length === 1 ? 'דבר אחד מחכה' : waiting.length + ' דברים מחכים'} לך בלוח: ${waiting.slice(0, 2).map(i => i.title).join(', ')}.`);
  if (dueToday.length) parts.push(`להיום או באיחור: ${dueToday.slice(0, 2).map(i => i.title).join(', ')}.`);

  parts.push('יום טוב.');
  return { text: parts.join(' '), generated: Date.now() };
}

function attach(app, guard) {
  // Two workers can serve the queue: the PC ('pc') and, when the PC is off,
  // the server brain ('cloud', 2.10). Only the PC counts as "the PC is on".
  const source = (req) => req.get('x-jarvis-source') || '';
  const fromPc = (req) => source(req) === 'pc';
  const pcOnly = (req, res, next) => {
    const s = source(req);
    if (s !== 'pc' && s !== 'cloud') return res.status(403).json({ error: 'pc only' });
    if (s === 'pc') _pcSeen = Date.now();
    next();
  };
  const pub = (t) => t && ({ id: t.id, text: t.text, from: t.from, status: t.status, progress: t.progress, result: t.result, question: t.question, answer: t.answer, worker: t.worker || null, pcOnly: !!t.pcOnly, created: t.created, updated: t.updated });

  app.post('/api/jarvis/pc/tasks', guard, (req, res) => {
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: 'אין טקסט' });
    res.json({ ok: true, task: pub(enqueue(text, (req.body || {}).from === 'whatsapp' ? 'whatsapp' : 'phone')), pcOnline: pcOnline() });
  });
  app.get('/api/jarvis/pc/tasks', guard, (_req, res) => res.json({ ok: true, pcOnline: pcOnline(), tasks: tasks().slice(-30).reverse().map(pub) }));
  app.get('/api/jarvis/pc/status', guard, (_req, res) => res.json({ ok: true, online: pcOnline(), lastSeen: _pcSeen }));

  app.get('/api/jarvis/pc/tasks/next', guard, pcOnly, (req, res) => {
    const cloud = source(req) === 'cloud';
    // The server brain only takes over when the PC is off (or a task has
    // waited 90s unclaimed), and never takes back what it handed to the PC.
    const t = tasks().find(x => x.status === 'queued' &&
      (!cloud || (!x.pcOnly && (!pcOnline() || Date.now() - x.created > 90 * 1000))));
    if (!t) return res.json({ ok: true, task: null });
    t.status = 'running'; t.worker = cloud ? 'cloud' : 'pc'; t.updated = Date.now(); persist();
    res.json({ ok: true, task: pub(t) });
  });
  app.get('/api/jarvis/pc/tasks/:id', guard, (req, res) => {
    if (fromPc(req)) _pcSeen = Date.now();
    const t = tasks().find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'אין משימה כזו' });
    res.json({ ok: true, task: pub(t) });
  });
  app.post('/api/jarvis/pc/tasks/:id', guard, pcOnly, (req, res) => {
    const t = update(req.params.id, req.body || {});
    if (!t) return res.status(404).json({ error: 'אין משימה כזו' });
    res.json({ ok: true, task: pub(t) });
  });
  app.post('/api/jarvis/pc/tasks/:id/answer', guard, (req, res) => {
    const t = tasks().find(x => x.id === req.params.id);
    if (!t || t.status !== 'waiting') return res.status(409).json({ error: 'המשימה לא מחכה לתשובה' });
    const a = String((req.body || {}).answer || '');
    t.answer = a === 'yes' || a === 'always' ? a : 'no';
    t.updated = Date.now(); persist();
    res.json({ ok: true, task: pub(t) });
  });

  app.post('/api/jarvis/pc/board', guard, pcOnly, (req, res) => {
    const items = Array.isArray((req.body || {}).items) ? req.body.items.slice(0, 300) : [];
    save(BOARD_FILE, { items, updated: Date.now() });
    res.json({ ok: true, count: items.length });
  });
  app.get('/api/jarvis/pc/board', guard, (_req, res) => res.json({ ok: true, ...load(BOARD_FILE, { items: [], updated: 0 }) }));

  // ── HUD mirror (2.10): what the PC screen shows, for the phone's copy of it ──
  // The PC posts a snapshot (progress bars, running jobs, its status rows,
  // "what's new") plus a stream of events (panels, activity lines, reply
  // text as it's written). The phone polls with ?since=<seq>. One channel, so
  // anything new on the PC screen reaches the phone without building it twice.
  app.post('/api/jarvis/pc/hud', guard, pcOnly, (req, res) => {
    const b = req.body || {};
    for (const k of ['dev', 'jobs', 'settings', 'whatsNew']) if (b[k] !== undefined) _hud[k] = b[k];
    _hud.updated = Date.now();
    for (const e of (Array.isArray(b.events) ? b.events : []).slice(0, 200)) {
      _hudEvents.push({ seq: ++_hudSeq, ts: Date.now(), type: String(e.type || '').substring(0, 20), data: e.data || {} });
    }
    if (_hudEvents.length > 400) _hudEvents.splice(0, _hudEvents.length - 400);
    res.json({ ok: true, seq: _hudSeq });
  });
  app.get('/api/jarvis/pc/hud', guard, (req, res) => {
    const since = parseInt(req.query.since, 10);
    // First call (no since): just the snapshot and the current seq — old events are history, not news.
    const events = Number.isFinite(since) ? _hudEvents.filter(e => e.seq > since) : [];
    res.json({ ok: true, pcOnline: pcOnline(), seq: _hudSeq, ..._hud, events });
  });

  app.get('/api/jarvis/morning', guard, async (_req, res) => {
    try { res.json({ ok: true, ...(await morning()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}

module.exports = { attach, enqueue, update, onDone, pcOnline, morning, tasks };
