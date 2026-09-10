'use strict';
/**
 * מד היתרון — "התגובה מוכנה לפני שהטלפון מצלצל".
 *
 * הרדיו כבר תופס כותרות לפני שהן מגיעות לקבוצות. זה המשך הדרך:
 *   1. לכל כותרת — מתי הסיפור הגיע לקבוצות, ובכמה דקות הקדמנו אותן.
 *   2. כותרת שנוגעת בקלנר — חבילה מוכנה: טיוטת תגובה, ציוץ, שאלות צפויות,
 *      ומי מהעיתונאים כנראה יתקשר.
 *   3. סיכום שבועי — כמה הקדמנו, בכמה סיפורים, וכמה דרשו תגובה.
 *
 * ההתאמה בין כותרת להודעה בקבוצה נעשית בשני שלבים: קודם השוואת מילים זולה
 * על כל הודעה, ורק למועמדות — שאלה קצרה ל-Haiku "זה אותו סיפור?". כך מאות
 * ההודעות בשעה לא עולות כסף, והזיהוי לא נשען על מילה משותפת אחת.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const HEADLINES = path.join(__dirname, '..', 'data', 'broadcast', 'headlines.json');
const WATCH_HOURS = 6;              // a story that has not reached the groups in 6h won't
const MIN_OVERLAP = 3;              // shared content words before asking the model
const MAX_CHECKS_PER_HOUR = 40;     // model confirmations — a cap, not a target
const RELEVANT_SCORE = 4;           // 1-5; below this no package is built

const STOP = new Set(('של את על עם זה זו לא כי גם אם או אבל רק כל יש אין היה היא הוא הם הן אני אנחנו ' +
  'אתה מה מי איך למה כמו עוד כבר אחרי לפני בין תחת מול אל עד שלא שהוא שהיא הזה הזאת היום אמר אמרה ' +
  'נגד בגלל כדי לכן מאוד יותר פחות שם פה כאן עכשיו אתמול מחר השבוע ראש שר חבר').split(/\s+/));

const _norm = s => String(s || '').replace(/["'״׳.,!?:;()\-–—|/\\*_~]/g, ' ').replace(/\s+/g, ' ').trim();
// One leading prefix letter off longer words, so "בוינטר" meets "וינטר".
const _stem = w => (w.length >= 5 && /^[והבלמשכ]/.test(w) ? w.slice(1) : w);
const _words = s => new Set(_norm(s).split(' ').filter(w => w.length >= 3 && !STOP.has(w)).map(_stem));

function _load() { try { return JSON.parse(fs.readFileSync(HEADLINES, 'utf8')); } catch { return []; } }
function _save(list) { try { fs.writeFileSync(HEADLINES, JSON.stringify(list, null, 1)); } catch (e) { logger.warn('lead save: ' + (e.message || '').substring(0, 50)); } }

let _checksThisHour = 0, _hourKey = 0, _busy = false;
const _pending = [];   // { id, text, group, ts }

/**
 * נקרא על כל הודעת טקסט בקבוצה. זול: השוואת מילים בלבד, ומועמדות נכנסות לתור.
 */
function onGroupText({ text, group, ts }) {
  try {
    const body = String(text || '');
    if (body.length < 25) return;
    const now = ts || Date.now();
    const open = _load().filter(h => !h.groupsSeen && now - h.ts < WATCH_HOURS * 3600000 && now >= h.ts - 30 * 60000);
    if (!open.length) return;
    const mine = _words(body);
    for (const h of open) {
      const theirs = _words(`${h.headline} ${h.speaker || ''} ${h.quote || ''}`);
      let shared = 0;
      for (const w of theirs) if (mine.has(w)) shared++;
      // The speaker's surname is worth more than a common word.
      const sur = _norm(h.speaker || '').split(' ').pop();
      if (sur && sur.length >= 3 && _norm(body).includes(sur)) shared += 2;
      if (shared >= MIN_OVERLAP && !_pending.some(p => p.id === h.id)) {
        _pending.push({ id: h.id, headline: h.headline, quote: h.quote, text: body.substring(0, 700), group, ts: now });
      }
    }
    _drain();
  } catch (e) { logger.warn('lead onGroupText: ' + (e.message || '').substring(0, 60)); }
}

