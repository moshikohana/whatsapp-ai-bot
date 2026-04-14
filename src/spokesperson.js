'use strict';
const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '..', 'bot-memory.json');

// Keywords for matching memories to Kellner context
const KELLNER_KEYWORDS = ['קלנר', 'דובר', 'ח"כ', 'ליכוד', 'ראיון', 'תקשורת', 'ערוץ', 'פנייה', 'תגובה', 'חקיקה', 'כנסת', 'כתב', 'עורך', 'מפיק'];
const POSITION_KEYWORDS = ['עמדות', 'הישגי', 'חקיקה', 'תפקידים', 'מאבק', 'חוק'];
const CONTACT_KEYWORDS = ['אנשי קשר', 'טלפון', '📱', 'ערוץ 14', 'קול ברמה', 'קשת', 'ערוץ הכנסת'];
const TEMPLATE_KEYWORDS = ['תבנית', 'נוסח', 'פנייה'];

function loadMemories() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

// ─── Extract Kellner-specific context from all memories ──────────
function getKellnerContext() {
  const memories = loadMemories();
  const context = {
    positions: [],
    achievements: [],
    contacts: [],
    templates: [],
    roles: [],
    other: [],
  };

  for (const m of memories) {
    const text = m.text.toLowerCase();

    // Classify memory
    if (POSITION_KEYWORDS.some(k => text.includes(k)) && text.includes('קלנר')) {
      if (text.includes('הישגי') || text.includes('חקיקה')) {
        context.achievements.push(m.text);
      } else if (text.includes('תפקידים') || text.includes('יו"ר') || text.includes('חבר ועד')) {
        context.roles.push(m.text);
      } else {
        context.positions.push(m.text);
      }
    } else if (TEMPLATE_KEYWORDS.some(k => text.includes(k))) {
      context.templates.push(m.text);
    } else if (CONTACT_KEYWORDS.some(k => text.includes(k)) && KELLNER_KEYWORDS.some(k => text.includes(k))) {
      context.contacts.push(m.text);
    } else if (KELLNER_KEYWORDS.some(k => text.includes(k))) {
      context.other.push(m.text);
    }
  }

  return context;
}

// ─── Match topic to relevant positions ───────────────────────────
function matchTopicToPositions(topic) {
  const ctx = getKellnerContext();
  const topicLower = topic.toLowerCase();

  // Topic keyword mapping
  const topicMap = {
    'בג"ץ': ['בג"ץ', 'בגץ', 'משפט', 'חקירה', 'שופט'],
    'ביטחון': ['ביטחון', 'טרור', 'מלחמה', 'צבא', 'חמאס', 'איראן', 'נשק'],
    'התיישבות': ['התיישבות', 'ריבונות', 'יו"ש', 'יהודה', 'שומרון', 'נגב', 'גליל', 'סכנין', 'בניה'],
    'תקשורת': ['תקשורת', 'ערוץ 14', 'שידור', 'ג\'זירה', 'עידן פלוס'],
    'ריבונות': ['ריבונות', 'זר', 'אונרא', 'unrwa', 'עמותות', 'מימון', 'בריאות עולמי'],
    'חקיקה': ['חוק', 'חקיקה', 'קצבאות', 'ארנונה', 'פנסיה'],
  };

  const relevantPositions = [];
  const relevantAchievements = [];

  // Find matching category
  for (const [category, keywords] of Object.entries(topicMap)) {
    if (keywords.some(k => topicLower.includes(k))) {
      // Pull all positions/achievements that mention these keywords
      for (const pos of [...ctx.positions, ...ctx.achievements]) {
        if (keywords.some(k => pos.toLowerCase().includes(k))) {
          relevantPositions.push(pos);
        }
      }
    }
  }

  // If no specific match, return all positions
  if (relevantPositions.length === 0) {
    relevantPositions.push(...ctx.positions, ...ctx.achievements);
  }

  return {
    positions: [...new Set(relevantPositions)],
    templates: ctx.templates,
    contacts: ctx.contacts,
    roles: ctx.roles,
  };
}

// ─── Format context for Claude ───────────────────────────────────
function formatContextForClaude() {
  const ctx = getKellnerContext();
  let text = '📋 *הקשר דוברות — ח"כ אריאל קלנר (ליכוד):*\n\n';

  if (ctx.achievements.length) {
    text += '🏛️ *הישגי חקיקה:*\n' + ctx.achievements.join('\n\n') + '\n\n';
  }
  if (ctx.positions.length) {
    text += '📌 *עמדות מפתח:*\n' + ctx.positions.join('\n\n') + '\n\n';
  }
  if (ctx.roles.length) {
    text += '👔 *תפקידים:*\n' + ctx.roles.join('\n\n') + '\n\n';
  }
  if (ctx.contacts.length) {
    text += '📇 *אנשי קשר תקשורת:*\n' + ctx.contacts.join('\n\n') + '\n\n';
  }
  if (ctx.templates.length) {
    text += '📝 *תבניות פנייה:*\n' + ctx.templates.join('\n\n') + '\n\n';
  }
  if (ctx.other.length) {
    text += '📎 *נוסף:*\n' + ctx.other.join('\n\n') + '\n\n';
  }

  return text.trim();
}

// ─── Build morning briefing search queries ───────────────────────
function getBriefingSearchQueries(extraTopics = []) {
  const base = [
    'ח"כ אריאל קלנר חדשות היום 2026',
    'סדר יום כנסת ישראל ועדות היום',
    'חדשות ביטחון ישראל היום',
    'בג"ץ ליכוד חדשות היום',
  ];
  const social = [
    'אריאל קלנר site:x.com',
    'אריאל קלנר site:facebook.com',
  ];
  const extra = extraTopics.map(t => `${t} חדשות ישראל 2026`);
  return [...base, ...social, ...extra];
}

module.exports = {
  getKellnerContext,
  matchTopicToPositions,
  formatContextForClaude,
  getBriefingSearchQueries,
};
