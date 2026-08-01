'use strict';
/**
 * Response engine (Option 2) — consistent-voice rapid response + journalist
 * targeting. Given a topic/attack, it:
 *   • retrieves Kellner's known positions (spokesperson) + past approved
 *     quotes on similar topics (quote-archive) — RAG grounding,
 *   • drafts a response IN HIS VOICE, grounded + consistency-checked,
 *   • suggests which journalists to pitch (media-tracker) with an angle.
 * Approved drafts are saved back to the quote-archive → the corpus grows and
 * future responses get more consistent.
 */

const logger = require('./logger');

async function buildResponse(topic) {
  const sp = require('./spokesperson');
  const qa = require('./quote-archive');
  const mt = require('./media-tracker');
  const { completeText } = require('./claude');

  // RAG grounding
  const match = sp.matchTopicToPositions(topic) || {};
  const positions = (match.positions || []).slice(0, 8);
  const positionsStr = positions.length ? positions.map(p => '• ' + p).join('\n') : '(אין עמדות מתועדות בנושא)';

  const past = qa.findSimilar(topic, 120) || [];
  const pastStr = past.length
    ? past.slice(0, 5).map(q => `• [${new Date(q.date).toLocaleDateString('he-IL')}] "${(q.text || '').substring(0, 140)}"`).join('\n')
    : 'אין ציטוטים קודמים בארכיון בנושא זה.';

  const contacts = mt.getBulkDraftContext() || []; // [{name, outlet, phone}]
  const journalistsStr = contacts.length ? contacts.map(c => `${c.name} (${c.outlet})`).join('\n') : '(אין אנשי קשר)';

  const prompt =
`אתה יועץ תקשורת בכיר לח"כ *אריאל קלנר* (הליכוד). נסח *טיוטת תגובה/אמירה תקשורתית* בנושא:
"${topic}"

עגן את התגובה בעמדות ובאמירות הקודמות שלו — *אל תסתור אותן*:

עמדות מתועדות:
${positionsStr}

אמירות קודמות (ארכיון):
${pastStr}

קול: חד, ישיר, ציוני-לאומי, בגוף ראשון של קלנר. 2-4 משפטים. בלי סיסמאות ריקות — מסר ממוקד.

כתבים זמינים לפנייה:
${journalistsStr}

החזר בעברית בדיוק בפורמט הזה:

📝 *טיוטה:*
[הציטוט/התגובה בגוף ראשון]

⚠️ *עקביות:* [עקבי עם עמדותיו הידועות / או: אזהרה קונקרטית אם יש סתירה לאמירה קודמת]

🎯 *זווית ("למה עכשיו"):* [משפט אחד]

📰 *למי לפנות (2-3, מהרשימה בלבד):*
• <שם> (<מקור>) — <זווית מותאמת קצרה>`;

  const draft = await completeText(prompt, { maxTokens: 1300 });
  return { text: draft || '⚠️ ניסוח נכשל — נסה שוב.', positions, past, contacts };
}

// Save an approved draft-text back to the archive (bootstraps the corpus).
function saveApproved(topic, draftText) {
  try {
    const qa = require('./quote-archive');
    // extract just the quote body from the formatted draft, if present
    let text = draftText || '';
    const m = text.match(/📝[^\n]*\n+([\s\S]*?)(?:\n+⚠️|\n+🎯|\n+📰|$)/);
    if (m && m[1]) text = m[1].trim();
    return qa.addQuote({ topic, text, type: 'response', tags: [] });
  } catch (e) { logger.warn?.('saveApproved: ' + e.message); return null; }
}

module.exports = { buildResponse, saveApproved };
