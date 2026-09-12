'use strict';
/**
 * מה נאמר בשידור — ולא רק מתי הוזכר השם.
 *
 * ניטור השידורים כבר מתמלל כ-30 קטעים בשעה משתי תחנות, ואז זורק כמעט את
 * הכול: רק התאמה מדויקת למילת מפתח הופכת להתראה, וכל השאר נשמר ב-60 קטעים
 * בזיכרון שנמחקים בכל אתחול. התמלול כבר שולם עליו — כאן הוא נשמר ומנותח.
 *
 * שתי שכבות:
 *   1. תמלול מתמיד על הדיסק, JSONL לפי יום — זול לכתוב, קל לחתוך לפי שעה
 *   2. ניתוח שעתי שמוציא נושאים חמים וציטוטים, עם מי אמר, מתי, ובאיזו תכנית
 *
 * זיהוי התכנית הוא הֶסֵּק ולא עובדה: אין לוח שידורים אמין לתחנות האלה, אבל
 * המנחים מזהים את עצמם ואת התכנית באוויר כל הזמן. לכן כל תכנית נושאת רמת
 * ודאות, וכשהיא נמוכה זה נאמר במפורש במקום להציג ניחוש כידיעה.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DIR = path.join(__dirname, '..', 'data', 'broadcast');
const DIGEST_FILE = path.join(DIR, 'digests.json');

const KEEP_DAYS = 7;              // transcript days kept on disk
const MAX_DIGESTS = 120;          // ~5 days of hourly digests
const MIN_CHARS_TO_ANALYSE = 400; // below this there is nothing to say

function _dayFile(d = new Date()) {
  const day = new Date(d).toISOString().slice(0, 10);
  return path.join(DIR, `${day}.jsonl`);
}

/**
 * שומר קטע תמלול. נקרא מכל דגימה, גם כשאין שום מילת מפתח —
 * זו בדיוק הנקודה: מה שנזרק עד עכשיו הוא רוב החומר.
 */
// ── 🎧 The audio behind each transcript, for 48 hours ─────────────
// "הרדיו הקדים ב-8 דק׳" said so, and there was nothing to press: the audio
// was deleted as soon as it was transcribed. Now it is kept two days —
// ~48kbps mono, a few hundred MB — so the claim can be heard.
const AUDIO_DIR = path.join(DIR, 'audio');
const AUDIO_KEEP_MS = 48 * 3600000;
let _lastSweep = 0;
function keepAudio(tmpFile, stationId, ts) {
  if (!tmpFile) return null;
  try {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    const name = `${ts}-${String(stationId).replace(/[^a-z0-9]/gi, '')}.mp3`;
    // Copied, not renamed: /tmp can be another filesystem.
    fs.copyFileSync(tmpFile, path.join(AUDIO_DIR, name));
    try { fs.unlinkSync(tmpFile); } catch {}
    if (Date.now() - _lastSweep > 30 * 60000) {
      _lastSweep = Date.now();
      for (const f of fs.readdirSync(AUDIO_DIR)) {
        const t = parseInt(f, 10);
        if (t && Date.now() - t > AUDIO_KEEP_MS) { try { fs.unlinkSync(path.join(AUDIO_DIR, f)); } catch {} }
      }
    }
    return name;
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch {}
    logger.warn('broadcast audio keep: ' + (e.message || '').substring(0, 60));
    return null;
  }
}
function audioPath(name) {
  const n = String(name || '');
  if (!/^\d+-[a-z0-9]+\.mp3$/i.test(n)) return null;
  const p = path.join(AUDIO_DIR, n);
  return fs.existsSync(p) ? p : null;
}

/**
 * הקטע ששודר סביב רגע מסוים בתחנה: הקטע שהכי מתאים לטקסט שחיפשו (q), ואם
 * אין — האחרון שנשמע עד אז. יחד עם הקטע שלפניו ושאחריו.
 */