async function _drain() {
  if (_busy || !_pending.length) return;
  const hk = Math.floor(Date.now() / 3600000);
  if (hk !== _hourKey) { _hourKey = hk; _checksThisHour = 0; }
  if (_checksThisHour >= MAX_CHECKS_PER_HOUR) { _pending.length = 0; return; }
  _busy = true;
  const c = _pending.shift();
  try {
    // Already matched by an earlier message while this one waited.
    if (_load().find(h => h.id === c.id && h.groupsSeen)) return;
    _checksThisHour++;
    const r = await require('./claude').classifyJSON(
      `כותרת שנקלטה ברדיו:\n"${c.headline}"${c.quote ? `\nציטוט: "${c.quote}"` : ''}\n\nהודעה שפורסמה בקבוצת וואטסאפ:\n"${c.text}"`,
      {
        system: 'אתה עורך חדשות. החלט אם ההודעה מדווחת על אותו סיפור בדיוק כמו הכותרת — אותו אירוע או אותה אמירה, לא רק אותו נושא כללי. החזר JSON בלבד: {"same": true|false}',
        maxTokens: 30, model: 'claude-haiku-4-5-20251001',
      }
    );
    if (!r || r.same !== true) return;
    const list = _load();
    const h = list.find(x => x.id === c.id);
    if (!h || h.groupsSeen) return;
    const lead = Math.round((c.ts - h.ts) / 60000);
    h.groupsSeen = { ts: c.ts, group: String(c.group || '').substring(0, 80), text: c.text.substring(0, 240) };
    h.leadMin = lead;
    _save(list);
    logger.info(`⏱️ lead: "${h.headline.substring(0, 40)}" reached "${c.group}" after ${lead} min`);
  } catch (e) {
    logger.warn('lead confirm: ' + (e.message || '').substring(0, 60));
  } finally {
    _busy = false;
    if (_pending.length) setTimeout(_drain, 500);
  }
}

// ── נוגע בקלנר? ─────────────────────────────────────────────────
// Who he is, stated outright. The memory lists his positions but never says
// "Likud MK, loyal to Netanyahu" — and without it the model scored attacks
// on Netanyahu 2/5, "not his", which is exactly where he is expected to answer.
const KELLNER_IDENTITY =
  'ח"כ אריאל קלנר — חבר כנסת מהליכוד, תומך מובהק של ראש הממשלה נתניהו ושל מחנה הימין. ' +
  'מתקפה על נתניהו, על הליכוד, על הקואליציה או על מחנה הימין — נוגעת אליו: הזדמנות להגן ולהשיב. ' +
  'גם כל מה שנוגע בתחומיו: ביטחון ומלחמה, מערכת המשפט ובג"ץ, ועדת חקירה ל-7.10, התיישבות וריבונות, ' +
  'מימון זר לעמותות, UNRWA, נשק לאזרחים, סמים ואלכוהול, הגליל.';

function _kellnerBrief() {
  try {
    const ctx = require('./spokesperson').getKellnerContext();
    // Only the lines that state a position or a role. The same memories also
    // hold the bot's own feature notes ("סקירת בוקר", "Command Center") —
    // noise that had crowded out the positions.
    const lines = [...(ctx.positions || []), ...(ctx.roles || [])].join('\n').split('\n')
      .map(l => l.trim())
      .filter(l => /^•/.test(l) || /^תחומי מומחיות/.test(l));
    return [KELLNER_IDENTITY, ...lines].join('\n').substring(0, 2500);
  } catch { return KELLNER_IDENTITY; }
}

function _journalists(headline) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'media-outreach.json'), 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.contacts || Object.values(raw));
    const want = _words(headline);
    return list.map(c => {
      const topics = [c.lastTopic, ...(c.history || []).map(h => h.topic)].filter(Boolean).join(' ');
      let s = 0;
      for (const w of _words(topics)) if (want.has(w)) s++;
      return { name: c.name, outlet: c.outlet, score: s, topics };
    }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  } catch { return []; }
}

/**
 * נקרא על כל כותרת חדשה. אם היא נוגעת בקלנר — בונה חבילת תגובה.
 * @returns החבילה, או null כשהכותרת לא רלוונטית
 */
async function onHeadline(h) {
  const claude = require('./claude');
  const brief = _kellnerBrief();
  const rel = await claude.classifyJSON(
    `כותרת: ${h.headline}\n${h.speaker ? `דובר: ${h.speaker}\n` : ''}${h.quote ? `ציטוט: "${h.quote}"\n` : ''}` +
    `תמלול סביב:\n${String(h.context || '').substring(0, 1500)}\n\n` +
    `ח"כ אריאל קלנר (ליכוד) — עמדות ותפקידים:\n${brief || '(אין פירוט)'}`,
    {
      system: 'אתה יועץ תקשורת של ח"כ אריאל קלנר. האם הכותרת מחייבת ממנו תגובה או מזמנת לו הזדמנות — כי היא נוגעת בנושאים שלו, בליכוד, בקואליציה, ביריביו, או שעיתונאים צפויים לשאול אותו עליה? ' +
        'החזר JSON בלבד: {"score": 1-5, "why": "משפט אחד — למה זה נוגע אליו", "angle": "הזווית הנכונה לתגובה במשפט"}. 5 = חייב להגיב עכשיו. 1 = לא קשור אליו.',
      maxTokens: 450, model: 'claude-haiku-4-5-20251001',
    }
  );
  if (!rel || (rel.score || 0) < RELEVANT_SCORE) {
    logger.info(`⚡ ready-response: "${h.headline.substring(0, 40)}" — not his (${rel ? rel.score : '?'})`);
    return null;
  }

  const draft = await claude.classifyJSON(
    `כותרת מהרדיו: ${h.headline}\n${h.speaker ? `דובר: ${h.speaker}\n` : ''}${h.quote ? `ציטוט: "${h.quote}"\n` : ''}` +
    `תמלול:\n${String(h.context || '').substring(0, 2000)}\n\nזווית: ${rel.angle || ''}\n\n` +
    `עמדות ח"כ קלנר:\n${brief || '(אין פירוט)'}`,
    {
      system: 'אתה הדובר של ח"כ אריאל קלנר (ליכוד). סגנון: חד, ישיר, לאומי, בגוף ראשון, בלי קלישאות. אסור להמציא עובדות שלא בכותרת או בתמלול. ' +
        'החזר JSON בלבד: {"draft": "תגובה לתקשורת, 2-3 משפטים", "tweet": "ציוץ עד 240 תווים", ' +
        '"questions": [{"q": "שאלה קשה שעיתונאי ישאל", "a": "תשובה חדה במשפט"}, {"q": "...", "a": "..."}]}',
      maxTokens: 1400,
    }
  );
  if (!draft || !draft.draft) return null;

  const pkg = {
    ts: Date.now(),
    score: rel.score, why: String(rel.why || '').substring(0, 200),
    draft: String(draft.draft).substring(0, 600),
    tweet: String(draft.tweet || '').substring(0, 280),
    questions: (Array.isArray(draft.questions) ? draft.questions : []).slice(0, 3)
      .map(x => ({ q: String(x.q || '').substring(0, 200), a: String(x.a || '').substring(0, 300) })).filter(x => x.q),
    journalists: _journalists(`${h.headline} ${h.quote || ''}`),
  };
  const list = _load();
  const it = list.find(x => x.id === h.id);
  if (it) { it.package = pkg; _save(list); }
  logger.info(`⚡ ready-response: "${h.headline.substring(0, 40)}" — package built (${rel.score})`);
  return pkg;
}

