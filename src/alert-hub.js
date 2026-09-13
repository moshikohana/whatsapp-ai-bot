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
function getLastDigestAt() { return lastDigestAt; }
function dueForDigest() {
  if (inQuietHours()) return false;
  return (Date.now() - lastDigestAt) >= DIGEST_MINUTES * 60 * 1000;
}

const MAX_DIGEST_ITEMS = 8;
const MAX_POOL_CHARS = 5000;
const EXTRACT_TIMEOUT_MS = 45000;

// Only messages that could plausibly matter to a Likud MK's spokesperson.
// Pre-filtering keeps the prompt small (fast + cheap) and keeps the digest
// focused on his job instead of duplicating סריקה's general news picture.
const REL_RE = /קלנר|ליכוד|נתניהו|קואליצי|אופוזיצי|כנסת|בחירות|פריימריז|שמאל|ימין|בג"?ץ|בגצ|חקיקה|הצעת חוק|ועדת|מפלג|גולן|לפיד|בנט|ליברמן|איזנקוט|עבאס|סמוטריץ|בן ?גביר|ש"ס|יהדות התורה|דגל התורה|צה"?ל|מילואים|גיוס|חמאס|חיזבאללה|התנחל|ריבונות|שב"?כ|היועמ"?ש/;

// מוקד = "what needs YOU" (the owner picked this over a general news recap:
// סריקה already does the broad picture). Returns spokesperson-actionable
// items only: response openings, attacks to answer, rival messaging.
async function _extractActionable(pool) {
  if (!pool || pool.length < 3) return [];
  const relevant = pool.filter(m => REL_RE.test(m.body || ''));
  if (relevant.length < 3) return [];

  let corpus = '';
  for (const m of relevant.slice(-120)) {
    const line = `[${m.group}] ${(m.body || '').replace(/\s+/g, ' ').substring(0, 170)}\n`;
    if (corpus.length + line.length > MAX_POOL_CHARS) break;
    corpus += line;
  }
  if (!corpus.trim()) return [];

  try {
    const call = require('./claude').classifyJSON(corpus, {
      system: 'אתה יועץ תקשורת של ח"כ אריאל קלנר (הליכוד). קבל הודעות מקבוצות פוליטיות והחזר JSON בלבד: ' +
        '{"items":[{"type":"opportunity|attack|rival","title":"כותרת קצרה","why":"למה זה נוגע לקלנר - משפט","action":"מה לעשות - משפט קצר","urgency":1-5}]}. ' +
        'עד 5 פריטים, רק מה שבאמת דורש את קלנר: הזדמנות להגיב/להוביל, ביקורת שצריך לענות עליה, או מסר של יריבים שצובר תאוצה. ' +
        'אל תכלול חדשות כלליות שלא נוגעות לו. אם אין כלום רלוונטי — החזר {"items":[]}. ' +
        'כתוב בעברית פשוטה ויומיומית, בלי מילים של יועצים (לא "נרטיב", "ריטורי", "סוגיה", "מסר מצטבר תאוצה"). ' +
        'title: מה קרה, עד 8 מילים. why: למה זה נוגע לו, משפט קצר. action: צעד אחד ברור, למשל "לצייץ תגובה" או "להגיב בוועדה".',
      maxTokens: 800,
    });
    // Hard timeout — a stalled LLM call used to hang the whole digest silently.
    const j = await Promise.race([
      call,
      new Promise(res => setTimeout(() => res(null), EXTRACT_TIMEOUT_MS)),
    ]);
    const items = (j && Array.isArray(j.items)) ? j.items : [];
    return items.filter(i => i && i.title)
      .sort((a, b) => (b.urgency || 0) - (a.urgency || 0)).slice(0, 5);
  } catch { return []; }
}

// ── Build the digest ─────────────────────────────────────────────
// { text, actions } or null. `pool` = recent group messages from index.js.
async function buildDigest(pool) {
  const items = pending.slice();
  const clusters = _cluster(items);
  const focus = await _extractActionable(pool);
  if (!clusters.length && !focus.length) return null;

  const hhmm = ts => {
    try { return new Date(ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  };
  const sinceTxt = lastDigestAt ? `מאז ${hhmm(lastDigestAt)}` : 'מהתקופה האחרונה';
  const total = focus.length + Math.min(clusters.length, Math.max(0, MAX_DIGEST_ITEMS - focus.length));
  let out = `🎯 *מוקד* · ${hhmm(Date.now())}\n${total === 1 ? 'דבר אחד' : total + ' דברים'} שכדאי לדעת, ${sinceTxt}\n${'━'.repeat(14)}`;

  // In words, not a code to learn: what kind of thing it is.
  const ICON = { opportunity: '🟢 הזדמנות להגיב', attack: '🔴 ביקורת שכדאי לענות עליה', rival: '🟠 מסר של יריבים' };
  const actions = [];
  let n = 0;

  focus.forEach(f => {
    n++;
    actions.push({ n, topic: _snip(`${f.title} — ${f.why || ''}`, 90), keyword: f.title, msgIds: [] });
    const tag = ICON[f.type] || '⚪ לתשומת לב';
    out += `\n\n*${n}. ${_snip(f.title, 70)}*\n${tag}${(f.urgency || 0) >= 4 ? ' · דחוף' : ''}`;
    if (f.why) out += `\nלמה זה חשוב: ${_snip(f.why, 120)}`;
    if (f.action) out += `\nמה אפשר לעשות: ${_snip(f.action, 100)}`;
  });

  const shown = clusters.slice(0, MAX_DIGEST_ITEMS - n);
  if (shown.length) {
    out += `\n\n🔑 *הוזכרו מילות המעקב שלך*`;
    shown.forEach(c => {
      n++;
      const where = c.groups.length > 1 ? `${c.groups.length} קבוצות` : _snip(c.groups[0] || c.rep.group || '', 22);
      actions.push({
        n,
        topic: _snip(c.rep.preview || c.rep.keyword || '', 80),
        keyword: c.rep.keyword,
        msgIds: c.items.map(it => ({ msgId: it.msgId, chatId: it.chatId })).filter(x => x.msgId).slice(0, 3),
      });
      out += `\n\n*${n}. "${c.rep.keyword}"* — ${where}, ${hhmm(c.rep.ts)}\n${_snip(c.rep.preview, 120)}`;
    });
  }

  out += `\n${'━'.repeat(14)}\n↩️ כתוב מספר ומה לעשות, למשל *1 תגובה*\n• *תגובה* — טיוטה מוכנה בשבילך\n• *הצג* — ההודעות המקוריות\n• *הפצה* — להעביר לקבוצות\n• *שקט* — לא להביא את הנושא הזה שוב`;

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
  muteTopic, isMuted, inQuietHours, DIGEST_MINUTES, getLastActions, getLastDigestAt,
};
