'use strict';
/**
 * האלבום שמתמלא לבד — כל תמונה שבה זוהתה אחת הבנות, לתמיד, לפי חודשים.
 *
 * ארכיון הזיהויים (face-archive) הוא יומן: מוגבל ל-40 לאדם ומוחק ישנות,
 * והתמונות בו מסומנות במסגרות. זה משהו אחר — אלבום. בלי תקרה, התמונה
 * הנקייה, ולא נמחק כלום אלא אם הוא ביקש.
 *
 * מה נכנס: זיהוי שעבר את הסף בקבוצה (התראה אמיתית), ואישור שלו —
 * "✅ זו שי" באפליקציה או תשובה לשאלה. מועמד חלש לא נכנס בלי אישור.
 *
 * כפילויות: אותה תמונה מגיעה לפעמים פעמיים (הועברה, נשלחה לקניות ולגן).
 * טביעה של 16×16 אפורה, ומה שקרוב מדי לתמונה מהימים האחרונים — לא נשמר שוב.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const ROOT = path.join(__dirname, '..', 'data', 'album');
const INDEX = path.join(ROOT, 'index.json');
const SAFETY_CAP = 5000;            // per person — a guard, not a design limit
const DUP_DIFF = 4;                 // mean grey difference (0-255) below which it is the same photo
const DUP_WINDOW_MS = 3 * 86400000;

const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const _safe = s => String(s || '').replace(/[^\p{L}\p{N}_-]/gu, '_').substring(0, 40);
const _monthKey = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
const _monthLabel = key => { const [y, m] = key.split('-'); return `${MONTHS[+m - 1]} ${y}`; };

function _load() { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return {}; } }
function _save(idx) {
  try { fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(INDEX, JSON.stringify(idx)); }
  catch (e) { logger.warn('album save: ' + (e.message || '').substring(0, 60)); }
}

async function _sig(buf) {
  return (await require('sharp')(buf).rotate().resize(16, 16, { fit: 'fill' }).greyscale().raw().toBuffer()).toString('base64');
}
function _diff(a, b) {
  const x = Buffer.from(a, 'base64'), y = Buffer.from(b, 'base64');
  if (x.length !== y.length) return 255;
  let s = 0; for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]);
  return s / x.length;
}

/**
 * @param buffer  התמונה הנקייה — לא העותק עם המסגרות
 * @param source  alert | confirm | answer | backfill
 * @returns { added, dup, file }
 */