function formatPackage(h, p) {
  const t = new Date(h.ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
  const lines = [
    `⚡ *תגובה מוכנה* · ${h.station} · ${t}`,
    `*${h.headline}*`,
    '',
    `🎯 ${p.why}`,
    '',
    `📝 *טיוטה:*\nח"כ אריאל קלנר: "${p.draft}"`,
  ];
  if (p.tweet) lines.push('', `🐦 *ציוץ:*\n${p.tweet}`);
  if (p.questions.length) {
    lines.push('', '❓ *מה ישאלו:*');
    for (const x of p.questions) lines.push(`ש: ${x.q}\nת: ${x.a}`);
  }
  if (p.journalists.length) {
    lines.push('', '📞 *עשויים לפנות* (לפי נושאים שפנו עליהם בעבר):');
    for (const j of p.journalists) lines.push(`• ${j.name} · ${j.outlet}`);
  }
  // Only when it is true — by the time a package is read the story may be out.
  const cur = _load().find(x => x.id === h.id) || h;
  lines.push('', cur.groupsSeen
    ? `_הסיפור כבר הגיע לקבוצות (${cur.groupsSeen.group}) — ${cur.leadMin} דק' אחרי הרדיו._`
    : '_הסיפור עוד לא הופיע בקבוצות — אתה לפני כולם._');
  return lines.join('\n');
}

// ── סיכום ─────────────────────────────────────────────────────────
function stats(days = 7) {
  const since = Date.now() - days * 86400000;
  const list = _load().filter(h => h.ts >= since);
  const seen = list.filter(h => h.groupsSeen && typeof h.leadMin === 'number');
  const ahead = seen.filter(h => h.leadMin > 0);
  const avg = ahead.length ? Math.round(ahead.reduce((s, h) => s + h.leadMin, 0) / ahead.length) : null;
  const best = ahead.slice().sort((a, b) => b.leadMin - a.leadMin)[0] || null;
  return {
    days,
    headlines: list.length,
    reachedGroups: seen.length,
    ahead: ahead.length,
    avgLeadMin: avg,
    best: best ? { headline: best.headline, leadMin: best.leadMin, group: best.groupsSeen.group } : null,
    packages: list.filter(h => h.package).length,
  };
}

function formatWeekly(s) {
  if (!s.headlines) return null;
  const lines = [`⏱️ *מד היתרון · ${s.days} ימים*`, ''];
  lines.push(`🗞️ ${s.headlines} כותרות נקלטו ברדיו`);
  if (s.reachedGroups) {
    lines.push(`📲 ${s.reachedGroups} מהן הגיעו אחר כך לקבוצות${s.avgLeadMin != null ? ` — הקדמת אותן ב-*${s.avgLeadMin} דקות* בממוצע` : ''}`);
  } else {
    lines.push('📲 אף אחת עוד לא זוהתה בקבוצות');
  }
  if (s.best) lines.push(`🏆 היתרון הגדול: ${s.best.leadMin} דק' — "${s.best.headline}" (${s.best.group})`);
  lines.push(`⚡ ${s.packages} דרשו תגובה — וקיבלת חבילה מוכנה`);
  return lines.join('\n');
}

/** מתי התור ריק — לריצת בדיקה על הודעות שמורות. */
function idle() {
  return new Promise(r => {
    const t = setInterval(() => { if (!_busy && !_pending.length) { clearInterval(t); r(); } }, 100);
  });
}

module.exports = { onGroupText, onHeadline, formatPackage, stats, formatWeekly, idle };
