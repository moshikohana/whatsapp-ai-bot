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

// In multi-tenant mode, the tenant's config + saveConfig come from context.
// Caller passes ctx = { tenant, chat, ... }.

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
async function maybeHandle(text, ctx) {
  const tenant = ctx?.tenant;
  if (!tenant) return null;
  const cfg = tenant.config || {};

  // Tenants without a botName yet — they need name/gender wizard FIRST.
  if (!cfg.botName || !cfg.userGender) {
    return await _onboardingWizard(text, tenant);
  }

  const t = text.trim();

  // "תפריט" / "הכרות" / "/help" → main menu
  if (/^(תפריט|הכרות|\/help|\/menu|menu|help|מה אתה יודע|מה אתה יכול|איך זה עובד)/i.test(t)) {
    return menuMessage(cfg);
  }

  // "חבר יומן" / "חיבור יומן" / "google" → return OAuth URL
  if (/^(חבר(\s+ל)?\s*יומן|חיבור\s+יומן|חבר\s+google|google|gmail|connect\s+calendar)/i.test(t)) {
    return calendarConnectMessage(tenant);
  }

  // "הגדרות" / "settings" → status + actions
  if (/^(הגדרות|הגדרה|settings|ניהול)/i.test(t)) {
    return settingsMessage(tenant);
  }

  // "1" .. "6" — show category details
  if (/^[1-6]$/.test(t)) {
    const det = categoryDetails(cfg, t);
    if (det) return det;
  }

  // "סגור" / "סיים" / "exit" → close menu
  if (/^(סגור|סיים|exit|close|done)/i.test(t)) {
    if (!cfg.firstRunCompleted) tenant.saveConfig({ firstRunCompleted: true });
    return `סגרתי את התפריט. ${genderWord(cfg, 'תכתוב', 'תכתבי')} כל בקשה רגילה ואני אבין. 😊`;
  }

  // First message after install that ISN'T explicit menu — still suggest tour
  if (!cfg.firstRunCompleted && /^(היי|הי|שלום|בוקר טוב|ערב טוב|אהלן|מה קורה)/i.test(t)) {
    tenant.saveConfig({ firstRunCompleted: true });
    return `${genderWord(cfg, 'אהלן', 'אהלן')} ${cfg.firstName || ''}! 😊\n\nאני *${cfg.botName}*, ובאתי לעזור. רוצה שאעבור אתך הכרות מהירה? ${genderWord(cfg, 'תכתוב', 'תכתבי')} *"תפריט"*.\nאו תכתוב בקשה רגילה ואני אבין.`.trim();
  }

  return null;  // let Claude handle it
}

// ── First-time onboarding (bot name + gender + firstName) ──────
// Runs INLINE in the WhatsApp chat — no installer wizard, since the user
// never touches a computer. Three simple text exchanges:
//   1. "מה שם שתרצה לתת לי?" → save botName
//   2. "מתי תרצה שאפנה אליך — זכר/נקבה?" → save userGender
//   3. "איך לקרוא לך? (השם הפרטי שלך)" → save firstName, finish.
async function _onboardingWizard(text, tenant) {
  const cfg = tenant.config || {};
  const t = (text || '').trim();

  if (!cfg.botName) {
    // First message → ask for bot name
    if (!cfg._askedBotName) {
      tenant.saveConfig({ _askedBotName: true });
      return [
        `👋 *ברוכים הבאים!*`,
        ``,
        `אני העוזר האישי שלך ב-WhatsApp. לפני שמתחילים, רגע של הכרות.`,
        ``,
        `🤖 *איך תרצה לקרוא לי?*`,
        `שלח שם (לדוגמה: "תומר", "ליה", "מקס").`,
      ].join('\n');
    }
    // Validate the bot name
    if (t.length < 2 || t.length > 20) return '⚠️ השם חייב להיות 2-20 תווים. נסה שוב.';
    tenant.saveConfig({ botName: t });
    return [
      `✨ נחמד להכיר! אני *${t}*.`,
      ``,
      `👤 *איך תרצה שאפנה אליך?* (זה משפיע על איך אני מדבר אליך — לשון זכר/נקבה)`,
      ``,
      `שלח: *זכר* או *נקבה*.`,
    ].join('\n');
  }

  if (!cfg.userGender) {
    if (/^(זכר|גבר|m|male)/i.test(t)) {
      tenant.saveConfig({ userGender: 'male', _askedFirstName: true });
      return `מעולה אחי! 💪\n\n👋 *מה השם הפרטי שלך?* (כדי שאוכל לפנות אליך באופן אישי)\n\nאו שלח *"דלג"* אם לא רוצה לתת.`;
    }
    if (/^(נקבה|אישה|f|female)/i.test(t)) {
      tenant.saveConfig({ userGender: 'female', _askedFirstName: true });
      return `מעולה אחותי! 💪\n\n👋 *מה השם הפרטי שלך?* (כדי שאוכל לפנות אלייך באופן אישי)\n\nאו שלחי *"דלג"* אם לא רוצה לתת.`;
    }
    return '⚠️ תשובה לא ברורה. שלח *זכר* או *נקבה*.';
  }

  if (cfg._askedFirstName && !cfg.firstName && !cfg._finishedFirstName) {
    if (/^(דלג|skip)/i.test(t)) {
      tenant.saveConfig({ _finishedFirstName: true });
    } else if (t.length >= 1 && t.length <= 30) {
      tenant.saveConfig({ firstName: t, _finishedFirstName: true });
    } else {
      return '⚠️ השם חייב להיות 1-30 תווים. נסה שוב או שלח "דלג".';
    }
    const updated = tenant.config;
    return [
      `🎉 *מוכן!*`,
      ``,
      `אני *${updated.botName}*, ${updated.firstName ? `נעים מאוד ${updated.firstName}` : 'יאללה מתחילים'}.`,
      ``,
      `${genderWord(updated, 'תכתוב', 'תכתבי')} *"תפריט"* כדי שאסביר מה אני יודע לעשות.`,
      `או פשוט שלח לי בקשה רגילה ואני אבין.`,
    ].join('\n');
  }

  return null; // already onboarded — let Claude handle
}