async function add({ name, buffer, group = '', confidence = null, ts = Date.now(), source = 'alert', force = false }) {
  if (!name || !buffer || !buffer.length) return { added: false };
  // Never a child in a group she cannot be in — מיה in שי's kindergarten.
  // Unless he said so himself (✏️ מי בתמונה).
  try { if (!force && group && !require('./face-recognition').isAllowed(name, group)) return { added: false, notAllowed: true }; } catch (_) {}
  try {
    const sharp = require('sharp');
    const idx = _load();
    const key = _safe(name);
    if (!idx[key]) idx[key] = { name, photos: [] };
    const sig = await _sig(buffer);
    const dup = idx[key].photos.find(p => Math.abs(p.ts - ts) < DUP_WINDOW_MS && p.sig && _diff(p.sig, sig) < DUP_DIFF);
    if (dup) {
      // Already here from the bot's own match — his word makes it confirmed.
      if (source === 'confirm' && dup.source !== 'confirm') {
        dup.source = 'confirm'; _save(idx);
        logger.info(`🎞️ album: ${name} — already in, now confirmed`);
      }
      return { added: false, dup: true };
    }
    if (idx[key].photos.length >= SAFETY_CAP) return { added: false, full: true };

    const month = _monthKey(ts);
    const dir = path.join(ROOT, key, month);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${ts}.jpg`;
    const img = sharp(buffer).rotate();
    fs.writeFileSync(path.join(dir, file), await img.clone().resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer());
    fs.writeFileSync(path.join(dir, `${ts}-t.jpg`), await img.clone().resize(360, 360, { fit: 'cover' }).jpeg({ quality: 72 }).toBuffer());

    idx[key].name = name;
    idx[key].photos.push({ ts, month, file, group: String(group || '').substring(0, 80), confidence, source, sig });
    idx[key].photos.sort((a, b) => b.ts - a.ts);
    _save(idx);
    logger.info(`🎞️ album: ${name} +1 (${source}, ${group || '—'})`);
    return { added: true, file };
  } catch (e) {
    logger.warn('album add: ' + (e.message || '').substring(0, 60));
    return { added: false };
  }
}

/** מי באלבום, וכמה תמונות לכל חודש. */
function summary() {
  const idx = _load();
  return Object.values(idx).map(p => {
    const months = {};
    for (const ph of p.photos) months[ph.month] = (months[ph.month] || 0) + 1;
    return {
      name: p.name, total: p.photos.length,
      months: Object.entries(months).sort((a, b) => b[0].localeCompare(a[0])).map(([k, n]) => ({ key: k, label: _monthLabel(k), count: n })),
    };
  });
}

/** תמונות של חודש אחד, עם הממוזערת כ-base64 לרשת. */
function month(name, key) {
  const p = _load()[_safe(name)];
  if (!p) return [];
  return p.photos.filter(ph => ph.month === key).map(ph => {
    let thumb = null;
    try { thumb = fs.readFileSync(path.join(ROOT, _safe(name), ph.month, ph.file.replace(/\.jpg$/, '-t.jpg'))).toString('base64'); } catch {}
    return { ts: ph.ts, group: ph.group, source: ph.source, thumb };
  });
}

function photo(name, ts) {
  const p = _load()[_safe(name)];
  const ph = p && p.photos.find(x => x.ts === ts);
  if (!ph) return null;
  try { return fs.readFileSync(path.join(ROOT, _safe(name), ph.month, ph.file)).toString('base64'); } catch { return null; }
}

/** "זו לא היא" — מוציא מהאלבום. הוא ביקש, אז נמחק באמת. */
function remove(name, ts) {
  const idx = _load();
  const key = _safe(name);
  const p = idx[key];
  const ph = p && p.photos.find(x => x.ts === ts);
  if (!ph) return false;
  for (const f of [ph.file, ph.file.replace(/\.jpg$/, '-t.jpg')]) {
    try { fs.unlinkSync(path.join(ROOT, key, ph.month, f)); } catch {}
  }
  p.photos = p.photos.filter(x => x !== ph);
  _save(idx);
  return true;
}

/**
 * באילו אלבומים התמונה הזו נמצאת (לפי חתימה, באותם ימים) — כדי שהעריכה
 * תראה "מיה ✓ · שי ✓" ולא רק את האלבום שממנו פתחו.
 */
function whoIn(name, ts) {
  const idx = _load();
  const own = idx[_safe(name)] && idx[_safe(name)].photos.find(x => x.ts === ts);
  if (!own) return [];
  const out = [];
  for (const v of Object.values(idx)) {
    const hit = (v.photos || []).find(x => x === own || (x.sig && own.sig && Math.abs(x.ts - own.ts) < 3 * 86400000 && _diff(x.sig, own.sig) < DUP_DIFF));
    if (hit) out.push(v.name);
  }
  return out;
}

/**
 * ✏️ מי בתמונה: הבוט זיהה את מיה, אבל גם שי שם (13.9). התמונה נכנסת לאלבום
 * של כל מי שסומנה, ויוצאת ממי שלא. אם לא נשאר אף שם — היא לא נמחקת; צריך
 * לפחות אחת (למחיקה יש "זו לא היא").
 */
async function setNames(name, ts, names) {
  const idx = _load();
  const own = idx[_safe(name)] && idx[_safe(name)].photos.find(x => x.ts === ts);
  if (!own) return { ok: false, error: 'התמונה לא נמצאה' };
  const want = [...new Set((names || []).map(n => String(n).trim()).filter(Boolean))];
  if (!want.length) return { ok: false, error: 'צריך לפחות שם אחד' };
  const file = path.join(ROOT, _safe(name), own.month, own.file);
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { ok: false, error: 'הקובץ חסר' }; }
  const now = whoIn(name, ts);
  const added = [], removed = [];
  for (const n of want) {
    if (now.includes(n)) continue;
    const r = await add({ name: n, buffer: buf, group: own.group || '', ts: own.ts, source: 'confirm', force: true });
    if (r.added || r.dup) added.push(n);
  }
  for (const n of now) {
    if (want.includes(n)) continue;
    const i2 = _load(); const v = i2[_safe(n)];
    const hit = v && v.photos.find(x => x.ts === own.ts || (x.sig && own.sig && Math.abs(x.ts - own.ts) < 3 * 86400000 && _diff(x.sig, own.sig) < DUP_DIFF));
    if (hit && remove(n, hit.ts)) removed.push(n);
  }
  logger.info(`🎞️ album edit: ${name} ${ts} → ${want.join('+')} (added ${added.join(',') || '—'}, removed ${removed.join(',') || '—'})`);
  return { ok: true, names: want, added, removed };
}

/** כרטיס החודש: "ספטמבר · שי · 23 תמונות, רובן מגן פיסטוק". */
function monthCard(key) {
  const out = [];
  for (const p of Object.values(_load())) {
    const list = p.photos.filter(ph => ph.month === key).sort((a, b) => a.ts - b.ts);
    if (!list.length) continue;
    const byGroup = {};
    for (const ph of list) if (ph.group) byGroup[ph.group] = (byGroup[ph.group] || 0) + 1;
    const top = Object.entries(byGroup).sort((a, b) => b[1] - a[1])[0];
    const d = ts => new Date(ts).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric' });
    out.push(`🎀 *${p.name}* — ${list.length} תמונות${top ? `, רובן מ${top[0]}` : ''}\n   הראשונה ${d(list[0].ts)} · האחרונה ${d(list[list.length - 1].ts)}`);
  }
  if (!out.length) return null;
  return `🎞️ *האלבום של ${_monthLabel(key)}*\n\n${out.join('\n\n')}\n\n_באפליקציה: פרצופים ← אלבום._`;
}

module.exports = {
  whoIn, setNames, add, summary, month, photo, remove, monthCard, _monthKey };
