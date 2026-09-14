'use strict';
/**
 * 📻 מפת התוכניות — מה משודר בכל תחנה, בכל יום ושעה.
 *
 * The radio has a shape, and the headlines ignored it. 06:00–14:00 is
 * morning shows with a few minutes of news at every round hour; after 14:00
 * come the interview programmes, mostly political. The top-of-hour bulletin
 * repeats what is already known, so its items were being sent as "headlines
 * heard on air" — the Venice film story five times in two hours, Norway's
 * sanctions four hours after Channel 14 had it (14.9).
 *
 * Two sources, the second winning:
 *   1. SEED — the stations' own published schedules (103FM's page, 14.9).
 *      Galei Tzahal's and Kan Bet's pages cannot be read from the server.
 *   2. LEARNED — the hourly digest names the programme it heard ("ינון מגל
 *      ונדב פרי", "בוקר כאן ב (זוהר סדן)"). A name heard twice in the same
 *      weekday and hour, on different days, fills or corrects the map.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DIR = path.join(__dirname, '..', 'data', 'broadcast');
const SEEN_FILE = path.join(DIR, 'schedule-seen.json');

// [from, to, name, hosts]. Days: 0 = Sunday … 6 = Saturday.
// From 103fm.maariv.co.il/brodcasts (14.9.2026). Sunday was not on the page
// (the holiday week); it follows the ordinary weekday.
const _103_WEEK = [
  ['06:00', '07:00', 'פנינה בת צבי', ['פנינה בת צבי']],
  ['07:00', '09:00', 'עמיחי אתאלי ואילאיל שחר', ['עמיחי אתאלי', 'אילאיל שחר']],
  ['09:00', '11:00', 'ינון מגל ונדב פרי', ['ינון מגל', 'נדב פרי']],
  ['11:00', '12:00', 'אראל סג"ל ואיל ברקוביץ\'', ['אראל סג"ל', 'איל ברקוביץ\'']],
  ['12:00', '14:00', 'ברק סרי', ['ברק סרי']],
  ['14:00', '16:00', 'שניים עד ארבע', ['רון שלום', 'יואב כהן']],
  ['16:00', '17:00', 'איפה הכסף', ['ענת דוידוב']],
  ['17:00', '18:00', 'חמש בערב', ['רון קופמן', 'אריה אלדד']],
  ['18:00', '20:00', 'ספורט', []],
  ['20:00', '21:00', 'בראייה אחרת', ['שלומית תמיר']],
  ['21:00', '22:00', 'איריס קול', ['איריס קול']],
  ['22:00', '23:00', 'קרסו ובוזגלו', ['רפי קרסו', 'צ\'רלי בוזגלו']],
  ['23:00', '24:00', 'סיכום היום ב-103fm', []],
];
const SEED = {
  '103FM': {
    0: _103_WEEK, 1: _103_WEEK, 2: _103_WEEK, 3: _103_WEEK,
    4: [
      ['06:00', '07:00', 'פנינה בת צבי', ['פנינה בת צבי']],
      ['07:00', '09:00', 'ניסים משעל וענת דוידוב', ['ניסים משעל', 'ענת דוידוב']],
      ['09:00', '11:00', 'ברק סרי ואלי אוחנה', ['ברק סרי', 'אלי אוחנה']],
      ['11:00', '12:00', 'סיון כהן', ['סיון כהן']],
      ['12:00', '14:00', 'גיא פלג', ['גיא פלג']],
      ['14:00', '16:00', 'שניים עד ארבע', ['רון שלום', 'יואב כהן']],
      ['16:00', '17:00', 'איפה הכסף', ['ליאת רון', 'אריה מליניאק']],
      ['17:00', '18:00', 'רוני בר-און ומיה זיו-וולף', ['רוני בר-און', 'מיה זיו-וולף']],
      ['18:00', '20:00', 'ספורט', []],
      ['20:00', '21:00', 'רז שכניק', ['רז שכניק']],
      ['21:00', '22:00', 'איריס קול', ['איריס קול']],
      ['22:00', '24:00', '103fm השבוע', ['רעות מתתיהו-ארגון']],
    ],
    5: [
      ['06:00', '07:00', 'למבוגרים בלבד', ['דני דבורין', 'יעל חביב']],
      ['07:00', '08:00', 'בוקר של זהב', ['תומר סגיס']],
      ['08:00', '10:00', 'רון קופמן ואריה אלדד', ['רון קופמן', 'אריה אלדד']],
      ['10:00', '12:00', 'מיכל דליות', ['מיכל דליות']],
      ['12:00', '13:00', 'ד"ר מאיה רוזמן', ['מאיה רוזמן']],
      ['13:00', '15:00', 'פרופ\' רפי קרסו', ['רפי קרסו']],
      ['15:00', '16:00', 'רבקה מיכאלי', ['רבקה מיכאלי']],
      ['16:00', '24:00', 'שבת עברית', []],
    ],
  },
};

// What kind of programme, from its name, then from the hour: mornings until
// 14:00, interviews until 20:00 — the shape he described (14.9).
function _typeOf(name, hour) {
  const n = String(name || '');
  if (/ספורט/.test(n)) return 'sports';
  if (/מוזיקה|שבת עברית|שירים|להיטים/.test(n)) return 'music';
  if (/איפה הכסף|כלכל/.test(n)) return 'economy';
  if (hour >= 6 && hour < 14) return 'morning';
  if (hour >= 14 && hour < 20) return 'interviews';
  return 'evening';
}

function _il(ts) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ts)).reduce((o, x) => (o[x.type] = x.value, o), {});
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { dow, hour: +p.hour, minute: +p.minute, mins: +p.hour * 60 + +p.minute };
}
const _m = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const _norm = s => String(s || '').replace(/["'״׳\s]/g, '');

function _loadSeen() { try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch { return {}; } }
function _saveSeen(o) { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(SEEN_FILE, JSON.stringify(o, null, 1)); } catch (_) {} }

// Names come through the transcript: "אינון מגל" and "עינון מגל" are one host.
// Two names are one programme when most of their words match, first letters aside.
const _toks = s => String(s || '').replace(/["'״׳()\-–—/.,]/g, ' ').split(/\s+/)
  .filter(w => w.length >= 3 && !/^(עם|של|תוכנית|תכנית|ברדיו|FM|103FM|103|בוקר)$/i.test(w))
  .map(w => w.replace(/^[והבלמשכ](?=\S{3,})/, '').replace(/^[אעה]/, ''));
function _alike(a, b) {
  const A = _toks(a), B = _toks(b);
  if (!A.length || !B.length) return false;
  const hit = A.filter(x => B.some(y => y === x || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))))).length;
  return hit >= Math.min(2, Math.min(A.length, B.length));
}

/**
 * The programme heard on 2+ different days at this hour. Sunday–Thursday are
 * pooled — a weekday show runs all week — Friday and Saturday stand alone.
 */
