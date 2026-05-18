'use strict';
/**
 * WhatsApp tool — read-only access to the user's chats + channels.
 * Reuses the same merge logic as Moshiko's main bot.
 */

const Anthropic = require('@anthropic-ai/sdk').default;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Lazy-import Channel to avoid heavy load on require-time
let _Channel = null;
function getChannelClass() {
  if (!_Channel) _Channel = require('whatsapp-web.js/src/structures/Channel');
  return _Channel;
}

// ── Hebrew normalization (same logic as Moshiko's bot) ──────────
function normalizeHe(s) {
  return (s || '')
    .normalize('NFC')
    .replace(/[֑-ֽֿ-ׇ]/g, '')
    .replace(/[​-‏‪-‮⁦-⁩]/g, '')
    .replace(/[״׳"']/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function findChatByName(chats, query) {
  const q = normalizeHe(query);
  if (!q) return null;
  const idx = chats.map(c => ({ chat: c, norm: normalizeHe(c.name || c.pushname || '') }))
    .filter(x => x.norm);
  const exact = idx.find(x => x.norm === q);
  if (exact) return exact.chat;
  const prefix = idx.filter(x => x.norm.startsWith(q)).sort((a, b) => a.norm.length - b.norm.length)[0];
  if (prefix) return prefix.chat;
  const inc = idx.filter(x => x.norm.includes(q)).sort((a, b) => a.norm.length - b.norm.length)[0];
  return inc ? inc.chat : null;
}

// ── Safe channel fetch — works around wwebjs constructor bug ───
async function safeGetChannels(client) {
  let raw;
  try {
    raw = await client.pupPage.evaluate(async () => {
      try { return await window.WWebJS.getChannels(); } catch { return null; }
    });
  } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const Channel = getChannelClass();
  const out = [];
  for (const r of raw) {
    try {
      if (!r.channelMetadata) r.channelMetadata = {};
      out.push(new Channel(client, r));
    } catch {}
  }
  return out;
}

async function getAllChatsAndChannels(client) {
  const chats = await client.getChats();
  const channels = await safeGetChannels(client);
  return [...chats, ...channels];
}

// ── Fetch messages safely (simpler than main bot — single strategy) ──
async function fetchMessages(chat, limit) {
  try {
    return await chat.fetchMessages({ limit });
  } catch (e) {
    return [];
  }
}

// ── Public actions ─────────────────────────────────────────────
async function actionChats({ limit = 20 }, { client }) {
  const chats = await getAllChatsAndChannels(client);
  const slice = chats.slice(0, Math.min(limit, 50));
  let text = `💬 *שיחות אחרונות (${slice.length}/${chats.length}):*\n\n`;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    const n = c.name || c.pushname || c.id?.user || '(ללא שם)';
    const icon = c.isChannel ? '📢' : (c.isGroup ? '👥' : '💬');
    const unread = c.unreadCount > 0 ? ` 🔴${c.unreadCount}` : '';
    text += `${i + 1}. ${icon} ${n}${unread}\n`;
  }
  return text.trim();
}

async function actionChannels({ limit = 50 }, { client }) {
  const channels = await safeGetChannels(client);
  if (!channels.length) return '📢 לא נמצאו ערוצים שאתה רשום אליהם.';
  const slice = channels.slice(0, Math.min(limit, 100));
  let text = `📢 *הערוצים שלך (${slice.length}):*\n\n`;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    text += `${i + 1}. ${c.name || '(ללא שם)'}\n`;
  }
  return text.trim();
}

