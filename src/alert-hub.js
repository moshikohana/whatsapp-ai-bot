'use strict';
/**
 * מוקד (Alert Hub) — replaces the keyword-alert firehose.
 *
 * Measured problem (2026-09-05): the bot sent the owner 30-76 messages/day,
 * 165 keyword alerts over 5 days (~33/day), while he replied 0-5 times. Classic
 * alert fatigue — he stopped reading.
 *
 * This module:
 *   • sends IMMEDIATELY only what is genuinely about Kellner (must-see),
 *   • queues everything else and delivers ONE ranked digest every DIGEST_MINUTES,
 *   • merges the same story reported across many groups into one item,
 *   • holds digests during quiet hours / Shabbat and delivers after,
 *   • attaches numbered one-tap actions so the owner never types a command.
 */
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'alert-hub.json');
const DIGEST_MINUTES = 90;   // how often a digest may go out
const MAX_PENDING = 400;
const CLUSTER_OVERLAP = 4;   // shared significant words → same story

let pending = [];            // queued non-urgent alerts
let muted = {};              // { normalizedTopicKey: expiryTs }
let lastDigestAt = 0;
let lastActions = [];        // the numbered items from the last digest sent

function _load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    pending = s.pending || []; muted = s.muted || {}; lastDigestAt = s.lastDigestAt || 0;
    lastActions = s.lastActions || [];
  } catch { pending = []; muted = {}; lastDigestAt = 0; lastActions = []; }
}
function _save() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ pending, muted, lastDigestAt, lastActions })); } catch {}
}
_load();

const KELLNER_RE = /קלנר|אריאל\s*קלנר|ArielKallner/i;

const _norm = s => (s || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
const _words = s => _norm(s).split(' ').filter(w => w.length >= 3);
function _overlap(a, b) {
  const A = new Set(_words(a)); let n = 0;
  for (const w of new Set(_words(b))) if (A.has(w)) n++;
  return n;
}

// ── Mute ("התעלם מהנושא היום") ───────────────────────────────────
function muteTopic(key, hours = 12) {
  const k = _norm(key).split(' ').slice(0, 6).join(' ');
  if (!k) return false;
  muted[k] = Date.now() + hours * 3600 * 1000;
  _save();
  return true;
}
function isMuted(text) {
  const now = Date.now(); const t = _norm(text); let changed = false;
  for (const [k, exp] of Object.entries(muted)) {
    if (exp < now) { delete muted[k]; changed = true; continue; }
    if (k && _overlap(k, t) >= 3) { if (changed) _save(); return true; }
  }
  if (changed) _save();
  return false;
}

// ── Quiet hours / Shabbat ────────────────────────────────────────
// Digests are held (not dropped) and delivered once the window ends.
function inQuietHours(d = new Date()) {
  const il = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const h = il.getHours(), day = il.getDay(); // 5 = Fri, 6 = Sat
  if (h >= 23 || h < 7) return true;
  if (day === 5 && h >= 18) return true;  // Friday evening
  if (day === 6 && h < 20) return true;   // Shabbat until evening
  return false;
}

// ── Intake ───────────────────────────────────────────────────────
// Returns 'urgent' (caller should send now), 'queued', or 'muted'.
function queueAlert(a) {
  const blob = `${a.keyword || ''} ${a.preview || ''}`;
  if (isMuted(blob)) return 'muted';
  if (KELLNER_RE.test(blob)) return 'urgent';
  pending.push({
    keyword: a.keyword || '', group: a.group || '', sender: a.sender || '',
    preview: (a.preview || '').substring(0, 300), ts: Date.now(),
    msgId: a.msgId || '', chatId: a.chatId || '',
  });
  if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
  _save();
  return 'queued';
}

// ── Clustering: same story across groups → one item ──────────────
function _cluster(items) {
  const out = [];
  for (const it of items) {
    let placed = false;
    for (const c of out) {
      if (_overlap(c.rep.preview, it.preview) >= CLUSTER_OVERLAP) {
        c.items.push(it);
        if (it.group && !c.groups.includes(it.group)) c.groups.push(it.group);
        placed = true; break;
      }
    }
    if (!placed) out.push({ rep: it, items: [it], groups: it.group ? [it.group] : [] });
  }
  // Traction first: more groups, then more mentions, then newer.
  return out.sort((a, b) =>
    (b.groups.length - a.groups.length) ||
    (b.items.length - a.items.length) ||
    (b.rep.ts - a.rep.ts));
}

// Trim to a word boundary — cutting mid-word made the digest unreadable.
function _snip(str, max) {
  const t = (str || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim() + '…';
}

function pendingCount() { return pending.length; }
function dueForDigest() {
  if (!pending.length) return false;
  if (inQuietHours()) return false;
  return (Date.now() - lastDigestAt) >= DIGEST_MINUTES * 60 * 1000;
}

const MAX_DIGEST_ITEMS = 8;

// ── Build the digest ─────────────────────────────────────────────
// Returns null when there's nothing to send, else { text, actions }.
// EVERY item is numbered and the available actions are spelled out once, so
// the owner always knows what the message is asking of him. `actions` carries
// the source message ids so "<n> הצג" can pull the original back.
function buildDigest() {
  if (!pending.length) return null;
  const items = pending.slice();
  const clusters = _cluster(items);
  const shown = clusters.slice(0, MAX_DIGEST_ITEMS);

  const hhmm = ts => {
    try { return new Date(ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  };
  const now = hhmm(Date.now());
  let out = `📬 *מוקד* · ${now}\n_${items.length} עדכונים · ${clusters.length} נושאים_\n${'━'.repeat(18)}`;

  const actions = [];
  shown.forEach((c, i) => {
    const n = i + 1;
    const where = c.groups.length > 1 ? `📍 ${c.groups.length} קבוצות` : `📍 ${_snip(c.groups[0] || c.rep.group || '', 24)}`;
    const hot = c.groups.length >= 2 ? '🔥 ' : '';
    actions.push({
      n,
      topic: _snip(c.rep.preview || c.rep.keyword || '', 80),
      keyword: c.rep.keyword,
      msgIds: c.items.map(it => ({ msgId: it.msgId, chatId: it.chatId })).filter(x => x.msgId).slice(0, 3),
    });
    out += `\n\n*${n}.* ${hot}🔑 ${c.rep.keyword} · ${where} · 🕐 ${hhmm(c.rep.ts)}\n${_snip(c.rep.preview, 140)}`;
  });

  if (clusters.length > shown.length) out += `\n\n_+${clusters.length - shown.length} נושאים נוספים_`;

  out += `\n${'━'.repeat(18)}\n*מה לעשות?* ענה במספר + פעולה:\n` +
    `📄 *הצג* — שולח לך את ההודעה המקורית\n` +
    `✍️ *תגובה* — מנסח טיוטת תגובה\n` +
    `📤 *הפצה* — פותח הכנת הפצה\n` +
    `🔕 *שקט* — משתיק את הנושא ל-12 שעות\n\n` +
    `_לדוגמה:_ *1 הצג*`;

  return { text: out.trim(), actions };
}

// Called after a digest is actually delivered.
function markDigestSent(actions) {
  pending = [];
  lastDigestAt = Date.now();
  if (Array.isArray(actions)) lastActions = actions;
  _save();
}
function getLastActions() { return lastActions; }

module.exports = {
  queueAlert, buildDigest, markDigestSent, dueForDigest, pendingCount,
  muteTopic, isMuted, inQuietHours, DIGEST_MINUTES, getLastActions,
};
