'use strict';
/**
 * Listening layer — sentiment + narratives + share-of-voice for MK Ariel
 * Kellner. Turns raw scan/media "mentions" into intelligence:
 *   • sentiment toward Kellner (pro / anti / neutral)
 *   • dominant narratives (with stance + count + a sample)
 *   • share-of-voice: Kellner vs. configured rivals
 *   • daily snapshots → narrative trend detection (early warning)
 *
 * Pure module: callers (index.js) gather the text pool and provide it here.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TRENDS_FILE = path.join(DATA_DIR, 'sentiment-trends.json');
const RIVALS_FILE = path.join(DATA_DIR, 'rivals.json');
const MAX_SNAPSHOTS = 120; // ~4 months of daily snapshots

// ─── Rivals (for share-of-voice) ────────────────────────────────
function loadRivals() {
  try { const a = JSON.parse(fs.readFileSync(RIVALS_FILE, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function saveRivals(list) {
  try { fs.writeFileSync(RIVALS_FILE, JSON.stringify(list, null, 2)); } catch (e) { logger.warn?.('saveRivals: ' + e.message); }
}
function addRival(name) {
  name = (name || '').trim(); if (!name) return loadRivals();
  const list = loadRivals();
  if (!list.some(r => r === name)) list.push(name);
  saveRivals(list); return list;
}
function removeRival(name) {
  const list = loadRivals().filter(r => r !== (name || '').trim());
  saveRivals(list); return list;
}

// ─── Analysis (Claude classification) ───────────────────────────
async function analyzeMentions(poolText) {
  const { classifyJSON } = require('./claude');
  const rivals = loadRivals();
  const rivalLine = rivals.length ? rivals.join(', ') : '(אין יריבים מוגדרים)';
  const prompt =
`אתה אנליסט מדיה ותקשורת פוליטית. לפניך הודעות מהשיח הציבורי (קבוצות/ערוצים/חדשות). המטרה כפולה:
(א) תמונת השיח הפוליטי הכללי — הנרטיבים/נושאים הבולטים (*לאו דווקא על קלנר*).
(ב) מיקום ח"כ אריאל קלנר (הליכוד) בתוכו — אזכורים, סנטימנט, ו-share-of-voice.

החזר JSON בלבד, במבנה המדויק הזה:
{
  "kellner_mentions": <מספר ההודעות שמזכירות/עוסקות בקלנר; 0 אם אין>,
  "sentiment": { "pro": <n>, "anti": <n>, "neutral": <n> },
  "net_sentiment": "<positive|negative|mixed|neutral>",
  "narratives": [
    { "title": "<כותרת נרטיב קצרה בעברית>", "stance": "<pro|anti|neutral>", "count": <n>, "sample": "<ציטוט קצר>" }
  ],
  "share_of_voice": { "אריאל קלנר": <n> },
  "risks": [ "<נרטיב שלילי/מתקפה שרלוונטיים לקלנר/הליכוד ודורשים תגובה — שורה קצרה>" ]
}

כללים:
- *narratives = עד 6 הנרטיבים הבולטים בשיח כולו*, גם אם לא עוסקים בקלנר. stance = היחס לקלנר/הליכוד אם רלוונטי, אחרת "neutral". תמיד החזר לפחות 2-3 נרטיבים אם יש תוכן.
- sentiment ו-net_sentiment מתייחסים *לקלנר בלבד* (אם kellner_mentions=0 → אפסים).
- share_of_voice: ספור כמה הודעות מזכירות כל דמות: אריאל קלנר, ${rivalLine}.
- סַווג רק על סמך התוכן, בלי להמציא. עברית בערכי הטקסט.

התוכן לניתוח:
${poolText}`;

  const res = await classifyJSON(prompt, { maxTokens: 2000 });
  if (!res || typeof res !== 'object') return null;
  // normalise
  res.sentiment = res.sentiment || { pro: 0, anti: 0, neutral: 0 };
  res.narratives = Array.isArray(res.narratives) ? res.narratives : [];
  res.share_of_voice = res.share_of_voice || {};
  res.risks = Array.isArray(res.risks) ? res.risks : [];
  res.kellner_mentions = res.kellner_mentions || 0;
  return res;
}

// ─── Snapshots + trends ─────────────────────────────────────────
function loadSnapshots() {
  try { const a = JSON.parse(fs.readFileSync(TRENDS_FILE, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function recordSnapshot(analysis) {
  if (!analysis) return;
  const snaps = loadSnapshots();
  snaps.push({
    date: new Date().toISOString(),
    kellner_mentions: analysis.kellner_mentions || 0,
    sentiment: analysis.sentiment,
    net_sentiment: analysis.net_sentiment,
    narratives: (analysis.narratives || []).map(n => ({ title: n.title, stance: n.stance, count: n.count || 0 })),
    share_of_voice: analysis.share_of_voice || {},
  });
  while (snaps.length > MAX_SNAPSHOTS) snaps.shift();
  try { fs.writeFileSync(TRENDS_FILE, JSON.stringify(snaps, null, 2)); } catch (e) { logger.warn?.('recordSnapshot: ' + e.message); }
}
// Compare the current analysis narratives vs the previous snapshot → growth.
function getTrends(analysis) {
  const snaps = loadSnapshots();
  if (!snaps.length) return { rising: [], new: [] };
  const prev = snaps[snaps.length - 1]; // most recent stored (before this run)
  const prevMap = {};
  for (const n of (prev.narratives || [])) prevMap[_norm(n.title)] = n.count || 0;
  const rising = [], fresh = [];
  for (const n of (analysis.narratives || [])) {
    const key = _norm(n.title);
    const before = prevMap[key];
    if (before === undefined) { if (n.stance === 'anti') fresh.push(n); }
    else if ((n.count || 0) >= before * 2 && (n.count || 0) >= 3) rising.push({ ...n, before });
  }
  return { rising, new: fresh };
}
function _norm(s) { return (s || '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase(); }

// ─── Report formatting ──────────────────────────────────────────
function formatPulse(analysis, trends) {
  if (!analysis || (!analysis.kellner_mentions && !(analysis.narratives || []).length)) {
    return '🧭 *דופק מוניטין — קלנר*\n\n_לא נמצא תוכן משמעותי בטווח שנסרק (נסה טווח רחב יותר, או ודא שהפריסט/רשימת המעקב מאוכלסים)._';
  }
  const s = analysis.sentiment || {};
  const netMap = { positive: '🟢 חיובי', negative: '🔴 שלילי', mixed: '🟡 מעורב', neutral: '⚪ ניטרלי' };
  const d = new Date().toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
  let out = `🧭 *דופק מוניטין — קלנר* · ${d}\n`;
  if (analysis.kellner_mentions) {
    out += `📊 סנטימנט (${analysis.kellner_mentions} אזכורי קלנר): 🟢 ${s.pro || 0} בעד · 🔴 ${s.anti || 0} נגד · ⚪ ${s.neutral || 0} ניטרלי\n`;
    out += `🌡️ מגמה כללית: ${netMap[analysis.net_sentiment] || analysis.net_sentiment || '—'}\n`;
  } else {
    out += `📊 _אין אזכורים ישירים של קלנר בטווח — הנה תמונת השיח הפוליטי:_\n`;
  }

  // Share of voice
  const sov = Object.entries(analysis.share_of_voice || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (sov.length > 1) {
    out += `\n🗣️ *Share of Voice:*\n` + sov.slice(0, 6).map(([k, v]) => `   ${k === 'אריאל קלנר' ? '⭐' : '•'} ${k}: ${v}`).join('\n') + '\n';
  }

  // Narratives
  if (analysis.narratives.length) {
    out += `\n📈 *נרטיבים בולטים:*\n`;
    out += analysis.narratives.slice(0, 6).map(n => {
      const icon = n.stance === 'pro' ? '🟢' : n.stance === 'anti' ? '🔴' : '⚪';
      return `${icon} *${n.title}* (${n.count || 0})${n.sample ? `\n   _"${String(n.sample).substring(0, 90)}"_` : ''}`;
    }).join('\n');
    out += '\n';
  }

  // Trends (early warning)
  const rising = (trends && trends.rising) || [];
  const fresh = (trends && trends.new) || [];
  if (rising.length || fresh.length) {
    out += `\n📉 *מגמות מול הסריקה הקודמת:*\n`;
    for (const r of rising) out += `   ⬆️ "${r.title}" גדל (${r.before}→${r.count})\n`;
    for (const f of fresh) out += `   🆕 נרטיב שלילי חדש: "${f.title}"\n`;
  }

  // Risks
  if (analysis.risks.length) {
    out += `\n⚠️ *דורש תשומת לב:*\n` + analysis.risks.slice(0, 5).map(r => `   • ${r}`).join('\n');
  }
  return out.trim();
}

module.exports = {
  loadRivals, addRival, removeRival,
  analyzeMentions, recordSnapshot, getTrends, formatPulse,
};
