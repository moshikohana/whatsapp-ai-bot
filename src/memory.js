'use strict';
const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '..', 'bot-memory.json');
const CONTEXT_FILE = path.join(__dirname, '..', 'bot-context.json');

// ─── Memory System ──────────────────────────────────────────────

function loadMemories() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('שגיאת זיכרון:', err.message);
  }
  return [];
}

function saveMemories(memories) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2), 'utf-8');
}

function addMemory(text, category = 'כללי') {
  const memories = loadMemories();
  // Check for duplicates — don't save if very similar text already exists
  const isDuplicate = memories.some(m =>
    m.text === text || (m.text.includes(text) && text.length > 10)
  );
  if (isDuplicate) return { count: memories.length, duplicate: true };

  memories.push({
    text,
    category,
    date: new Date().toISOString(),
    usageCount: 0,
  });
  saveMemories(memories);
  return { count: memories.length, duplicate: false };
}

function deleteMemory(index) {
  const memories = loadMemories();
  if (index < 1 || index > memories.length) throw new Error(`זיכרון מספר ${index} לא קיים`);
  const removed = memories.splice(index - 1, 1)[0];
  saveMemories(memories);
  return removed;
}

function updateMemory(index, newText) {
  const memories = loadMemories();
  if (index < 1 || index > memories.length) throw new Error(`זיכרון מספר ${index} לא קיים`);
  memories[index - 1].text = newText;
  memories[index - 1].date = new Date().toISOString();
  saveMemories(memories);
  return memories[index - 1];
}

function getMemoriesForPrompt() {
  const memories = loadMemories();
  if (!memories.length) return '';

  // Group by category
  const groups = {};
  memories.forEach((m, i) => {
    const cat = m.category || 'כללי';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({ ...m, index: i + 1 });
  });

  const catEmoji = {
    'תיקון': '🔧',
    'העדפה': '💡',
    'מידע_אישי': '👤',
    'הנחיה': '📌',
    'כללי': '📝',
  };

  let text = '\n\n🧠 *הזיכרון שלך — דברים שמושיקו לימד אותך (חובה להתחשב!):*\n';
  for (const [cat, items] of Object.entries(groups)) {
    const emoji = catEmoji[cat] || '📝';
    text += `\n${emoji} *${cat}:*\n`;
    items.forEach(m => {
      text += `  ${m.index}. ${m.text}\n`;
    });
  }
  return text;
}

function listMemories() {
  const memories = loadMemories();
  if (!memories.length) return 'אין זיכרונות שמורים עדיין.';

  const catEmoji = {
    'תיקון': '🔧',
    'העדפה': '💡',
    'מידע_אישי': '👤',
    'הנחיה': '📌',
    'כללי': '📝',
  };

  return memories.map((m, i) => {
    const emoji = catEmoji[m.category] || '📝';
    const date = new Date(m.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
    return `${i + 1}. ${emoji} ${m.text} (${date})`;
  }).join('\n');
}

// ─── Conversation Context (persists across restarts) ────────────

function loadContext() {
  try {
    if (fs.existsSync(CONTEXT_FILE)) {
      return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
    }
  } catch {}
  return { lastTopics: [], totalMessages: 0, firstSeen: null, lastSeen: null };
}

function saveContext(ctx) {
  try {
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2), 'utf-8');
  } catch {}
}

function updateContext(userMessage, botReply) {
  const ctx = loadContext();
  ctx.totalMessages = (ctx.totalMessages || 0) + 1;
  if (!ctx.firstSeen) ctx.firstSeen = new Date().toISOString();
  ctx.lastSeen = new Date().toISOString();

  // Track recent topics (last 5)
  if (!ctx.lastTopics) ctx.lastTopics = [];
  if (userMessage.length > 5) {
    ctx.lastTopics.push({
      text: userMessage.substring(0, 100),
      date: new Date().toISOString(),
    });
    if (ctx.lastTopics.length > 5) ctx.lastTopics.shift();
  }

  saveContext(ctx);
  return ctx;
}

function getContextForPrompt() {
  const ctx = loadContext();
  if (!ctx.totalMessages) return '';

  let text = '\n\n📊 *הקשר:*\n';
  text += `סה"כ הודעות: ${ctx.totalMessages}\n`;

  if (ctx.lastTopics && ctx.lastTopics.length > 0) {
    text += 'נושאים אחרונים: ';
    text += ctx.lastTopics.map(t => t.text.substring(0, 30)).join(', ') + '\n';
  }

  return text;
}

// ─── Failed Tools Tracking ──────────────────────────────────────

const failedTools = new Set();

function markToolFailed(toolName) {
  failedTools.add(toolName);
}

function getFailedToolsNote() {
  if (!failedTools.size) return '';
  return `\n\n🚫 *כלים שנכשלו בשיחה הזו (אל תציע אותם!):* ${[...failedTools].join(', ')}\n`;
}

function clearFailedTools() {
  failedTools.clear();
}

module.exports = {
  addMemory, deleteMemory, updateMemory, getMemoriesForPrompt, listMemories,
  updateContext, getContextForPrompt,
  markToolFailed, getFailedToolsNote, clearFailedTools,
};