// ── "חבר יומן" → return live OAuth URL for the user to click ──
function _publicHost() {
  return process.env.FAMILY_BOT_PUBLIC_HOST ||
         process.env.FAMILY_BOT_PUBLIC_IP   ||
         `http://localhost:${process.env.FAMILY_BOT_PORT || 3001}`;
}

function calendarConnectMessage(tenant) {
  const cfg = tenant.config || {};
  if (cfg.googleConnected && cfg.googleEmail) {
    return [
      `✅ *Google Calendar כבר מחובר!*`,
      `📧 חשבון: ${cfg.googleEmail}`,
      ``,
      `${genderWord(cfg, 'תוכל', 'תוכלי')} עכשיו לשאול אותי:`,
      `• "מה יש לי היום?"`,
      `• "מה בלוז השבוע?"`,
      `• "תקבע פגישה מחר ב-15:00"`,
      ``,
      `_אם תרצה להתחבר לחשבון Google אחר, שלח "נתק יומן" קודם._`,
    ].join('\n');
  }
  if (cfg.googleConnected) {
    return [
      `✅ *Google Calendar מחובר!*`,
      ``,
      `${genderWord(cfg, 'נסה', 'נסי')}: "מה יש לי היום?"`,
    ].join('\n');
  }
  const host = _publicHost().replace(/\/+$/, '');
  const url = `${host}/oauth/start/${tenant.id}`;
  return [
    `📅 *חיבור Google Calendar*`,
    ``,
    `${genderWord(cfg, 'לחץ', 'לחצי')} על הקישור הבא, בחר${cfg.userGender === 'female' ? 'י' : ''} חשבון Google ואשר${cfg.userGender === 'female' ? 'י' : ''} את ההרשאות:`,
    ``,
    url,
    ``,
    `אחרי האישור — חוזר${cfg.userGender === 'female' ? 'ת' : ''} לכאן ל-WhatsApp ותגיד${cfg.userGender === 'female' ? 'י' : ''} לי משהו כמו *"מה יש לי היום?"*.`,
    ``,
    `_הקישור פעיל 10 דקות, החיבור פעם אחת בלבד._`,
  ].join('\n');
}

// ── "הגדרות" → status overview + quick links ──
function settingsMessage(tenant) {
  const cfg = tenant.config || {};
  const bot = cfg.botName || 'הבוט';
  const calStatus = cfg.googleConnected
    ? `✅ מחובר${cfg.googleEmail ? ` (${cfg.googleEmail})` : ''}`
    : `🔴 לא מחובר — שלח *"חבר יומן"*`;
  return [
    `⚙️ *הגדרות — ${bot}*`,
    ``,
    `👤 *פרופיל:*`,
    `• שם: ${cfg.firstName || '(לא הוגדר)'}`,
    `• מגדר: ${cfg.userGender === 'female' ? 'נקבה' : 'זכר'}`,
    `• שם הבוט: ${cfg.botName}`,
    ``,
    `🔌 *חיבורים:*`,
    `• 📅 Google Calendar: ${calStatus}`,
    ``,
    `💡 *פקודות שימושיות:*`,
    `• *"תפריט"* — מה אני יודע לעשות`,
    `• *"חבר יומן"* — להתחבר ל-Google Calendar`,
    `• *"מה אתה זוכר עליי?"* — להציג זיכרון אישי`,
  ].join('\n');
}

module.exports = { welcomeMessage, menuMessage, categoryDetails, maybeHandle, calendarConnectMessage, settingsMessage };