function clipAround(station, ts, q = '') {
  const list = chunksBetween(ts - 25 * 60000, ts + 12 * 60000)
    .filter(c => !station || c.station === station).sort((a, b) => a.ts - b.ts);
  if (!list.length) return null;
  const words = String(q || '').replace(/[^\u0590-\u05FFa-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
  const stems = words.map(w => (w.length >= 5 && 'בהוכלמש'.includes(w[0])) ? w.slice(1) : w);
  const score = c => stems.reduce((s, w) => s + (c.text.includes(w) ? 1 : 0), 0);
  let i = -1;
  if (words.length) {
    let best = 0;
    list.forEach((c, k) => { const s = score(c); if (s > best || (s === best && s > 0 && Math.abs(c.ts - ts) < Math.abs(list[i].ts - ts))) { best = s; i = k; } });
    if (best < Math.min(2, words.length)) i = -1;
  }
  if (i < 0) { i = list.findIndex(c => c.ts > ts + 90000); i = (i < 0 ? list.length : i) - 1; if (i < 0) i = 0; }
  const out = c => c && { ts: c.ts, station: c.station, text: c.text, audio: !!(c.audio && audioPath(c.audio)), audioName: c.audio && audioPath(c.audio) ? c.audio : null };
  return { chunk: out(list[i]), prev: out(list[i - 1]), next: out(list[i + 1]) };
}

function recordChunk({ station, text, ts = Date.now(), audio = null }) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(_dayFile(ts), JSON.stringify(audio ? { ts, station, text: clean, audio } : { ts, station, text: clean }) + '\n');
    return true;
  } catch (e) {
    logger.warn('broadcast-digest record: ' + (e.message || '').substring(0, 60));
    return false;
  }
}

/** קטעי התמלול בטווח זמן, מכל הימים הרלוונטיים. */
function chunksBetween(fromTs, toTs) {
  const out = [];
  // A window can straddle midnight, so read both days rather than assuming one.
  const days = new Set([_dayFile(fromTs), _dayFile(toTs)]);
  for (const f of days) {
    let raw = '';
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.ts >= fromTs && o.ts <= toTs) out.push(o);
      } catch {}
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function _hhmm(ts) {
  return new Date(ts).toLocaleTimeString('he-IL', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit',
  });
}

function _loadDigests() {
  try { return JSON.parse(fs.readFileSync(DIGEST_FILE, 'utf8')); } catch { return []; }
}
function _saveDigests(list) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(DIGEST_FILE, JSON.stringify(list, null, 2));
  } catch (e) {
    logger.warn('broadcast-digest save: ' + (e.message || '').substring(0, 60));
  }
}

const SYSTEM = `אתה מנתח תמלולי רדיו בעברית עבור **דובר בזירה הפוליטית בישראל**.

הוא לא צרכן חדשות כללי. הוא צריך לדעת מה נאמר באוויר שעשוי לחייב אותו להגיב, או שמשנה את התמונה הפוליטית שהוא פועל בתוכה.

## מה כן מעניין אותו (לפי סדר)
1. פוליטיקה ישראלית — כנסת, ממשלה, קואליציה, אופוזיציה, מפלגות, בחירות, שריונים, מינויים, סקרים
2. ביטחון — צה״ל, מלחמה, חטופים, מילואים, גיוס והשתמטות, פיגועים, איראן, חיזבאללה, חמאס, שטחים
3. יחסי חוץ ולחץ בינלאומי — סנקציות, אמברגו, האו״ם, ארה״ב, אירופה
4. משפט ומשילות — היועמ״שית, בג״ץ, ועדות חקירה, שחיתות
5. תקשורת ושיח ציבורי — מי תוקף את מי, סערות, ראיונות פוליטיים
6. כל אזכור של האנשים והנושאים שהוא עוקב אחריהם

## מה לא מעניין אותו — אל תכניס לרשימה
ספורט · מזג אוויר · תנועה ופקקים · פרסומות · מוזיקה ושירים · ברכות חג ואווילות חגיגית · טיפים צרכניים (תעריפי חשמל, ספקי אינטרנט, ביטוח לאומי, זכויות צרכן) · בריאות כללית · תוכן לייפסטייל · סיפורים אנושיים מקומיים בלי זווית פוליטית

חריג יחיד: אם נושא כזה **הפך לסיפור פוליטי** — למשל תלונה צרכנית שהופכת לביקורת על שר — הוא כן רלוונטי, ואז הסבר את הזווית הפוליטית ב-summary.

## על התמלול
הוא מגיע מדגימות של 55 שניות כל 4 דקות, ולכן **קטוע** — משפטים מתחילים ונגמרים באמצע, ויש חורים בין הדגימות. אל תמציא מה שהיה בחורים.

## חוקים
- ציטוט הוא רק טקסט שמופיע **מילה במילה** בתמלול. אסור לנסח מחדש, לתקן או להשלים.
- העדף ציטוטים של **פוליטיקאים, פרשנים ומרואיינים** על פני מנחים שמקריאים מבזק.
- אם לא ברור מי הדובר — כתוב null. אל תנחש שם.
- שם התכנית הוא הסק מהתמלול (מנחים מזהים את עצמם באוויר). אם אין רמז — null.
- **שעה שקטה היא תשובה לגיטימית.** אם לא נאמר שום דבר פוליטי או ביטחוני, החזר topics ריק. עדיף ריק מאשר למלא בספורט ובטיפים צרכניים.

החזר JSON בלבד:
{
  "topics": [
    {"title":"...", "summary":"משפט אחד", "stations":["..."],
     "heat": 1-5,
     "category":"פוליטיקה|ביטחון|יחסי חוץ|משפט|תקשורת",
     "actionable":"מה זה אומר עבור דובר — או null אם רק רקע"}
  ],
  "quotes": [
    {"text":"ציטוט מדויק מהתמלול", "speaker":null, "station":"...", "time":"HH:MM", "why":"למה זה מעניין דובר"}
  ],
  "programs": [
    {"station":"...", "name":"...", "confidence":"high|medium|low", "evidence":"מה בתמלול רומז לזה"}
  ]
}`;

