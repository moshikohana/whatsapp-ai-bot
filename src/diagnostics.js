'use strict';
/**
 * אבחון עצמי — so the owner can tell WHY the bot failed him, instead of
 * having to bring every dead end back to a developer.
 *
 * Two weeks of real logs (177 owner messages) showed the pattern: when the bot
 * can't handle something it answers with a dead end ("לא הבנתי") that hides
 * which of four very different things went wrong —
 *   1. a stale pending state swallowed an unrelated message
 *      ("כמה זמן מתל אביב לחולון" → "שלח כן/מספרים כדי להוסיף"),
 *   2. the command exists but wasn't reachable from that context,
 *   3. a tool/network genuinely failed,
 *   4. the request is outside what the bot can do.
 * Every failure is now recorded with its real cause and a concrete next step,
 * and "למה" replays the last one in plain Hebrew.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'diagnostics.json');
const MAX = 60;

const KINDS = {
  state_hijack: { icon: '🔁', label: 'מצב פתוח חטף את ההודעה' },
  unknown_cmd:  { icon: '❓', label: 'פקודה לא זוהתה' },
  tool_error:   { icon: '💥', label: 'שגיאה בכלי' },
  fetch_fail:   { icon: '🌐', label: 'לא הצלחתי לשלוף מידע' },
  llm_fallback: { icon: '🤖', label: 'נפל ל-AI הכללי' },
  agent_fail:   { icon: '🖥️', label: 'הסוכן במחשב' },
};

let log = null;
function _load() {
  if (log) return log;
  try { log = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { log = []; }
  return log;
}
function _save() {
  try { fs.writeFileSync(FILE, JSON.stringify(log.slice(-MAX), null, 2)); } catch {}
}

// kind: one of KINDS. input: what he sent. reason: what actually went wrong.
// hint: the concrete thing he can do about it right now.
function record({ kind, input, reason, hint, detail }) {
  _load();
  log.push({
    ts: Date.now(),
    kind: KINDS[kind] ? kind : 'tool_error',
    input: String(input || '').substring(0, 120),
    reason: String(reason || '').substring(0, 200),
    hint: String(hint || '').substring(0, 200),
    detail: String(detail || '').substring(0, 300),
  });
  if (log.length > MAX) log = log.slice(-MAX);
  _save();
}

const _time = ts => {
  try { return new Date(ts).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
};

// "למה" — explain the most recent failure so he can act on it himself.
function explainLast() {
  _load();
  if (!log.length) return '✅ *אין תקלות אחרונות* — הכל עבד כשורה.';
  const e = log[log.length - 1];
  const k = KINDS[e.kind] || KINDS.tool_error;
  let out = `${k.icon} *מה קרה בפעם האחרונה*\n_${_time(e.ts)}_\n${'━'.repeat(18)}\n\n`;
  out += `📝 *שלחת:* "${e.input}"\n`;
  out += `🔎 *הסיבה:* ${k.label} — ${e.reason}\n`;
  if (e.hint) out += `\n💡 *מה לעשות:* ${e.hint}`;
  if (e.detail) out += `\n\n🧾 _פרטים טכניים: ${e.detail}_`;
  out += `\n\n_לרשימה מלאה: *תקלות*_`;
  return out;
}

// "תקלות" — the recent history, grouped, so a repeating problem is obvious.
function report(limit = 10) {
  _load();
  if (!log.length) return '✅ *אין תקלות מתועדות.*';
  const recent = log.slice(-limit).reverse();
  const counts = {};
  for (const e of log) counts[e.kind] = (counts[e.kind] || 0) + 1;
  let out = `🩺 *תקלות אחרונות* (${log.length} מתועדות)\n${'━'.repeat(18)}\n\n`;
  out += `📊 *לפי סוג:*\n` + Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${(KINDS[k] || KINDS.tool_error).icon} ${(KINDS[k] || KINDS.tool_error).label} — ${n}`).join('\n');
  out += `\n\n🕐 *האחרונות:*\n`;
  out += recent.map(e => {
    const k = KINDS[e.kind] || KINDS.tool_error;
    return `${k.icon} _${_time(e.ts)}_ · "${e.input.substring(0, 40)}"\n   ${e.reason.substring(0, 80)}`;
  }).join('\n\n');
  out += `\n\n_להסבר מלא על האחרונה: *למה*_`;
  return out;
}

// Does this message clearly belong to something OTHER than an open flow?
// Stale pending states swallowing unrelated messages was the single biggest
// source of confusion in the logs, so the bar for "this isn't an answer to my
// question" is deliberately generous.
function looksLikeNewRequest(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/https?:\/\//i.test(t)) return true;                       // pasted a link
  if (/\?\s*$/.test(t)) return true;                             // asked a question
  if (/^(כמה|מה|מי|איך|למה|מתי|איפה|האם|כמו)\s/.test(t)) return true;
  if (/^(תעשה|תשלח|תכין|תבדוק|תחפש|תפתח|תסרוק|תנתח|תמצא|תספר|תסביר|צלם|הצג)(?![א-ת])/.test(t)) return true;
  if (t.length > 45) return true;                                // a sentence, not "כן"/"3"
  return false;
}

// Stronger, and the one that actually matters for yes/no/number prompts:
// is this a VALID answer to the question the bot asked? Anything else should
// release the state rather than swallow the message. "מתל אביב לחולון" is not
// a new-request pattern, but it is obviously not an answer to "add these
// groups?" either — and that is what got it eaten.
function looksLikeAnswer(text, kind = 'yesno') {
  const t = String(text || '').trim();
  if (!t) return false;
  if (kind === 'yesno') {
    return /^(כן|לא|הכל|כולם|בטח|אוקיי|ok|yes|no|סיום|ביטול|בטל|דלג)$/i.test(t)
      || /^[\d\s,]{1,20}$/.test(t)                              // "3" / "1 3 5"
      || /^(כן|הוסף|לא)\s/.test(t);
  }
  return true;
}

module.exports = { record, explainLast, report, looksLikeNewRequest, looksLikeAnswer, KINDS };
