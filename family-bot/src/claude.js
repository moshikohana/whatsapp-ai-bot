'use strict';
/**
 * Claude API wrapper for Family Bot.
 *
 * Smaller and simpler than Moshiko's main bot — no spokesperson/media-tracking
 * tools, no scan-history, just the core personal-assistant capabilities.
 *
 * Public API: chat(userMessage, history, context)
 *   history: array of { role, content } — last 20 exchanges max
 *   context: { client, chat, ownerChat } — passed to tool handlers
 *
 * Returns the assistant's final reply as plain text.
 */

const Anthropic = require('@anthropic-ai/sdk').default;
const { buildSystemPrompt } = require('./system-prompt');

const calendarTool = require('./tools/calendar');
const whatsappTool = require('./tools/whatsapp');
const remindersTool = require('./tools/reminders');
const memoryTool = require('./tools/memory');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-6';
const MAX_LOOPS = 30;
const MAX_OUTPUT_TOKENS = 4000;

// ── Tool schema (mirrors main bot's pattern but trimmed) ────────
const TOOLS = [
  {
    name: 'calendar',
    description: 'Google Calendar. פעולות: today (אירועי היום), week (שבוע מלא), add (הוסף — דורש אישור), delete (מחק — דורש אישור), events (X ימים קרובים).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['today', 'week', 'add', 'delete', 'events'] },
        event_text: { type: 'string', description: 'תיאור האירוע בעברית (add)' },
        index: { type: 'number', description: 'מספר האירוע (delete, 1-based)' },
        days: { type: 'number', description: 'כמה ימים קדימה (events, default 7)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'whatsapp',
    description: 'וואטסאפ — חיפוש, סיכום, קריאה בקבוצות וערוצים. *לא* לשליחת הודעות.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['chats', 'channels', 'read', 'search', 'summarize'] },
        chatName: { type: 'string', description: 'שם הצ׳אט (read/search/summarize)' },
        query: { type: 'string', description: 'מילת חיפוש (search)' },
        limit: { type: 'number' },
        sinceMinutes: { type: 'number', description: 'summarize — סנן הודעות מ-X דקות אחרונות' },
      },
      required: ['action'],
    },
  },
  {
    name: 'reminders',
    description: 'תזכורות מקומיות. פעולות: add (תזמן), list, delete.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'delete'] },
        text: { type: 'string' },
        when_minutes: { type: 'number', description: 'מתי (דקות מעכשיו)' },
        index: { type: 'number' },
      },
      required: ['action'],
    },
  },
  {
    name: 'memory',
    description: 'זיכרון אישי על המשתמש (העדפות, פרטים). פעולות: save, list, delete.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'delete'] },
        text: { type: 'string' },
        index: { type: 'number' },
      },
      required: ['action'],
    },
  },
  {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5,
  },
];

async function executeTool(name, input, context) {
  try {
    switch (name) {
      case 'calendar':  return await calendarTool.run(input, context);
      case 'whatsapp':  return await whatsappTool.run(input, context);
      case 'reminders': return await remindersTool.run(input, context);
      case 'memory':    return await memoryTool.run(input, context);
      default: return `❌ כלי לא מוכר: ${name}`;
    }
  } catch (e) {
    return `❌ שגיאה בכלי ${name}: ${e.message?.substring(0, 100)}`;
  }
}

async function callClaude(params) {
  // Single-attempt — retries handled at the loop level if needed
  return await anthropic.messages.create(params);
}

async function chat(userMessage, history = [], context = {}) {
  // Trim history to last 20 exchanges to avoid token bloat
  const trimmedHistory = history.slice(-40);
  const messages = [...trimmedHistory, { role: 'user', content: userMessage }];

  let response = await callClaude({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: buildSystemPrompt(),
    tools: TOOLS,
    messages,
  });

  console.log(`Claude stop=${response.stop_reason} tokens in/out=${response.usage?.input_tokens}/${response.usage?.output_tokens}`);

  let loops = MAX_LOOPS;
  const allMessages = [...messages];

  while (response.stop_reason === 'tool_use' && loops-- > 0) {
    const toolBlocks = response.content.filter(b => b.type === 'tool_use');
    allMessages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const tool of toolBlocks) {
      console.log(`Tool: ${tool.name} ${JSON.stringify(tool.input).substring(0, 100)}`);
      let content = await executeTool(tool.name, tool.input, context);
      content = typeof content === 'string' ? content : JSON.stringify(content);
      if (content.length > 8000) content = content.substring(0, 8000) + '\n...(קוצר)';
      const isFailure = content.startsWith('❌');
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tool.id,
        content,
        ...(isFailure ? { is_error: true } : {}),
      });
    }
    allMessages.push({ role: 'user', content: toolResults });

    response = await callClaude({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages: allMessages,
    });
    console.log(`Claude stop=${response.stop_reason} tokens in/out=${response.usage?.input_tokens}/${response.usage?.output_tokens}`);
  }

  // Collect text blocks
  let textBlocks = response.content.filter(b => b.type === 'text');

  // Recovery path: no text but loop hit cap → ask for safe summary
  if (textBlocks.length === 0 && allMessages.length > 1) {
    console.warn('No text blocks — final summary call');
    const cleanContent = (response.content || []).filter(b => b.type !== 'tool_use');
    const fallbackMessages = cleanContent.length > 0
      ? [...allMessages, { role: 'assistant', content: cleanContent }, { role: 'user', content: 'סכם בקצרה את התוצאות עד כה. אל תקרא לעוד כלים — רק טקסט.' }]
      : [...allMessages, { role: 'user', content: 'הגענו לסף הכלים. סכם את מה שכבר אספת מתוצאות הכלים בלי לקרוא לעוד כלים.' }];
    try {
      const summary = await callClaude({
        model: MODEL,
        max_tokens: 1500,
        system: buildSystemPrompt(),
        tool_choice: { type: 'none' },
        messages: fallbackMessages,
      });
      textBlocks = summary.content.filter(b => b.type === 'text');
    } catch (e) {
      console.error('summary call failed:', e.message);
    }
  }

  if (textBlocks.length > 0) {
    return textBlocks.map(b => b.text.trim()).filter(Boolean).join('\n\n');
  }
  if (loops <= 0) {
    return '⏳ הבקשה לקחה יותר כלים ממה שיכולתי לבצע בקריאה אחת. נסה לפצל אותה לחלקים קטנים.';
  }
  return '❌ לא הצלחתי לבנות תשובה. נסה לנסח אחרת.';
}

module.exports = { chat };