/**
 * מנתח את השעה האחרונה. מוחזר null כשאין מספיק חומר — לא שגיאה, פשוט שקט.
 */
async function analyseHour({ fromTs, toTs } = {}) {
  const to = toTs || Date.now();
  const from = fromTs || (to - 60 * 60 * 1000);
  const chunks = chunksBetween(from, to);
  const total = chunks.reduce((s, c) => s + c.text.length, 0);
  if (total < MIN_CHARS_TO_ANALYSE) {
    logger.info(`📻 digest: only ${total} chars in window — skipping`);
    return null;
  }

  // Each line is stamped so the model can attribute a quote to a time and a
  // station without being asked to remember an ordering.
  const body = chunks
    .map(c => `[${_hhmm(c.ts)} · ${c.station}] ${c.text}`)
    .join('\n');

  // What he was already told in the last hours. A story running all
  // morning came back as a "topic" every hour — the same line, again.
  const earlier = _loadDigests().filter(d => d.from < from && d.from >= from - 4 * 3600000)
    .flatMap(d => (d.topics || []).map(t => `• ${t.title} — ${t.summary}`)).slice(0, 20);
  const avoid = earlier.length
    ? `\n\nנושאים שכבר דווחו לו בשעות הקודמות — אל תחזור עליהם. אם יש בנושא כזה התפתחות חדשה של ממש, כלול אותו עם title שמתחיל ב"עדכון:" ו-summary שאומר רק מה חדש:\n${earlier.join('\n')}`
    : '';

  const claude = require('./claude');
  // 2600 truncated the JSON mid-array every time and the parse then failed —
  // the errors landed at character 3949, 4273, 4404. Hebrew costs roughly two
  // to three tokens per word, so a five-topic answer with summaries and quotes
  // does not fit in that budget. The failure was invisible: analyseHour
  // returned null and the caller reported "not enough transcript", blaming the
  // radio for a limit set here.
  const result = await claude.classifyJSON(
    `תמלולי רדיו מהשעה האחרונה (${_hhmm(from)}–${_hhmm(to)}):\n\n${body}\n\n` +
    `הגבל ל-4 נושאים ו-4 ציטוטים לכל היותר, ושמור על summary של משפט אחד.` + avoid,
    { system: SYSTEM, maxTokens: 6000 }
  );
  if (!result) {
    logger.warn(`📻 digest ${_hhmm(from)}–${_hhmm(to)}: analysis returned nothing (${chunks.length} chunks were available)`);
    // Distinguished from the empty-window case by the caller, so a model
    // failure is never reported as missing transcript again.
    const err = new Error('ANALYSIS_FAILED');
    err.code = 'ANALYSIS_FAILED';
    throw err;
  }

  // Quotes are verified against the transcript rather than trusted. A quote the
  // model tightened up reads better and is exactly the thing a spokesperson
  // must never be handed — he might repeat it publicly as a real one.
  const haystack = chunks.map(c => c.text).join(' ').replace(/\s+/g, ' ');
  const norm = s => String(s || '').replace(/["'״׳]/g, '').replace(/\s+/g, ' ').trim();
  const flatHay = norm(haystack);
  const quotes = (result.quotes || []).filter(q => {
    const t = norm(q.text);
    if (t.length < 12) return false;
    const ok = flatHay.includes(t);
    if (!ok) logger.info(`📻 digest: dropped unverifiable quote "${t.substring(0, 45)}…"`);
    return ok;
  });

  const digest = {
    id: `${from}`,
    from, to,
    label: `${_hhmm(from)}–${_hhmm(to)}`,
    // A second filter behind the prompt. The instruction alone still let
    // consumer-affairs segments through — electricity tariffs, national
    // insurance, no hot water in a care home — because they genuinely were
    // the hour's news. They are just not his news.
    topics: (result.topics || [])
      .filter(t => {
        const s = `${t.title || ''} ${t.summary || ''}`;
        const junk = /(ספורט|כדורגל|כדורסל|מזג האוויר|פקקים|תנועה בכביש|פרסומת|מוזיקה|שיר של|תעריפי חשמל|ספק חשמל|אינטרנט ביתי|ביטוח לאומי|זכויות צרכן|מים חמים|לייפסטייל|מתכון)/;
        // Kept anyway when the model itself found a political angle.
        const political = /(פוליטי|כנסת|ממשלה|שר |שרה |מפלג|בחירות|קואליציה|אופוזיציה|ביטחון|צה"ל|צה״ל|חטופים|מילואים|גיוס|איראן|חמאס|סנקציות)/;
        return !(junk.test(s) && !political.test(s));
      })
      .slice(0, 5),
    quotes: quotes.slice(0, 6),
    programs: (result.programs || []).slice(0, 4),
    chunkCount: chunks.length,
    stations: [...new Set(chunks.map(c => c.station))],
    ts: Date.now(),
  };

  const list = _loadDigests().filter(d => d.id !== digest.id);
  list.push(digest);
  list.sort((a, b) => b.from - a.from);
  _saveDigests(list.slice(0, MAX_DIGESTS));

  logger.info(`📻 digest ${digest.label}: ${digest.topics.length} topics, ${digest.quotes.length} verified quotes`);
  return digest;
}

/** המהדורה של השעה העגולה, מצורפת לתקציר שלפניה. */
function setBulletin(id, bulletin) {
  const list = _loadDigests();
  const d = list.find(x => x.id === id);
  if (!d) return null;
  d.bulletin = bulletin;
  _saveDigests(list);
  return d;
}

function recentDigests(n = 24) {
  return _loadDigests().slice(0, n);
}

/**
 * הדגימות האחרונות שנקלטו — מה שנאמר באוויר ממש עכשיו.
 *
 * הניתוח השעתי מסכם, וסיכום תמיד מאחר בעד שעה. זה הזנב החי: מה נכנס
 * בדקות האחרונות, בלי עיבוד, כדי שאפשר יהיה לראות שהניטור באמת עובד
 * ולתפוס משהו לפני שהתקציר הבא נכתב.
 */
function recentChunks(n = 20) {
  const to = Date.now();
  const from = to - 3 * 60 * 60 * 1000;
  return chunksBetween(from, to)
    .slice(-n)
    .reverse()
    .map(c => ({ ts: c.ts, station: c.station, text: c.text.substring(0, 500) }));
}

/** ניקוי תמלולים ישנים — ארכיון שרק גדל הוא בעיית הדיסק הבאה. */
function prune() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const day = new Date(f.replace('.jsonl', '')).getTime();
      if (!isNaN(day) && day < cutoff) {
        fs.unlinkSync(path.join(DIR, f));
        logger.info(`📻 pruned old transcript ${f}`);
      }
    }
  } catch {}
}

