'use strict';
/**
 * In-WhatsApp first-run experience.
 *
 * After the installer wizard finishes, the user opens WhatsApp and sends
 * their first message. The bot responds with a welcome that personalizes
 * to bot-name + gender, then walks the user through capability categories.
 *
 * Uses simple text replies (no polls/buttons — those need Business API).
 * The user types numbers (1, 2, 3...) or keywords ("יומן", "תפריט", "סגור")
 * to navigate.
 */

const config = require('./config');

// ── State per session (kept in memory; resets if bot restarts) ──
const sessions = new Map();  // chatId → { stage, idx }

function genderWord(cfg, masc, fem) {
  return cfg.userGender === 'female' ? fem : masc;
}

function ownerName(cfg) {
  if (cfg.firstName) return cfg.firstName;
  return genderWord(cfg, 'אחי', 'אחותי');
}

// ── Welcome message — sent by bot.js on first 'ready' ───────────
function welcomeMessage(cfg) {
  const bot = cfg.botName || 'הבוט';
  const greet = genderWord(cfg, 'אחי', 'אחותי');
  const verb_speak = genderWord(cfg, 'תכתוב', 'תכתבי');
  const verb_try = genderWord(cfg, 'תנסה', 'תנסי');
  return [
    `🎉 *${cfg.firstName || greet}, ההתקנה הסתיימה!*`,
    ``,
    `אני *${bot}* — העוזר האישי שלך ב-WhatsApp.`,
    `נשמח שתכיר אותי טוב לפני שמתחילים.`,
    ``,
    `${verb_speak} *"תפריט"* או *"הכרות"* כדי שאסביר לך מה אני יודע לעשות.`,
    `${verb_try} גם פשוט לכתוב לי בקשה רגילה — אני אבין.`,
  ].join('\n');
}

// ── Main category menu ─────────────────────────────────────────
function menuMessage(cfg) {
  const bot = cfg.botName || 'הבוט';
  return [
    `📋 *מה אני יודע לעשות?*`,
    ``,
    `*${bot}* יכול ל:`,
    ``,
    `*1*. 📅 *יומן Google* — לראות פגישות, להוסיף אירועים`,
    `*2*. 💬 *וואטסאפ חכם* — לסכם קבוצות וערוצים`,
    `*3*. 🎤 *הודעות קוליות* — תמלל ותשובות`,
    `*4*. 🌐 *חיפוש ברשת* — מענה עם מידע עדכני`,
    `*5*. 🔔 *תזכורות* — לא תפספס דבר`,
    `*6*. 🧠 *זיכרון אישי* — לומד את ההעדפות שלך`,
    ``,
    `${genderWord(cfg, 'שלח', 'שלחי')} מספר *1-6* לפרטים, או *"סגור"* כדי לסיים.`,
    `אפשר גם פשוט להתחיל לכתוב לי בקשות רגילות.`,
  ].join('\n');
}