function _learned(station, dow, hour) {
  const seen = _loadSeen();
  const dows = dow <= 4 ? [0, 1, 2, 3, 4] : [dow];
  const sightings = [];
  for (const d of dows) for (const [name, x] of Object.entries((seen[`${station}|${d}|${hour}`] || {}).names || {})) for (const day of x.days) sightings.push({ name, day });
  let best = null;
  for (const s of sightings) {
    const days = new Set(sightings.filter(o => _alike(o.name, s.name)).map(o => o.day));
    if (!best || days.size > best.days) best = { name: s.name, days: days.size };
  }
  return best && best.days >= 2 ? best.name : null;
}

/**
 * מה משודר ברגע נתון: מבזק השעה העגולה (00–07 בכל שעה), או תוכנית.
 * @returns {{ bulletin: boolean, name: string|null, hosts: string[], type: string, source: string }}
 */
function segmentAt(station, ts = Date.now()) {
  const t = _il(ts);
  const bulletin = t.minute < 7;
  const seed = ((SEED[station] || {})[t.dow] || []).find(([a, b]) => t.mins >= _m(a) && t.mins < _m(b));
  let learned = _learned(station, t.dow, t.hour);
  // The website's spelling when it is the same show; heard-on-air when it is
  // a different one (the site is out of date).
  if (learned && seed && (_alike(learned, seed[2]) || seed[3].some(h => _alike(learned, h)))) learned = null;
  const name = learned || (seed && seed[2]) || null;
  const hosts = seed && !learned ? seed[3] : [];
  return { bulletin, name, hosts, type: _typeOf(name, t.hour), source: learned ? 'learned' : seed ? 'seed' : 'hour' };
}

/** The hourly digest heard a programme name — noted for this weekday and hour. */
function learn(station, ts, name, confidence = 'medium') {
  if (!station || !name || confidence === 'low') return;
  // The digest writes the station its own way (גלי צה״ל / גלי צה"ל).
  try {
    const canon = require('./broadcast-monitor').STATIONS.map(s => s.name).find(n => _norm(n).toLowerCase() === _norm(station).toLowerCase());
    if (canon) station = canon;
  } catch (_) {}
  const clean = String(name).replace(/\s+/g, ' ').trim().substring(0, 80);
  if (clean.length < 3 || /לא ידוע|לא ברור|לא זוהה|ככל הנראה/.test(clean)) return;
  // The bulletin is not a programme, and a holiday special is not the schedule.
  if (/חדשות|מהדורה|מבזק|ראש השנה|לחג|החג|סוכות|פסח|כיפור|שבועות|חנוכה|פורים|יום העצמאות|יום הזיכרון/.test(clean)) return;
  const t = _il(ts);
  const day = new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const all = _loadSeen();
  const k = `${station}|${t.dow}|${t.hour}`;
  const e = all[k] || (all[k] = { names: {} });
  // The same programme written two ways is one: matched without quotes and spaces.
  const known = Object.keys(e.names).find(n => _norm(n) === _norm(clean) || _norm(n).includes(_norm(clean)) || _norm(clean).includes(_norm(n)));
  const slot = e.names[known || clean] || (e.names[known || clean] = { days: [] });
  if (!slot.days.includes(day)) {
    slot.days = [...slot.days, day].slice(-8);
    _saveSeen(all);
    if (slot.days.length === 2) logger.info(`📻 schedule: ${station} ${['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'][t.dow]}' ${t.hour}:00 = "${known || clean}"`);
  }
}

/** Hosts of the programme on air — a host is never the "speaker" of a headline. */
function hostsAt(station, ts) { return segmentAt(station, ts).hosts; }

module.exports = { segmentAt, learn, hostsAt, SEED };