/** הודעת וואטסאפ לתקציר שעתי. */
function formatDigest(d) {
  if (!d) return '';
  const lines = [`📻 *מה נאמר בשידור* · ${d.label}`];
  if (d.programs?.length) {
    const p = d.programs
      .filter(x => x.name)
      .map(x => `${x.station}: ${x.name}${x.confidence === 'low' ? ' (לא ודאי)' : ''}`);
    if (p.length) lines.push(`🎙️ ${p.join(' · ')}`);
  }
  if (d.topics?.length) {
    lines.push('', '*נושאים:*');
    for (const t of d.topics) lines.push(`${'🔥'.repeat(Math.min(3, Math.max(1, Math.ceil((t.heat || 1) / 2))))} *${t.title}* — ${t.summary}`);
  }
  if (d.quotes?.length) {
    lines.push('', '*ציטוטים:*');
    for (const q of d.quotes) {
      lines.push(`🕐 ${q.time || ''} ${q.speaker ? `*${q.speaker}*` : '_דובר לא מזוהה_'} (${q.station || ''})`);
      lines.push(`"${q.text}"`);
    }
  }
  // The round-hour bulletin: only what is new (see news-bulletins).
  if (d.bulletin) lines.push(...require('./news-bulletins').formatForDigest(d.bulletin));
  if (!d.topics?.length && !d.quotes?.length && !(d.bulletin && (d.bulletin.headlines || []).some(h => h.status !== 'repeat'))) {
    lines.push('', '_שעה שקטה — לא נאמר משהו שדורש אותך._');
  }
  return lines.join('\n');
}

module.exports = {
  keepAudio, audioPath, clipAround,
  recordChunk, chunksBetween, analyseHour, recentDigests, recentChunks, prune, formatDigest, setBulletin,
};