async function actionRead({ chatName, limit = 20 }, { client }) {
  if (!chatName) return '❌ חסר שם צ׳אט';
  const chats = await getAllChatsAndChannels(client);
  const ch = findChatByName(chats, chatName);
  if (!ch) return `❌ לא נמצאה שיחה "${chatName}"`;
  const msgs = await fetchMessages(ch, Math.min(limit, 50));
  if (!msgs.length) return `📭 אין הודעות זמינות ב-"${ch.name}".`;
  let text = `💬 *${ch.name}* — ${msgs.length} הודעות:\n\n`;
  for (const m of msgs) {
    const t = new Date(m.timestamp * 1000).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
    const d = new Date(m.timestamp * 1000).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit' });
    const who = m.fromMe ? '🟢 אתה' : (m._data?.notifyName || ch.name || 'הם');
    text += `*${d} ${t}* — ${who}:\n${m.body || `[${m.type}]`}\n\n`;
  }
  return text.trim();
}

async function actionSearch({ query, chatName, limit = 20 }, { client }) {
  if (!query) return '❌ חסר query';
  const chats = await getAllChatsAndChannels(client);
  const searchIn = chatName ? [findChatByName(chats, chatName)].filter(Boolean) : chats.slice(0, 30);
  const results = [];
  for (const ch of searchIn) {
    const msgs = await fetchMessages(ch, 100);
    for (const m of msgs) {
      if (m.body && m.body.toLowerCase().includes(query.toLowerCase())) {
        results.push({ chat: ch.name, time: new Date(m.timestamp * 1000), body: m.body });
        if (results.length >= limit) break;
      }
    }
    if (results.length >= limit) break;
  }
  if (!results.length) return `🔍 לא נמצאו הודעות עם "${query}"`;
  let text = `🔍 *"${query}"* — ${results.length} תוצאות:\n\n`;
  for (const r of results) {
    const dt = r.time.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    text += `*${dt}* · ${r.chat}:\n${r.body.substring(0, 200)}\n\n`;
  }
  return text.trim();
}

async function actionSummarize({ chatName, sinceMinutes, limit = 80 }, { client }) {
  if (!chatName) return '❌ חסר שם צ׳אט';
  const chats = await getAllChatsAndChannels(client);
  const ch = findChatByName(chats, chatName);
  if (!ch) return `❌ לא נמצאה שיחה "${chatName}"`;
  const requested = Math.min(limit || 80, 200);
  const raw = await fetchMessages(ch, requested);
  let msgs = raw.filter(m => m.body && m.body.trim().length > 2);
  if (sinceMinutes && sinceMinutes > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - sinceMinutes * 60;
    msgs = msgs.filter(m => m.timestamp >= cutoff);
  }
  if (!msgs.length) return `📭 אין הודעות ב-"${ch.name}" בטווח המבוקש.`;
  // Build a pool for Claude to summarize
  const pool = msgs.map(m => {
    const t = new Date(m.timestamp * 1000).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
    const who = m.fromMe ? 'אתה' : (m._data?.notifyName || 'משתתף');
    return `[${t}] ${who}: ${m.body}`;
  }).join('\n');
  const prompt = [
    `סכם את ההודעות הבאות מ-"${ch.name}" בקצרה — 3-5 שורות, רק נושאים חמים בלי ניתוח מיותר:`,
    ``,
    pool,
  ].join('\n');
  try {
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    const blocks = r.content.filter(b => b.type === 'text');
    return blocks.length ? blocks.map(b => b.text.trim()).join('\n\n') : `📋 (לא נוצר סיכום)`;
  } catch (e) {
    return `❌ הסיכום נכשל: ${e.message?.substring(0, 80)}`;
  }
}

async function run(input, context) {
  const { action } = input;
  switch (action) {
    case 'chats':     return actionChats(input, context);
    case 'channels':  return actionChannels(input, context);
    case 'read':      return actionRead(input, context);
    case 'search':    return actionSearch(input, context);
    case 'summarize': return actionSummarize(input, context);
    default: return `❌ פעולה לא מוכרת: ${action}`;
  }
}

module.exports = {
  run,
  // Exported helpers — used by tenant.js for scan-flow execution
  safeGetChannels,
  getAllChatsAndChannels,
  findChatByName,
  normalizeHe,
  fetchMessages,
};