// ── Category details ───────────────────────────────────────────
function categoryDetails(cfg, n) {
  const me = cfg.botName || 'הבוט';
  const askVerb = genderWord(cfg, 'שאל אותי', 'שאלי אותי');
  const exampleVerb = genderWord(cfg, 'נסה', 'נסי');
  switch (n) {
    case '1': return [
      `📅 *יומן Google*`,
      ``,
      `${askVerb} שאלות על היומן או הוסף אירועים בעברית פשוטה.`,
      ``,
      `*דוגמאות:*`,
      `• "מה יש לי היום?"`,
      `• "מה בלוז השבוע?"`,
      `• "תקבע לי פגישה מחר ב-15:00 עם דני"`,
      `• "תזכיר לי לאסוף את הילד ב-17:00"`,
      `• "תמחק את הפגישה הראשונה"`,
      ``,
      `${exampleVerb} עכשיו: *"מה יש לי היום?"*`,
      ``,
      `🔙 שלח *"תפריט"* לחזרה.`,
    ].join('\n');

    case '2': return [
      `💬 *וואטסאפ — קבוצות וערוצים*`,
      ``,
      `אני יכול לסכם תוכן מקבוצות שאתה חבר בהן ומערוצי WhatsApp שאתה רשום אליהם.`,
      ``,
      `*דוגמאות:*`,
      `• "סכם את הקבוצה X מהבוקר"`,
      `• "תראה לי את הערוצי וואטסאפ שלי"`,
      `• "תחפש 'בריאות' בקבוצות"`,
      `• "תראה לי 10 הודעות אחרונות מ-[שם איש קשר]"`,
      ``,
      `🔙 שלח *"תפריט"* לחזרה.`,
    ].join('\n');

    case '3': return [
      `🎤 *הודעות קוליות*`,
      ``,
      `${genderWord(cfg, 'תשלח', 'תשלחי')} לי הודעה קולית (PTT) ואני:`,
      `• אתמלל אותה לטקסט`,
      `• אבין מה ביקשת — ואענה כמו לטקסט רגיל`,
      `• אם זה משימה — אבצע (לפי אישור)`,
      ``,
      `*דוגמאות:*`,
      `• הקלטה: "תזכיר לי לקנות חלב בערב" → תזכורת + אישור`,
      `• הקלטה: "מה יש לי בלוז מחר?" → סקירת היום`,
      ``,
      `🔙 שלח *"תפריט"* לחזרה.`,
    ].join('\n');

    case '4': return [
      `🌐 *חיפוש ברשת*`,
      ``,
      `${askVerb} כל שאלה ואני אחפש מידע עדכני באינטרנט.`,
      ``,
      `*דוגמאות:*`,
      `• "כמה דולר עולה היום?"`,
      `• "מה יש בחדשות?"`,
      `• "מה התחזית למחר ב-תל אביב?"`,
      `• "מתי המשחק של מכבי?"`,
      ``,
      `🔙 שלח *"תפריט"* לחזרה.`,
    ].join('\n');

    case '5': return [
      `🔔 *תזכורות*`,
      ``,
      `${genderWord(cfg, 'תגיד', 'תגידי')} לי מתי ומה — ואני אזכיר לך.`,
      ``,
      `*דוגמאות:*`,
      `• "תזכיר לי בעוד שעה לקרוא לאמא"`,
      `• "תזכיר לי מחר ב-7 בבוקר לקחת תרופה"`,
      `• "תראה לי את התזכורות הקרובות"`,
      `• "בטל תזכורת מספר 2"`,
      ``,
      `🔙 שלח *"תפריט"* לחזרה.`,
    ].join('\n');

    case '6': return [
      `🧠 *זיכרון אישי*`,
      ``,
      `${genderWord(cfg, 'תגיד', 'תגידי')} לי "תזכור ש..." ואני אזכור.`,
      ``,
      `*דוגמאות:*`,
      `• "תזכור שאני אלרגי לבוטנים"`,
      `• "תזכור שאני אוהב קפה שחור בלי סוכר"`,
      `• "תזכור שיום הולדת של אמא ב-15 ביוני"`,
      `• "מה אתה זוכר עליי?"`,
      ``,
      `🔙 שלח *"תפריט"* לחזרה.`,
    ].join('\n');

    default: return null;
  }
}

// ── Main entry: returns reply text or null ─────────────────────
async function maybeHandle(text, _ctx) {
  const cfg = config.read();
  if (!cfg) return null;

  const t = text.trim();

  // "תפריט" / "הכרות" / "/help" / "מה אתה יודע" → main menu
  if (/^(תפריט|הכרות|\/help|\/menu|menu|help|מה אתה יודע|מה אתה יכול|איך זה עובד)/i.test(t)) {
    config.write({ ...cfg, firstRunCompleted: false }); // not strictly needed but consistent
    return menuMessage(cfg);
  }

  // "1" .. "6" — show category details
  if (/^[1-6]$/.test(t)) {
    const det = categoryDetails(cfg, t);
    if (det) return det;
  }

  // "סגור" / "סיים" / "exit" → close menu (silent — just don't intercept)
  if (/^(סגור|סיים|exit|close|done)/i.test(t)) {
    if (!cfg.firstRunCompleted) {
      config.write({ ...cfg, firstRunCompleted: true });
    }
    return `סגרתי את התפריט. ${genderWord(cfg, 'תכתוב', 'תכתבי')} כל בקשה רגילה ואני אבין. 😊`;
  }

  // First message after install that ISN'T explicit menu — still suggest tour
  if (!cfg.firstRunCompleted && /^(היי|הי|שלום|בוקר טוב|ערב טוב|אהלן|מה קורה)/i.test(t)) {
    config.write({ ...cfg, firstRunCompleted: true });
    return `${genderWord(cfg, 'אהלן', 'אהלן')} ${cfg.firstName || ''}! 😊\n\nאני *${cfg.botName}*, ובאתי לעזור. רוצה שאעבור אתך הכרות מהירה? ${genderWord(cfg, 'תכתוב', 'תכתבי')} *"תפריט"*.\nאו תכתוב בקשה רגילה ואני אבין.`.trim();
  }

  return null;  // let Claude handle it
}

module.exports = { welcomeMessage, menuMessage, categoryDetails, maybeHandle };
