'use strict';
/**
 * פרופיל הרצה — מי מפעיל את המופע הזה, ומה מותר בו.
 *
 * The bot was written for exactly one person, and it shows: OWNER_ID appears
 * 108 times across index.js. Handing a second person a copy by loosening
 * those one at a time would be 108 chances to leak Kellner material into the
 * wrong WhatsApp account. So permission lives here instead — one list, one
 * gate, read once at the top of route().
 *
 * BOT_PROFILE=owner (default)  — everything, unchanged. His instance must
 *                                behave exactly as before.
 * BOT_PROFILE=guest            — a personal assistant with none of the
 *                                political work and no reach into his PC.
 *
 * Deny-by-pattern rather than allow-by-list is deliberate: a new feature
 * should reach the guest automatically, and the things that must never reach
 * her are a short, stable, enumerable set.
 */

const PROFILE = (process.env.BOT_PROFILE || 'owner').toLowerCase();
const isGuest = PROFILE === 'guest';
const label = process.env.PROFILE_LABEL || (isGuest ? 'אורח' : 'בעלים');

// Each entry: what it is, why it's blocked, and what she can do instead.
const GUEST_BLOCKS = [
  {
    id: 'desktop-agent',
    // His personal computer. Screenshots, files, clipboard, lock — and the
    // bridge into the open development session. Nothing here is hers.
    re: /^(?:סוכן|agent)(?:\s|$)|^(?:קלוד|claude)(?:\s|$|[?:،,])/i,
    why: 'הפקודות האלה נוגעות במחשב האישי של מושיקו',
    alt: null,
  },
  {
    id: 'kellner',
    // The MK's work: alert hub, narratives, X monitoring, live radio.
    re: /^(?:מוקד|נרטיבים|נרטיב|יריבים|יריב|שידורים|סריקה|סקירה|נתח קבוצה|תקשורת|פניות|ציטוט|בדוק ציטוט|הכן אותי לראיון|הכנת ראיון|קלנר)(?:\s|$)/i,
    why: 'זה חומר העבודה של מושיקו בלשכה',
    alt: null,
  },
  {
    id: 'distribution',
    // His contact lists and anything that sends outward on his behalf.
    re: /^(?:הפצה|שלח לכולם|תפוצה|רשימת תפוצה|מעקב פניות)(?:\s|$)/i,
    why: 'רשימות ההפצה ואנשי הקשר שייכים לחשבון של מושיקו',
    alt: null,
  },
];

// Background jobs that must not run on a guest instance. Checked where each
// timer is installed, so a guest never even schedules them.
const GUEST_DISABLED_JOBS = new Set([
  'broadcast-monitor',   // live radio for Kellner mentions
  'alert-hub-digest',    // מוקד
  'daily-scan',          // political group sweep
  'trending-keywords',
  'interview-brief',
  'media-outreach',
  'x-monitor',              // daily Twitter/X + news sweep for Kellner
  'reputation-pulse',       // the listening layer
  'weekly-spokesperson',    // Sunday spokesperson report
  'group-suggestion',       // "add this political group to the daily scan?"
]);
// Deliberately still on for a guest: the morning briefing (her own calendar
// and mail), reminders, the face-match summary and the weekly photo album —
// each reads only from her own data directory.

function jobEnabled(name) {
  return isGuest ? !GUEST_DISABLED_JOBS.has(name) : true;
}

// Returns null when allowed, or { id, why, alt } when this profile may not.
function blocked(text) {
  if (!isGuest) return null;
  const t = String(text || '').trim();
  if (!t) return null;
  for (const b of GUEST_BLOCKS) if (b.re.test(t)) return b;
  return null;
}

// What she sees instead of a silent refusal — she should know the feature
// exists and simply isn't hers, not think the bot is broken.
function refusal(b) {
  return `🔒 *הפקודה הזו לא זמינה כאן.*\n\n${b.why}.\n\n_כל השאר פתוח לך — שלח *תפריט* לרשימה._`;
}

module.exports = { PROFILE, isGuest, label, blocked, refusal, jobEnabled, GUEST_DISABLED_JOBS };
