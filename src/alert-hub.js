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

function _load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    pending = s.pending || []; muted = s.muted || {}; lastDigestAt = s.lastDigestAt || 0;
  } catch { pending = []; muted = {}; lastDigestAt = 0; }
}
function _save() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ pending, muted, lastDigestAt })); } catch {}
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
    preview: (a.preview || '').substring(0, 200), ts: Date.now(),
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

function pendingCount() { return pending.length; }
function dueForDigest() {
  if (!pending.length) return false;
  if (inQuietHours()) return false;
  return (Date.now() - lastDigestAt) >= DIGEST_MINUTES * 60 * 1000;
}

// ── Build the digest ─────────────────────────────────────────────
// Returns null when there's nothing to send, else { text, actions }.
// `actions` maps the numbers shown to the topic they act on.
function buildDigest() {
  if (!pending.length) return null;
  const items = pending.slice();
  const clusters = _cluster(items);

  // "Needs you" = a story with traction (seen in 2+ groups). Cap at 4.
  const hot = clusters.filter(c => c.groups.length >= 2).slice(0, 4);
  const rest = clusters.filter(c => !hot.includes(c));

  const now = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
  let out = `📬 *מוקד* · ${now}\n_${items.length} עדכונים · ${clusters.length} נושאים_`;

  const actions = [];
  if (hot.length) {
    out += `\n${'━'.repeat(20)}\n\n⚡ *דורש התייחסות (${hot.length})*`;
    hot.forEach((c, i) => {
      const n = i + 1;
      const topic = (c.rep.preview || c.rep.keyword || '').substring(0, 60);
      actions.push({ n, topic, keyword: c.rep.keyword });
      out += `\n\n*${n}.* 📍 ${c.groups.length} קבוצות · 🔑 ${c.rep.keyword}\n_"${(c.rep.preview || '').substring(0, 110)}"_`;
    });
    out += `\n\n_להגיב: שלח *${actions.map(a => a.n).join('/')}* ואז:_\n*<מספר> תגובה* · *<מספר> הפצה* · *<מספר> שקט*`;
  }

  if (rest.length) {
    out += `\n\n📰 *רקע (${rest.length})*\n`;
    out += rest.slice(0, 12).map(c => `• ${c.rep.keyword} — ${(c.rep.preview || '').substring(0, 55)}`).join('\n');
    if (rest.length > 12) out += `\n_+${rest.length - 12} נוספים_`;
  }

  return { text: out.trim(), actions };
}

// Called after a digest is actually delivered.
function markDigestSent() { pending = []; lastDigestAt = Date.now(); _save(); }

module.exports = {
  queueAlert, buildDigest, markDigestSent, dueForDigest, pendingCount,
  muteTopic, isMuted, inQuietHours, DIGEST_MINUTES,
};
