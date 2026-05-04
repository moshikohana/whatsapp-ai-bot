'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const { smartChat, thinkWithClaude, registerToolHandlers, getUsageSummary } = require('./src/claude');
const {
  getCalendarEvents, getTodaySchedule, getWeekSchedule,
  searchCalendarEvents, deleteCalendarEvent, addCalendarEvent,
  formatEventTime, formatTimeOnly,
  getAuthClient: googleGetAuthClient, resetAuthClient: googleResetAuthClient, updateEnvToken: googleUpdateEnvToken,
} = require('./src/calendar');
const { getSystemInfo, listFiles, readFile, searchFiles, runCommand, getProcesses, getBattery, getWifi } = require('./src/computer');
const {
  getUnreadEmails, searchEmails, readEmail, sendEmail, replyToEmail,
  markAsRead, trashEmail, starEmail, getGmailStats, resetAuth: gmailResetAuth,
} = require('./src/gmail');
const { runClaudeCode } = require('./src/claude-code');
const { addMemory, deleteMemory, listMemories, updateContext, clearFailedTools } = require('./src/memory');
const { searchContacts, listContacts, getContactByName } = require('./src/contacts');
const { renderVideo, getTemplates } = require('./src/video');
const { loadConversations, saveConversations, flushConversations, loadScheduledTasks, saveScheduledTasks, loadDailyTasks, saveDailyTasks } = require('./src/persistence');
const { withCache, cache } = require('./src/cache');
const logger = require('./src/logger');
const { appendChatLog } = require('./src/chat-log');
const { saveScan: saveScanHistory } = require('./src/scan-history');
const fs = require('fs');
const { formatContextForClaude, matchTopicToPositions, getBriefingSearchQueries } = require('./src/spokesperson');
const {
  initFaceAPI, addReference, findMatches, blurNonMatchingFaces, highlightMatchingFaces,
  isBlurEnabled, setBlurEnabled, getHighlightMode, setHighlightMode,
  getMonitoredGroups, addMonitoredGroup, removeMonitoredGroup,
  addOwnerGroup, removeOwnerGroup, applyGroupWhitelist,
  getReferenceCount, clearReferences, setThreshold, setEnabled, getStatus: getFaceStatus,
  loadConfig: loadFaceConfig,
} = require('./src/face-recognition');

// ─── Message cache: persist group messages across bot restarts ───
// Groups that return sparse results after restart are supplemented from this
// disk cache. Keyed by WhatsApp JID (ends with @g.us). 48h TTL, 250 msgs/group.
const _MSG_CACHE_FILE = path.join(__dirname, 'data', 'msg-cache.json');
const _MSG_CACHE_TTL = 48 * 3600; // seconds
let _msgCache = {}; // { [chatJid]: [{id, ts, sender, body}] }

// Blocked groups — spam/noise groups excluded from caching (substring match on name)
const _BLOCKED_GROUP_FILE = path.join(__dirname, 'data', 'blocked-groups.json');
let _BLOCKED_GROUP_PATTERNS = [];
try { _BLOCKED_GROUP_PATTERNS = JSON.parse(fs.readFileSync(_BLOCKED_GROUP_FILE, 'utf8')); } catch { _BLOCKED_GROUP_PATTERNS = []; }
const _blockedJids = new Set(); // populated lazily when group names resolve
const _jidNames = new Map();    // JID -> name cache (avoid repeat lookups)

(function _loadMsgCache() {
  try {
    const raw = fs.readFileSync(_MSG_CACHE_FILE, 'utf8');
    _msgCache = JSON.parse(raw);
    const cutoff = Math.floor(Date.now() / 1000) - _MSG_CACHE_TTL;
    let pruned = 0;
    for (const cid of Object.keys(_msgCache)) {
      const before = _msgCache[cid].length;
      _msgCache[cid] = _msgCache[cid].filter(m => m.ts > cutoff);
      pruned += before - _msgCache[cid].length;
      if (!_msgCache[cid].length) delete _msgCache[cid];
    }
    logger.info(`📦 Msg cache loaded: ${Object.keys(_msgCache).length} groups, pruned ${pruned} old msgs`);
  } catch { _msgCache = {}; }
})();

let _msgCacheDirty = false;
function _cacheGroupMsg(msg) {
  if (!msg?.from?.endsWith('@g.us')) return;
  if (!msg.body || msg.body.length < 5) return;
  const cid = msg.from;
  if (_blockedJids.has(cid)) return; // known blocked group — skip

  // Lazy name resolution — first time we see a JID, check against blocklist
  if (!_jidNames.has(cid) && _BLOCKED_GROUP_PATTERNS.length > 0) {
    _jidNames.set(cid, null); // mark as "resolving" to avoid duplicates
    (async () => {
      try {
        const chat = await msg.getChat();
        const name = chat?.name || '';
        _jidNames.set(cid, name);
        if (_BLOCKED_GROUP_PATTERNS.some(p => name.includes(p))) {
          _blockedJids.add(cid);
          if (_msgCache[cid]?.length) {
            logger.info(`🚫 Blocked group "${name}" — cache purged (${_msgCache[cid].length} msgs)`);
            delete _msgCache[cid];
            _msgCacheDirty = true;
          }
        }
      } catch {}
    })();
  }

  const id = msg.id?._serialized || '';
  if (!_msgCache[cid]) _msgCache[cid] = [];
  if (id && _msgCache[cid].some(m => m.id === id)) return; // deduplicate
  _msgCache[cid].push({
    id,
    ts: msg.timestamp || Math.floor(Date.now() / 1000),
    sender: (msg._data?.notifyName || msg._data?.pushName || '').substring(0, 30),
    body: (msg.body || '').substring(0, 500),
  });
  if (_msgCache[cid].length > 250) {
    _msgCache[cid].sort((a, b) => a.ts - b.ts);
    _msgCache[cid] = _msgCache[cid].slice(-250);
  }
  _msgCacheDirty = true;
}

// Flush cache to disk every 30s (only if dirty) — limits message loss on crash
setInterval(() => {
  if (!_msgCacheDirty) return;
  try {
    fs.writeFileSync(_MSG_CACHE_FILE, JSON.stringify(_msgCache));
    _msgCacheDirty = false;
  } catch (e) { logger.warn('⚠️ msg-cache flush failed:', e.message?.substring(0, 60)); }
}, 30_000);

// ─── Helper: fetch messages — 3-strategy robust loader ──────────
// Strategy 1: chat.fetchMessages (official API)
// Strategy 2: Store.Chat.get + looped loadEarlierMsgs (best fallback)
// Strategy 3: WWebJS.getChat (last resort)
// Strategy 4: Disk message cache (survives restarts)
// Returns array with ._usedFallback flag so callers detect partial data.
async function safeFetchMessages(chat, limit) {
  const chatId = chat.id._serialized || chat.id;
  const Message = require('whatsapp-web.js/src/structures/Message');

  // ── Strategy 1: Official API ──────────────────────────────────
  try {
    const msgs = await chat.fetchMessages({ limit });
    msgs._usedFallback = false;
    return msgs;
  } catch (e1) {
    logger.warn(`fetchMessages S1 failed for "${chat.name}": ${e1.message?.substring(0, 60)}`);
  }

  // ── Strategy 2: Direct Store access — tries Msg.find (server fetch) then loadEarlierMsgs ──
  try {
    const rawMsgs = await client.pupPage.evaluate(async (cid, lim) => {
      const chat = window.Store?.Chat?.get(cid);
      if (!chat) return null;

      // S2a: Try Store.Msg.find — fetches recent messages directly from server
      // This loads messages that arrived before the current session (missed during restart)
      try {
        if (typeof window.Store?.Msg?.find === 'function') {
          const found = await Promise.race([
            window.Store.Msg.find({ chatId: cid, count: lim }),
            new Promise(r => setTimeout(r, 6000))
          ]);
          if (found && found.length >= 5) {
            const msgs = found.filter(m => !m.isNotification);
            msgs.sort((a, b) => a.t - b.t);
            return msgs.slice(-lim).map(m => window.WWebJS.getMessageModel(m));
          }
        }
      } catch {}

      // S2b: Fallback — iterative loadEarlierMsgs (loads historical from server)
      let prev = 0;
      for (let i = 0; i < 5 && chat.msgs.length < lim; i++) {
        prev = chat.msgs.length;
        try {
          // 5s cap per iteration — prevents infinite hang on broken groups (e.g. המדמונים)
          await Promise.race([
            window.Store.ConversationMsgs.loadEarlierMsgs(chat, chat.msgs),
            new Promise(r => setTimeout(r, 5000))
          ]);
          await new Promise(r => setTimeout(r, 400));
        } catch { break; }
        if (chat.msgs.length === prev) break; // nothing new loaded
      }
      let msgs = chat.msgs.getModelsArray().filter(m => !m.isNotification);
      msgs.sort((a, b) => a.t - b.t);
      if (msgs.length > lim) msgs = msgs.slice(-lim);
      return msgs.map(m => window.WWebJS.getMessageModel(m));
    }, chatId, limit);

    if (rawMsgs !== null) {
      const result = rawMsgs.map(m => new Message(client, m));
      result._usedFallback = result.length < Math.min(limit * 0.05, 5); // sparse if < 5 msgs
      if (!result._usedFallback) {
        logger.info(`fetchMessages S2 ok for "${chat.name}": ${result.length} msgs`);
        return result; // good data — return immediately
      }
      logger.warn(`fetchMessages S2 sparse for "${chat.name}": only ${result.length} msgs → trying S3`);
      // fall through to S3 — do NOT return sparse result here
    } else {
      logger.warn(`fetchMessages S2 chat not in Store for "${chat.name}" → trying S3`);
    }
  } catch (e2) {
    logger.warn(`fetchMessages S2 failed for "${chat.name}": ${e2.message?.substring(0, 60)}`);
  }

  // ── Strategy 3: WWebJS.getChat + iterated loading (with timeout) ──
  let _s3live = null;
  try {
    const rawMsgs = await client.pupPage.evaluate(async (cid, lim) => {
      const chat = await window.WWebJS.getChat(cid, { getAsModel: false });
      if (!chat) return null;
      // Iteratively load earlier messages (8s cap per iteration, same as S2)
      for (let i = 0; i < 4; i++) {
        if (chat.msgs.length >= lim) break;
        const prev = chat.msgs.length;
        try {
          await Promise.race([
            window.Store.ConversationMsgs.loadEarlierMsgs(chat, chat.msgs),
            new Promise(r => setTimeout(r, 8000))
          ]);
          await new Promise(r => setTimeout(r, 300));
        } catch { break; }
        if (chat.msgs.length === prev) break; // no new messages loaded
      }
      let msgs = chat.msgs.getModelsArray().filter(m => !m.isNotification);
      msgs.sort((a, b) => a.t - b.t);
      if (msgs.length > lim) msgs = msgs.slice(-lim);
      return msgs.map(m => window.WWebJS.getMessageModel(m));
    }, chatId, limit);
    if (rawMsgs === null) throw new Error('WWebJS.getChat returned null');
    const result = rawMsgs.map(m => new Message(client, m));
    result._usedFallback = result.length < Math.min(limit * 0.05, 5);
    logger.warn(`fetchMessages S3 for "${chat.name}": ${result.length} msgs`);
    if (!result._usedFallback) return result; // good data — skip S4
    _s3live = result; // sparse — fall through to S4
  } catch (e3) {
    logger.error(`fetchMessages all strategies failed for "${chat.name}": ${e3.message?.substring(0, 60)}`);
  }

  // ── Strategy 4: Disk message cache (survives restarts) ────────
  // Fills in groups that WhatsApp Web hasn't had time to sync yet.
  try {
    const _dc = (_msgCache[chatId] || []);
    if (_dc.length >= 3) {
      const _inMem = new Set((_s3live || []).map(m => m.id?._serialized).filter(Boolean));
      const _fc = _dc.filter(m => !_inMem.has(m.id)).map(m => ({
        body: m.body, timestamp: m.ts,
        _data: { notifyName: m.sender }, id: { _serialized: m.id }, _fromCache: true,
      }));
      if (_fc.length > 0) {
        const combined = [..._fc, ...(_s3live || [])];
        combined.sort((a, b) => a.timestamp - b.timestamp);
        combined._usedFallback = combined.length < Math.min(limit * 0.05, 5);
        logger.info(`📦 fetchMessages S4 (disk cache) for "${chat.name}": +${_fc.length} cached (total ${combined.length})`);
        return combined;
      }
    }
  } catch {}
  if (_s3live) return _s3live;
  const _empty = []; _empty._usedFallback = true; return _empty;
}

// Returns true when fallback was used AND returned suspiciously few messages
function isFetchIncomplete(msgs, requested) {
  return msgs._usedFallback && msgs.length < Math.max(3, requested * 0.15);
}

// Strip URLs from text before showing in alerts/previews
function stripUrls(text) {
  return (text || '')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '[קישור]')
    .replace(/(?:chat\.whatsapp\.com|t\.me|wa\.me)\/\S+/gi, '[קישור]')
    .trim();
}

// ─── Safe truncate that respects UTF-16 surrogate pairs ──────────
// Naive substring(0, N) can cut emojis in half (e.g. 🔴 = 2 UTF-16 units).
// The result is invalid JSON ("no low surrogate") and Anthropic API
// returns 400 on the request body. This helper backs off the cut by 1
// character if the boundary lands inside a surrogate pair.
// Also strips orphan surrogates that may already be in the input
// (rare, but safer to clean both ends).
function safeTruncate(s, maxLen) {
  if (typeof s !== 'string' || s.length <= maxLen) return s || '';
  let end = maxLen;
  const code = s.charCodeAt(end - 1);
  // High surrogate at the cut point — back off so we don't split the pair
  if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
  return s.substring(0, end);
}

// Strip orphan/lone surrogates from a string (defensive — incoming data
// from WhatsApp Web is *usually* well-formed but can include garbage).
function stripOrphanSurrogates(s) {
  if (typeof s !== 'string' || !s) return s;
  // Replace any high surrogate not followed by low, or low not preceded by high
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// ─── Hebrew-aware string normalization ───────────────────────────
// Used everywhere we need to compare two Hebrew strings that *should*
// be the same but might differ due to:
//   - hebrew gershaim (״, ׳) vs ASCII quotes (", ')
//   - niqqud / cantillation marks
//   - bidi marks (RLM/LRM/PDF, U+200E..U+202E, U+2066..U+2069)
//   - zero-width chars (ZWJ/ZWNJ/BOM)
//   - NFC vs NFD
//   - whitespace placement (esp. before emoji)
// We strip all of those and compare lowercase-no-whitespace.
function normalizeHe(s) {
  return (s || '')
    .normalize('NFC')
    .replace(/[֑-ׇ]/g, '')                           // niqqud
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')   // zero-width / bidi
    .replace(/[״"]/g, '')                                       // " and ״
    .replace(/[׳']/g, '')                                       // ' and ׳
    .replace(/\s+/g, '')                                        // strip ALL whitespace
    .toLowerCase();
}

// ─── Smart chat finder: exact > prefix > shortest-include ────────
// Prevents "קניות" from matching "קניות חכמות ברשת" when an exact match exists.
// Both sides are normalized via normalizeHe() so Hebrew-quote variants
// (״ vs ") and whitespace differences don't break matching.
function findChatByName(chats, query) {
  const q = normalizeHe(query);
  if (!q) return undefined;
  // Pre-normalize names once (avoid recomputing in each filter)
  const indexed = chats.map(c => ({
    chat: c,
    name: c.name || c.pushname || '',
    norm: normalizeHe(c.name || c.pushname || ''),
  })).filter(x => x.norm);

  // 1. Exact match (normalized)
  const exact = indexed.find(x => x.norm === q);
  if (exact) return exact.chat;
  // 2. Starts-with match (shortest name wins)
  const prefixes = indexed.filter(x => x.norm.startsWith(q));
  if (prefixes.length) return prefixes.sort((a, b) => a.name.length - b.name.length)[0].chat;
  // 3. Includes match — prefer shortest name (closest to query)
  const includes = indexed.filter(x => x.norm.includes(q));
  if (includes.length) return includes.sort((a, b) => a.name.length - b.name.length)[0].chat;
  return undefined;
}

// ─── Register unified tool handlers for Claude ──────────────────
registerToolHandlers({
  // ─── Calendar (unified) ───────────────────────────────────────
  calendar: withCache('calendar', async ({ action, days, event_text, query, index, recurrence, recurrence_days, recurrence_count, recurrence_until }) => {
    const runAction = async () => {
      switch (action) {
        case 'today': {
          const events = await getTodaySchedule();
          if (!events.length) return 'אין אירועים היום ביומן Google.';
          return events.map((e, i) => {
            const time = e.allDay ? 'כל היום' : `${formatTimeOnly(e.start)}–${formatTimeOnly(e.end)}`;
            return `${i + 1}. ${e.summary} (${time})${e.location ? ' 📍 ' + e.location : ''}`;
          }).join('\n');
        }
        case 'week': {
          const d = await getWeekSchedule();
          let result = '';
          for (const [, day] of Object.entries(d)) {
            const t = day.isToday ? ' (היום)' : '';
            result += `יום ${day.name} — ${day.date}${t}:\n`;
            if (!day.events.length) result += '  אין אירועים\n';
            else day.events.forEach(e => {
              const time = e.allDay ? 'כל היום' : `${e.startTime}–${e.endTime}`;
              result += `  • ${e.summary} (${time})${e.calendar ? ` [${e.calendar}]` : ''}${e.location ? ' 📍 ' + e.location : ''}\n`;
            });
          }
          return result;
        }
        case 'events': {
          const events = await getCalendarEvents(days || 7);
          if (!events.length) return 'אין אירועים בתקופה הזו.';
          return events.map((e, i) => `${i + 1}. ${e.summary} — ${formatEventTime(e.start)}${e.location ? ' 📍 ' + e.location : ''}`).join('\n');
        }
        case 'add': {
          const recurrenceOpts = recurrence ? { recurrence, recurrence_days, recurrence_count, recurrence_until } : null;
          const r = await addCalendarEvent(event_text, recurrenceOpts);
          let msg = `אירוע נוסף: "${r.summary}" ב-${r.start}`;
          if (r.recurring) msg += ' 🔄 (אירוע חוזר)';
          return msg;
        }
        case 'search': {
          const events = await searchCalendarEvents(query);
          if (!events.length) return `לא נמצאו אירועים עבור "${query}"`;
          return events.map((e, i) => `${i + 1}. ${e.summary} — ${e.startFormatted}`).join('\n');
        }
        case 'delete': { const ev = await deleteCalendarEvent(index); return `אירוע "${ev.summary}" נמחק.`; }
        default: return `פעולה לא מוכרת: ${action}`;
      }
    };
    try {
      return await runAction();
    } catch (err) {
      if (err.message?.includes('invalid_grant') || err.message?.includes('Token has been expired')) {
        googleResetAuthClient();
        gmailResetAuth();
        // Notify owner via WhatsApp (fire-and-forget)
        const authUrl = `http://localhost:${process.env.PORT || 3000}/auth/google`;
        setImmediate(async () => {
          try {
            const oc = await client.getChatById(OWNER_ID);
            await botSend(oc, `🔑 *הרשאת Google פגה!*\n\nהטוקן של יומן Google / Gmail פג (7 ימים בעלון Testing).\n\nלחץ על הקישור לחידוש הגישה:\n${authUrl}`);
          } catch (_) {}
        });
        return '❌ הגישה ל-Google פגה. שלחתי לך קישור לחידוש ההרשאה בצ\'אט הפרטי.';
      }
      throw err;
    }
  }),
  // ─── Gmail (unified) ──────────────────────────────────────────
  gmail: withCache('gmail', async ({ action, index, query, to, subject, body }) => {
    try {
      switch (action) {
        case 'unread': return await getUnreadEmails();
        case 'search': return await searchEmails(query);
        case 'read': return await readEmail(index);
        case 'reply': return await replyToEmail(index, body);
        case 'send': return await sendEmail(to, subject, body);
        case 'mark_read': return await markAsRead(index);
        case 'trash': return await trashEmail(index);
        case 'star': return await starEmail(index);
        case 'stats': return await getGmailStats();
        default: return `פעולה לא מוכרת: ${action}`;
      }
    } catch (err) {
      if (err.message?.includes('invalid_grant') || err.message?.includes('Token has been expired')) {
        googleResetAuthClient();
        gmailResetAuth();
        const authUrl = `http://localhost:${process.env.PORT || 3000}/auth/google`;
        setImmediate(async () => {
          try {
            const oc = await client.getChatById(OWNER_ID);
            await botSend(oc, `🔑 *הרשאת Google פגה!*\n\nהטוקן של Gmail / יומן Google פג.\n\nלחץ על הקישור לחידוש הגישה:\n${authUrl}`);
          } catch (_) {}
        });
        return '❌ הגישה ל-Gmail פגה. שלחתי לך קישור לחידוש ההרשאה בצ\'אט הפרטי.';
      }
      throw err;
    }
  }),
  // ─── Computer (unified) ───────────────────────────────────────
  computer: async ({ action, directory, filename, query, command }) => {
    switch (action) {
      case 'info': return getSystemInfo();
      case 'files': return listFiles(directory || 'desktop');
      case 'read_file': return readFile(filename);
      case 'search_files': return searchFiles(query);
      case 'run': return runCommand(command);
      case 'battery': return getBattery();
      case 'wifi': return getWifi();
      case 'processes': return getProcesses();
      default: return `פעולה לא מוכרת: ${action}`;
    }
  },
  // ─── Contacts (unified) ───────────────────────────────────────
  contacts: withCache('contacts', async ({ action, query }) => {
    switch (action) {
      case 'search': return searchContacts(query);
      case 'list': return listContacts();
      case 'details': return getContactByName(query);
      default: return `פעולה לא מוכרת: ${action}`;
    }
  }),
  // ─── Memory (unified) ────────────────────────────────────────
  memory: async ({ action, text, category, index }) => {
    switch (action) {
      case 'save': {
        const result = addMemory(text, category);
        if (result.duplicate) return 'הזיכרון הזה כבר קיים.';
        console.log(`🧠 Memory saved (#${result.count}): [${category}] ${text}`);
        return `זיכרון נשמר (#${result.count}): "${text}"`;
      }
      case 'delete': { const removed = deleteMemory(index); return `זיכרון #${index} נמחק: "${removed.text}"`; }
      case 'list': return listMemories();
      default: return `פעולה לא מוכרת: ${action}`;
    }
  },
  // ─── WhatsApp (unified) ──────────────────────────────────────
  whatsapp: async ({ action, phone, message, chatName, query, limit, toPhone, messageIndex, sinceMinutes }) => {
    switch (action) {
      case 'send': {
        let num = phone.replace(/[\s\-\+\(\)]/g, '');
        if (num.startsWith('0')) num = '972' + num.substring(1);
        if (!num.endsWith('@c.us')) num = num + '@c.us';
        try { const c = await client.getChatById(num); await c.sendMessage(message); return `✅ הודעה נשלחה ל-${c.name || phone}:\n"${message}"`; }
        catch { return `❌ לא הצלחתי לשלוח ל-${phone}. בדוק שהמספר נכון.`; }
      }
      case 'chats': {
        const chats = await client.getChats();
        const max = Math.min(limit || 20, 50);
        const recent = chats.slice(0, max);
        let text = `💬 *שיחות וואטסאפ (${Math.min(recent.length, max)} מתוך ${chats.length}):*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        for (let i = 0; i < recent.length; i++) {
          const c = recent[i]; const n = c.name || c.pushname || c.id.user || '(ללא שם)';
          const unread = c.unreadCount > 0 ? ` 🔴 ${c.unreadCount}` : '';
          const grp = c.isGroup ? ' 👥' : ''; const mt = c.isMuted ? ' 🔇' : '';
          const lm = c.lastMessage?.body?.substring(0, 50) || '';
          const tm = c.timestamp ? new Date(c.timestamp * 1000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '';
          text += `*${i + 1}.* ${n}${grp}${unread}${mt}\n`;
          if (tm) text += `   ⏰ ${tm}`; if (lm) text += ` · _"${lm}${lm.length >= 50 ? '...' : ''}"_`; text += '\n';
        }
        return text.trim();
      }
      case 'read': {
        const chats = await client.getChats();
        const ch = findChatByName(chats, chatName);
        if (!ch) return `❌ לא נמצאה שיחה "${chatName}"`;
        const reqLimit = Math.min(limit || 20, 50);
        const msgs = await safeFetchMessages(ch, reqLimit);
        if (isFetchIncomplete(msgs, reqLimit)) {
          return `⚠️ *אין גישה להודעות של "${ch.name}"*\nWhatsApp Web לא מצא הודעות — הקבוצה לא נטענה לזיכרון.\n\n💡 *מה לעשות:*\n1. פתח את הקבוצה ב-WhatsApp ✓\n2. גלול למעלה מעט כדי לטעון הודעות ✓\n3. חכה 10 שניות ושאל שוב\n\nאם הבעיה ממשיכה — ייתכן שזו קבוצה פרטית / מוגבלת שWhatsApp Web לא יכול לגשת אליה.`;
        }
        let text = `💬 *${ch.name || chatName}${ch.isGroup ? ' 👥' : ''}* — ${msgs.length} הודעות:\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        for (const m of msgs) {
          const t = new Date(m.timestamp * 1000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
          const d = new Date(m.timestamp * 1000).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
          text += `*${d} ${t}* — ${m.fromMe ? '🟢 אתה' : `🔵 ${m._data?.notifyName || ch.name || 'הם'}`}:\n${m.body || `[${m.type}]`}\n\n`;
        }
        return text.trim();
      }
      case 'search': {
        const chats = await client.getChats();
        let searchIn = chatName ? [findChatByName(chats, chatName)].filter(Boolean) : chats.slice(0, 15);
        if (chatName && !searchIn.length) return `❌ לא נמצאה שיחה "${chatName}"`;
        const results = [];
        for (const ch of searchIn) {
          const msgs = await safeFetchMessages(ch, 100);
          for (const m of msgs.filter(m => m.body?.toLowerCase().includes(query.toLowerCase())).slice(0, 5)) {
            results.push({ chat: ch.name||ch.pushname||ch.id.user, time: new Date(m.timestamp*1000).toLocaleString('he-IL',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}), fromMe: m.fromMe, body: m.body });
          }
          if (results.length >= 20) break;
        }
        if (!results.length) return `🔍 לא נמצאו הודעות עם "${query}"`;
        let text = `🔍 *"${query}"* — ${results.length} תוצאות:\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        for (const r of results) text += `*${r.time}* · ${r.fromMe ? '🟢 אתה' : `🔵 ${r.chat}`}:\n${r.body.substring(0, 200)}\n\n`;
        return text.trim();
      }
      case 'summarize': {
        try {
          const chats = await client.getChats();
          const ch = findChatByName(chats, chatName);
          if (!ch) return `❌ לא נמצאה "${chatName}"`;
          // When filtering by time, fetch more messages so we don't lose old-but-in-window ones
          const reqLim = Math.min(limit || (sinceMinutes ? 300 : 50), 300);
          const rawMsgs = await safeFetchMessages(ch, reqLim);
          if (isFetchIncomplete(rawMsgs, reqLim)) {
            return `⚠️ *אין גישה להודעות של "${ch.name}"*\nWhatsApp Web לא מצא הודעות — הקבוצה לא נטענה לזיכרון.\n\n💡 *מה לעשות:*\n1. פתח את הקבוצה ב-WhatsApp ✓\n2. גלול למעלה מעט כדי לטעון הודעות ✓\n3. חכה 10 שניות ושאל שוב\n\nאם הבעיה ממשיכה — ייתכן שזו קבוצה פרטית / מוגבלת שWhatsApp Web לא יכול לגשת אליה.`;
          }
          let msgs = rawMsgs.filter(m => m.body?.trim().length > 2);
          const totalAvailable = msgs.length;

          // Israel-locale formatters (force timezone so Node TZ doesn't matter)
          const TZ = 'Asia/Jerusalem';
          const fmtT = ts => new Date(ts * 1000).toLocaleTimeString('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
          const fmtD = ts => new Date(ts * 1000).toLocaleDateString('he-IL', { timeZone: TZ, day: '2-digit', month: '2-digit' });

          // Time filter
          let filterNote = '';
          if (sinceMinutes && sinceMinutes > 0) {
            const sinceTs = Math.floor(Date.now() / 1000) - sinceMinutes * 60;
            msgs = msgs.filter(m => m.timestamp >= sinceTs);
            const hrs = sinceMinutes / 60;
            const human = sinceMinutes < 60
              ? `${sinceMinutes} דק׳ אחרונות`
              : (hrs < 24 ? `${Math.round(hrs * 10) / 10} שעות אחרונות` : `${Math.round(hrs / 24 * 10) / 10} ימים אחרונים`);
            filterNote = `\n_מסונן: ${human} (${msgs.length}/${totalAvailable} הודעות)_`;
          }

          if (!msgs.length) {
            return `📋 אין הודעות ב-"${ch.name}" בטווח המבוקש.${filterNote}\n_זמין סה"כ במטמון: ${totalAvailable} הודעות_`;
          }

          const firstTs = msgs[0].timestamp;
          const lastTs = msgs[msgs.length - 1].timestamp;
          const sameDay = fmtD(firstTs) === fmtD(lastTs);
          const rangeLabel = sameDay
            ? `${fmtD(firstTs)} ${fmtT(firstTs)}–${fmtT(lastTs)}`
            : `${fmtD(firstTs)} ${fmtT(firstTs)} → ${fmtD(lastTs)} ${fmtT(lastTs)}`;

          const dump = msgs.map(m => `[${fmtT(m.timestamp)}] ${m.fromMe ? 'מושיקו' : (m._data?.notifyName || 'משתתף')}: ${m.body}`).join('\n');
          return `📋 *"${ch.name}"* — ${msgs.length} הודעות${filterNote}\n*טווח זמן בפועל:* ${rangeLabel} (זמן ישראל)\n━━━━━━━━━━━━━━━━━━━━\n\n${dump}\n\n━━━━━━━━━━━━━━━━━━━━\n_סכם בנקודות תמציתיות. נושאים עיקריים, החלטות, פעולות. **חובה לציין בתשובה את טווח הזמן שנסרק בפועל (לפי "טווח זמן בפועל" למעלה), לא לנחש.**_`;
        } catch (e) {
          logger.error(`WhatsApp summarize error for "${chatName}":`, e.message || e.toString());
          return `❌ שגיאה בגישה לצ'אט "${chatName}": ${e.message || 'שגיאת WhatsApp פנימית'}. נסה שוב.`;
        }
      }
      case 'forward': {
        const chats = await client.getChats();
        const src = findChatByName(chats, chatName);
        if (!src) return `❌ לא נמצאה "${chatName}"`;
        const idx = messageIndex || 1;
        const msgs = (await safeFetchMessages(src, idx + 5)).filter(m => m.body);
        const m = msgs[msgs.length - idx]; if (!m) return `❌ לא נמצאה הודעה ${idx}`;
        let num = toPhone.replace(/[\s\-\+\(\)]/g, ''); if (num.startsWith('0')) num = '972' + num.substring(1); if (!num.endsWith('@c.us')) num += '@c.us';
        const tgt = await client.getChatById(num); await m.forward(tgt);
        return `✅ הועברה ל-${tgt.name||toPhone}!\n📝 "${m.body.substring(0, 100)}"`;
      }
      default: return `פעולה לא מוכרת: ${action}`;
    }
  },
  // ─── Schedule (unified) ──────────────────────────────────────
  schedule: async ({ action, type, delay_minutes, target, message, subject, time, daily_action, params, label, id }) => {
    switch (action) {
      case 'once': {
        if (delay_minutes < 1) return '❌ מינימום דקה';
        if (delay_minutes > 1440) return '❌ מקסימום 24 שעות';
        const sid = scheduleIdCounter++;
        const ms = delay_minutes * 60000;
        const sendAt = new Date(Date.now() + ms);
        const timeLabel = sendAt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
        const dateLabel = delay_minutes >= 60 ? `${Math.floor(delay_minutes/60)} שעות ו-${delay_minutes%60} דקות` : `${delay_minutes} דקות`;
        const timer = setTimeout(async () => {
          try {
            let result;
            if (type === 'whatsapp') {
              let num = target.replace(/[\s\-\+\(\)]/g, ''); if (num.startsWith('0')) num = '972' + num.substring(1); if (!num.endsWith('@c.us')) num += '@c.us';
              const c = await client.getChatById(num); await c.sendMessage(message); result = `✅ הודעה נשלחה ל-${c.name||target}`;
            } else { const {sendEmail:se}=require('./src/gmail'); await se(target,subject||'',message); result = `✅ מייל נשלח ל-${target}`; }
            const oc = await client.getChatById(OWNER_ID); await botSend(oc, `⏰ *תזמון #${sid} בוצע!*\n${result}`);
          } catch (err) { console.error(`❌ Scheduled #${sid}:`, err.message); try { const oc = await client.getChatById(OWNER_ID); await botSend(oc, `❌ תזמון #${sid}: ${err.message.substring(0,80)}`); } catch {} }
          scheduledMessages.delete(sid);
        }, ms);
        scheduledMessages.set(sid, { type, target, message, subject, timer, sendAt, label: timeLabel });
        saveScheduledTasks(scheduledMessages);
        return `⏰ *תזמון #${sid}*\n${type==='whatsapp'?'📲':'📧'} ל-*${target}*\nבעוד *${dateLabel}* (${timeLabel})\n📝 "${message.substring(0,100)}"`;
      }
      case 'daily': {
        const m = time.match(/^(\d{1,2}):(\d{2})$/); if (!m) return '❌ פורמט: HH:MM';
        params = params || {}; // defensive — Claude may omit params entirely
        if (daily_action === 'group_summary' && !(params.groups && params.groups.length)) {
          return '❌ לסקירת קבוצות צריך לציין `params.groups` (מערך שמות קבוצות). דוגמה: `{groups: ["זירה מקומית", "חדשות 2026"]}`';
        }
        if (daily_action === 'send_message' && !params.target) {
          return '❌ לשליחת הודעה יומית צריך `params.target` (מספר/אימייל) ו-`params.message`.';
        }
        // Dedup — refuse to create a duplicate of an existing daily task
        for (const [existingId, existing] of dailyTasks) {
          if (existing.time !== time || existing.action !== daily_action) continue;
          let isDupe = false;
          if (daily_action === 'group_summary') {
            const a = (existing.params?.groups || []).slice().sort().join('|');
            const b = (params.groups || []).slice().sort().join('|');
            isDupe = a === b || (a && b && (a.includes(b) || b.includes(a)));
          } else if (daily_action === 'send_message') {
            isDupe = existing.params?.target === params.target;
          } else if (daily_action === 'media_briefing') {
            isDupe = true; // one briefing per time is enough
          }
          if (isDupe) {
            return `⚠️ כבר קיים תזמון יומי דומה: *#${existingId}* ב-${existing.time} — ${existing.label}.\nאם לשנות — בטל תחילה: \`schedule action=cancel_daily id=${existingId}\``;
          }
        }
        const did = dailyIdCounter++; const tl = label || (daily_action==='group_summary'?'סקירת קבוצות':daily_action==='media_briefing'?'סקירת תקשורת בוקר':'שליחת הודעה');
        const cron = nodeCron.schedule(`${m[2]} ${m[1]} * * *`, async () => {
          console.log(`🔄 Daily #${did}: ${tl}`);
          try {
            const oc = await client.getChatById(OWNER_ID);
            if (daily_action === 'group_summary') {
              const groupStats = [];
              const allMessages = [];
              const {smartChat:sc} = require('./src/claude');
              const _scanDay = Date.now()/1000-86400;
              const _cs1 = await client.getChats(); // fetch once
              for (const gn of (params.groups||[])) {
                try {
                  const ch = findChatByName(_cs1, gn);
                  if (!ch) { groupStats.push({name:gn,count:0,status:'not_found'}); continue; }
                  const msgs = await safeFetchMessages(ch, 150);
                  const rec = msgs.filter(m => m.body && m.timestamp > _scanDay);
                  groupStats.push({name:ch.name, count:rec.length, status:'ok'});
                  // Tighter filter + shorter body — prevents API-400 on large scans
                  for (const m of rec.filter(m => m.body.trim().length > 25))
                    allMessages.push({group:ch.name, time:(()=>{const _d=new Date(m.timestamp*1000);return`${String(_d.getDate()).padStart(2,'0')}/${String(_d.getMonth()+1).padStart(2,'0')} ${String(_d.getHours()).padStart(2,'0')}:${String(_d.getMinutes()).padStart(2,'0')}`;})(), sender:safeTruncate(stripOrphanSurrogates(m._data?.notifyName||'משתתף'),15), body:safeTruncate(stripOrphanSurrogates(m.body),180), ts:m.timestamp});
                } catch (ge) { logger.warn(`scan skip "${gn}": ${ge.message?.substring(0,60)}`); groupStats.push({name:gn,count:0,status:'error',error:ge.message?.substring(0,60)}); }
              }
              // Cap at 120 newest messages, then re-sort chronologically
              allMessages.sort((a,b)=>b.ts-a.ts);
              if (allMessages.length > 120) {
                logger.info(`📋 Daily scan: capping ${allMessages.length} → 120`);
                allMessages.length = 120;
              }
              allMessages.sort((a,b)=>a.ts-b.ts);
              const totalM = groupStats.reduce((a,g)=>a+g.count,0);
              const activeGrps = groupStats.filter(g=>g.count>0);
              const silentGrps = groupStats.filter(g=>g.count===0 && g.status==='ok').map(g=>g.name);
              const notFoundGrps = groupStats.filter(g=>g.status==='not_found').map(g=>g.name);
              const errorGrps = groupStats.filter(g=>g.status==='error').map(g=>g.name);
              const hotG = [...groupStats].sort((a,b)=>b.count-a.count)[0];
              const lvl = totalM>300?'🔴🔴🔴🔴🔴 סוער':totalM>150?'🔴🔴🔴🟡 פעיל מאוד':totalM>50?'🟡🟡🟡 בינוני':'🟢🟢 שקט';
              const _dailyFooter = [];
              if (silentGrps.length) _dailyFooter.push(`🔇 _שקטות (${silentGrps.length}): ${silentGrps.join(', ')}_`);
              if (notFoundGrps.length) _dailyFooter.push(`❓ _לא נמצאו (${notFoundGrps.length}): ${notFoundGrps.join(', ')}_`);
              if (errorGrps.length) _dailyFooter.push(`⚠️ _שגיאה (${errorGrps.length}): ${errorGrps.join(', ')}_`);
              const _dailyFooterLine = _dailyFooter.length ? '\n' + _dailyFooter.join('\n') : '';
              const header = `📋 *סקירה יומית — ${time}*\n━━━━━━━━━━━━━━━━━━━━\n🌡️ ${lvl}  |  🏆 ${hotG?.name||'—'}\n📊 ${totalM} הודעות | ✅ ${activeGrps.length}/${groupStats.length} קבוצות עם תוכן${_dailyFooterLine}\n━━━━━━━━━━━━━━━━━━━━\n\n`;
              if (!allMessages.length) {
                await botSend(oc, header + '_אין הודעות חדשות ב-24 השעות האחרונות_');
                try { saveScanHistory({ kind: 'daily', windowLabel: '24 שעות אחרונות', totalMessages: 0, activeGroups: 0, groupStats, hotGroup: null, scanOutput: '' }); } catch {}
              } else {
                const pool = allMessages.map(m=>`⏰${m.time} [${m.group}] ${m.sender}: "${m.body}"`).join('\n');
                const scanPrompt = `אתה מנתח מודיעין פוליטי לדובר ח"כ אריאל קלנר (ליכוד).\n\nנתונים: ${allMessages.length} הודעות מ-${activeGrps.length} קבוצות.\nפורמט נתונים: ⏰DD/MM HH:MM [שם-קבוצה] שולח: "הודעה"\n\n${pool}\n\nכתוב סריקה לפי נושאים חמים. לכל נושא — בדיוק 2 שורות:\n\nשורה 1: [סמל] *[כותרת — עד 8 מילים]*\nשורה 2: 📍 [כל הקבוצות שדיווחו על הנושא, מופרדות בפסיק] | 🕐 HH:MM — \"[ציטוט ישיר]\"\n\n⚠️ שורה 2 חייבת תמיד:\n- כל שמות הקבוצות שהזכירו נושא זה (מתוך [שם-קבוצה] בנתונים — כולם, לא רק אחת)\n- שעת הפרסום הראשונה (מתוך ⏰ בנתונים)\n- ציטוט ישיר\nאסור להמציא.\n\nדוגמה — נושא שדווח ב-3 קבוצות:\n⚡ *ביטול היטל העברת כספים*\n📍 ממשלה בעבודה, זירה פוליטית, הימנים בליכוד | 🕐 09:15 — \"מדובר בביטול שיהיה מחר בבוקר\"\n\nדוגמה — נושא שדווח בקבוצה אחת:\n🔥 *גיוס חרדים נדחה בכנסת*\n📍 הודעות דוברות לתקשורת | 🕐 11:30 — \"הצבעה על חוק הגיוס נדחתה\"\n\nאחרי כל הנושאים:\n━━━━━━━━━━━━━━━━━━━━\n💡 *זווית קלנר:* [נושא מדויק לתגובה]\n📲 *פעולה מוצעת:* [הצהרה / פוסט / יוזמה — ספציפי]\n\nכללי: 3-7 נושאים מהחם לשקט. ⚡ ב-2+ קבוצות | 🔥 בקבוצה אחת | ⭐ לפני הסמל אם רלוונטי במיוחד לקלנר. עברית בלבד. אין כותרות, הקדמות, הסברים.`;
                const scanResult = await sc(scanPrompt, [], { prefill: '📋 *' });
                await botSend(oc, header + scanResult);
                try { saveScanHistory({ kind: 'daily', windowLabel: '24 שעות אחרונות', totalMessages: totalM, activeGroups: activeGrps.length, groupStats, hotGroup: hotG?.name || null, scanOutput: scanResult }); } catch (e) { logger.warn('scan-history save failed:', e.message?.substring(0,80)); }
                try {
                  const draftsPrompt = `בהתבסס על הסריקה הבאה, כתוב שתי טיוטות פוסט לח"כ קלנר בגוף ראשון:\n\n${scanResult}\n\nפורמט:\n🐦 *טיוטה ל-X:*\n[עד 240 תווים, ישיר, ציוני, ללא האשטאגים]\n\n📘 *טיוטה לפייסבוק:*\n[2-3 משפטים, עם הקשר, אישי יותר]`;
                  const drafts = await sc(draftsPrompt, []);
                  await botSend(oc, `━━━━━━━━━━━━━━━━━━━━\n✍️ *טיוטות פוסטים:*\n\n${drafts}`);
                } catch (draftsErr) { logger.warn('⚠️ drafts failed:', draftsErr.message); }
              }
            } else if (daily_action === 'media_briefing') {
              // Morning media briefing — strictly limited to last 48 hours
              const _now = new Date();
              const _todayISO = _now.toISOString().slice(0, 10);
              const _2dAgoISO = new Date(_now.getTime() - 2 * 86400000).toISOString().slice(0, 10);
              let briefing = `📡 *סקירת תקשורת בוקר — ${_now.toLocaleDateString('he-IL')}*\n📅 _טווח: ${_2dAgoISO} → ${_todayISO} (יומיים)_\n━━━━━━━━━━━━━━━━━━━━\n\n`;
              const queries = getBriefingSearchQueries(params.topics || []);
              const {smartChat:sc} = require('./src/claude');

              // News search via Claude with web_search — DATE-FILTERED
              const newsPrompt = `חפש חדשות *מ-${_2dAgoISO} עד ${_todayISO} בלבד* (יומיים אחרונים) הרלוונטיות לח"כ אריאל קלנר (ליכוד) ולנושאים שלו: ${queries.slice(0,3).join(', ')}.
השתמש ב-web_search עם הפילטר \`after:${_2dAgoISO}\` בכל חיפוש.
**אסור** לכלול כתבה ישנה יותר מ-${_2dAgoISO}. אם אין חדשות בטווח — כתוב "אין חדשות חדשות בטווח".
סכם ב-3-5 נקודות קצרות. לכל נקודה: כותרת · מקור · תאריך מדויק (DD/MM) · קישור.`;
              const newsSummary = await sc(newsPrompt, [], { webSearchMaxUses: 4, timeoutMs: 150000, prefill: '📰 *' });
              briefing += `📰 *חדשות (${_2dAgoISO} → ${_todayISO}):*\n${newsSummary}\n\n`;

              // Social media search — DATE-FILTERED
              const socialPrompt = `חפש אזכורים של "אריאל קלנר" ב-X (twitter) ובפייסבוק *מ-${_2dAgoISO} ואילך בלבד*.
השתמש ב-web_search עם פילטרים: \`"אריאל קלנר" after:${_2dAgoISO}\` , \`"ArielKallner" site:x.com after:${_2dAgoISO}\`.
**אסור** לכלול ציוץ/פוסט ישן יותר מ-${_2dAgoISO}. אם אין — כתוב "אין אזכורים חדשים ברשתות".
לכל אזכור: שם המצייץ · תאריך מדויק · 1 שורה.`;
              const socialSummary = await sc(socialPrompt, [], { webSearchMaxUses: 4, timeoutMs: 150000 });
              briefing += `🐦 *רשתות (${_2dAgoISO} → ${_todayISO}):*\n${socialSummary}\n\n`;

              // WhatsApp groups if specified
              if (params.groups?.length) {
                for (const gn of params.groups) {
                  const cs = await client.getChats(); const ch = findChatByName(cs, gn);
                  if (!ch) continue;
                  const msgs = await safeFetchMessages(ch, 50); const day = Date.now()/1000-86400;
                  const rec = msgs.filter(m => m.body && m.timestamp > day);
                  if (!rec.length) { briefing += `*${ch.name}:* אין חדש\n\n`; continue; }
                  const d = rec.map(m => `${m._data?.notifyName||'משתתף'}: ${m.body.substring(0,150)}`).join('\n');
                  const s = await sc(`סכם בקצרה "${ch.name}" (${rec.length} הודעות 24ש):\n${d}`, []);
                  briefing += `*💬 ${ch.name}* (${rec.length}):\n${s}\n\n`;
                }
              }

              // Action recommendations
              briefing += `\n💡 *המלצות פעולה:*\n_בהתבסס על החדשות — כדאי לפנות לתקשורת? נושא ספציפי לתגובה? אמור "פנייה לתקשורת" או "תגובה על [נושא]"_`;
              await botSend(oc, briefing);
            } else if (daily_action === 'send_message') {
              const {target:t,message:msg,type:tp} = params;
              if (tp==='email') { const{sendEmail:se}=require('./src/gmail'); await se(t,params.subject||'',msg); await botSend(oc,`⏰ יומי #${did} — מייל ל-${t}`); }
              else { let n=t.replace(/[\s\-\+\(\)]/g,''); if(n.startsWith('0'))n='972'+n.substring(1); if(!n.endsWith('@c.us'))n+='@c.us'; const tc=await client.getChatById(n); await tc.sendMessage(msg); await botSend(oc,`⏰ יומי #${did} — הודעה ל-${tc.name||t}`); }
            }
          } catch (err) { console.error(`❌ Daily #${did}:`,err.message); try{const oc=await client.getChatById(OWNER_ID);await botSend(oc,`❌ יומי #${did}: ${err.message.substring(0,80)}`);}catch{} }
        }, { timezone: 'Asia/Jerusalem' });
        dailyTasks.set(did, { cronJob: cron, time, action: daily_action, params, label: tl });
        saveDailyTasks(dailyTasks);
        const ad = daily_action==='group_summary' ? `סקירת ${(params.groups||[]).join(', ')}` : daily_action==='media_briefing' ? `חדשות+רשתות${params.groups?.length?` + ${params.groups.join(', ')}`:''}` : `שליחה ל-${params.target}`;
        return `🔄 *יומי #${did}*\n⏰ כל יום ב-*${time}*\n📋 ${tl}\n${ad}`;
      }
      case 'list': {
        if (!scheduledMessages.size) return '📭 אין תזמונים.';
        let t = `⏰ *תזמונים (${scheduledMessages.size}):*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        for (const [i,s] of scheduledMessages) { t += `*#${i}* ${s.type==='whatsapp'?'📲':'📧'} → ${s.target} · ⏳ ${Math.max(0,Math.round((s.sendAt-Date.now())/60000))}דק\n   📝 "${s.message.substring(0,60)}"\n\n`; }
        return t.trim();
      }
      case 'list_daily': {
        if (!dailyTasks.size) return '📭 אין משימות יומיות.';
        let t = `🔄 *יומיות (${dailyTasks.size}):*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        for (const [i,d] of dailyTasks) t += `*#${i}* ⏰ ${d.time} — ${d.label}\n   ${d.action==='group_summary'?`סקירת ${(d.params.groups||[]).join(', ')}`:`שליחה ל-${d.params.target}`}\n\n`;
        return t.trim();
      }
      case 'cancel': { const s=scheduledMessages.get(id); if(!s) return `❌ תזמון #${id} לא נמצא.`; clearTimeout(s.timer); scheduledMessages.delete(id); saveScheduledTasks(scheduledMessages); return `🗑️ תזמון #${id} בוטל.`; }
      case 'cancel_daily': { const d=dailyTasks.get(id); if(!d) return `❌ יומי #${id} לא נמצא.`; d.cronJob.stop(); dailyTasks.delete(id); saveDailyTasks(dailyTasks); return `🗑️ יומי #${id} בוטל: ${d.label}`; }
      default: return `פעולה לא מוכרת: ${action}`;
    }
  },
  // ─── Video (unified) ─────────────────────────────────────────
  video: async ({ action, template, props, durationSec }) => {
    switch (action) {
      case 'create': {
        try { const p = await renderVideo(template, props, { durationSec }); lastVideoPath = p; return `✅ סרטון נוצר!\n📁 ${p}\n\nלשלוח כוידאו בוואטסאפ?`; }
        catch (err) { return `❌ שגיאה: ${err.message}`; }
      }
      case 'templates': return getTemplates();
      default: return `פעולה לא מוכרת: ${action}`;
    }
  },
  // ─── Spokesperson / דוברות ────────────────────────────────────
  spokesperson: async ({ action, topic, target_outlet }) => {
    switch (action) {
      case 'context': {
        return formatContextForClaude();
      }
      case 'response': {
        if (!topic) return '❌ חסר נושא. שימוש: spokesperson response topic="בג"ץ"';
        const matched = matchTopicToPositions(topic);
        let text = `📢 *הקשר לתגובה על "${topic}":*\n\n`;
        if (matched.positions.length) {
          text += '📌 *עמדות והישגים רלוונטיים:*\n' + matched.positions.join('\n\n') + '\n\n';
        }
        if (matched.roles.length) {
          text += '👔 *תפקידים:*\n' + matched.roles.join('\n') + '\n\n';
        }
        // CoT scratchpad MANDATE — before drafting any quote, Claude must
        // explicitly reason about which Kellner-position to lean on,
        // which legislative achievement to cite, and which tone to use.
        // The user only sees <final_response>, scratchpad is internal.
        text += [
          '─────────────────────────────',
          '📐 *הוראות ניסוח (חובה):*',
          '',
          'לפני הציטוט, חשוב פנימית ב-<scratchpad>:',
          '  1. *עמדה*: ביטחונית / חוקתית / לאומית / חברתית?',
          '  2. *הישג ספציפי של קלנר להזכיר*: איזה חוק / יוזמה?',
          '     (אם אין הישג רלוונטי בעמדות למעלה — אסור להמציא; הסתפק בעמדה כללית)',
          '  3. *טון*: חד+לאומי / חד+מאוזן / קליל-פוליטי?',
          '  4. *ציטוט בסגנון קלנר*: ישיר, חד, 2-3 משפטים מקסימום.',
          '',
          'הפלט הסופי בפורמט הזה בלבד (אין הקדמה):',
          '<scratchpad>',
          '[החשיבה שלך — לא מוצגת למשתמש בסוף]',
          '</scratchpad>',
          '<final_response>',
          'ח"כ אריאל קלנר (ליכוד): "[הציטוט]"',
          '</final_response>',
          '',
          '_מושיקו רואה רק את ה-final_response. הצג למושיקו לאישור._',
        ].join('\n');
        return text;
      }
      case 'pitch': {
        const matched = matchTopicToPositions(topic || '');
        let text = `📡 *הקשר לפנייה לתקשורת:*\n\n`;
        if (topic) text += `📰 נושא: ${topic}\n\n`;
        if (matched.positions.length) {
          text += '📌 *עמדות רלוונטיות:*\n' + matched.positions.slice(0, 2).join('\n\n') + '\n\n';
        }
        if (matched.templates.length) {
          text += '📝 *תבניות פנייה:*\n' + matched.templates.join('\n\n') + '\n\n';
        }
        if (matched.contacts.length) {
          text += '📇 *אנשי קשר:*\n' + matched.contacts.join('\n\n') + '\n\n';
        }
        if (target_outlet) text += `🎯 ערוץ יעד: ${target_outlet}\n`;
        return text;
      }
      default: return `פעולה לא מוכרת: ${action}`;
    }
  },

  // ─── Scan History ────────────────────────────────────────────
  scans: async ({ action, filename, limit }) => {
    const sh = require('./src/scan-history');
    switch (action) {
      case 'latest': {
        const scan = sh.getLatestScan();
        if (!scan) return '📭 אין סריקות שמורות עדיין. אמור "סרוק עכשיו" כדי לבצע סריקה.';
        const d = scan.timestamp ? new Date(scan.timestamp).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : `${scan.date} ${scan.time}`;
        let out = `📋 *הסקירה האחרונה (${d}):*\n`;
        out += `🌡️ ${scan.totalMessages || 0} הודעות מ-${scan.activeGroups || 0} קבוצות\n`;
        if (scan.hotGroup) out += `🏆 קבוצה חמה: ${scan.hotGroup}\n`;
        if (scan.windowLabel) out += `⏱ טווח: ${scan.windowLabel}\n`;
        out += `━━━━━━━━━━━━━━━━━━━━\n\n`;
        out += scan.scanOutput || '_(סריקה ריקה)_';
        return out;
      }
      case 'list': {
        const scans = sh.listScans({ limit: limit || 10 });
        if (!scans.length) return '📭 אין סריקות שמורות עדיין.';
        let out = `🗂️ *${scans.length} סריקות אחרונות:*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        for (const s of scans) {
          const kind = s.kind === 'daily' ? '🔄 יומית' : '⚡ ידנית';
          out += `${kind} · ${s.date} ${s.time}\n`;
          out += `   📊 ${s.totalMessages || 0} הודעות מ-${s.activeGroups || 0} קבוצות`;
          if (s.hotGroup) out += ` · 🏆 ${s.hotGroup}`;
          out += `\n   📁 ${s.filename}\n\n`;
        }
        return out.trim();
      }
      case 'today': {
        const todayDate = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
        const all = sh.listScans({ limit: 30 });
        const today = all.filter(s => s.date === todayDate);
        if (!today.length) return `📭 אין סריקות מהיום (${todayDate}). אמור "סרוק עכשיו" כדי לבצע.`;
        let out = `🗓️ *${today.length} סריקות מהיום (${todayDate}):*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        for (const s of today) {
          const kind = s.kind === 'daily' ? '🔄 יומית' : '⚡ ידנית';
          out += `${kind} · ${s.time} · ${s.totalMessages || 0} הודעות מ-${s.activeGroups || 0} קבוצות\n`;
          out += `   📁 ${s.filename}\n\n`;
        }
        out += '_להציג סריקה ספציפית: scans get filename="..."_';
        return out.trim();
      }
      case 'get': {
        if (!filename) return '❌ נדרש filename. דוגמה: scans get filename="2026-05-03/19-24-manual.json"';
        const scan = sh.loadScan(filename);
        if (!scan) return `❌ לא נמצאה סריקה: ${filename}`;
        let out = `📋 *סריקה: ${filename}*\n`;
        if (scan.windowLabel) out += `⏱ טווח: ${scan.windowLabel}\n`;
        out += `🌡️ ${scan.totalMessages || 0} הודעות מ-${scan.activeGroups || 0} קבוצות\n`;
        if (scan.hotGroup) out += `🏆 ${scan.hotGroup}\n`;
        out += `━━━━━━━━━━━━━━━━━━━━\n\n`;
        out += scan.scanOutput || '_(ריק)_';
        return out;
      }
      default: return `פעולה לא מוכרת: ${action}`;
    }
  },

  // ─── Quote Archive ───────────────────────────────────────────
  archive: async ({ action, text, topic, type, channel, tags, sinceDays, query, id, result }) => {
    const arch = require('./src/quote-archive');
    switch (action) {
      case 'save': {
        if (!text || !topic) return '❌ נדרש text + topic. דוגמה: archive save text="..." topic="בג"ץ" type="תגובה דוברות" channel="ערוץ 14"';
        try {
          const saved = arch.addQuote({ text, topic, type, channel, tags });
          return `✅ נשמר בארכיון: *${saved.id}*\n📂 ${saved.topic}${saved.channel ? ` · ${saved.channel}` : ''}\n📝 ${saved.text.substring(0, 80)}${saved.text.length > 80 ? '...' : ''}`;
        } catch (e) { return `❌ שמירה נכשלה: ${e.message}`; }
      }
      case 'search': {
        const items = arch.searchQuotes({ topic, channel, type, query, sinceDays: sinceDays || 180 });
        if (!items.length) return `🗄️ לא נמצאו ציטוטים בארכיון לפי הקריטריונים${topic ? ` (נושא: ${topic})` : ''}${channel ? ` (ערוץ: ${channel})` : ''}.`;
        return arch.formatQuotesList(items, { limit: 8 });
      }
      case 'similar': {
        if (!topic) return '❌ נדרש topic. דוגמה: archive similar topic="בג"ץ"';
        const items = arch.findSimilar(topic, sinceDays || 90);
        if (!items.length) return `🗄️ לא נמצאו ציטוטים דומים על "${topic}" ב-${sinceDays || 90} ימים האחרונים. כנראה זה נושא חדש — אפשר לנסח בלי דאגה לכפילות.`;
        return `⚠️ *${items.length} ציטוטים דומים על "${topic}":*\n\n` + arch.formatQuotesList(items, { limit: 5 });
      }
      case 'stats': {
        const s = arch.getStats();
        if (!s.total) return '🗄️ הארכיון ריק עדיין. כל ציטוט שתאשר יישמר אוטומטית.';
        let txt = `🗄️ *ארכיון ציטוטים:* ${s.total} סה"כ\n`;
        if (s.oldest && s.newest) {
          const oldD = new Date(s.oldest).toLocaleDateString('he-IL');
          const newD = new Date(s.newest).toLocaleDateString('he-IL');
          txt += `📅 ${oldD} → ${newD}\n\n`;
        }
        if (Object.keys(s.byType).length) {
          txt += '*לפי סוג:*\n';
          for (const [k, v] of Object.entries(s.byType).sort((a, b) => b[1] - a[1])) {
            txt += `  • ${k}: ${v}\n`;
          }
        }
        if (Object.keys(s.byChannel).length) {
          txt += '\n*לפי ערוץ (top 5):*\n';
          for (const [k, v] of Object.entries(s.byChannel).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
            txt += `  • ${k}: ${v}\n`;
          }
        }
        return txt.trim();
      }
      case 'result': {
        if (!id || !result) return '❌ נדרש id + result. דוגמה: archive result id="Q-2026-05-02-001" result="פורסם בכותרת ynet"';
        const updated = arch.updateQuoteResult(id, result);
        if (!updated) return `❌ לא נמצא ציטוט עם id ${id}`;
        return `✅ עודכן: *${updated.id}*\n📂 ${updated.topic}\n✅ תוצאה: ${updated.result}`;
      }
      default: return `פעולה לא מוכרת: ${action}`;
    }
  },

  // ─── Photo Filter / Face Recognition ──────────────────────────
  photo_filter: async ({ action, group_name, threshold, name, enabled }) => {
    switch (action) {
      case 'status': {
        const s = getFaceStatus();
        const hlLabels = { none: '❌ כבוי', highlight: '🟢 סימון', highlight_blur: '🟢🔒 סימון+טשטוש' };
        let text = `📷 *סינון תמונות: ${s.enabled ? '✅ פעיל' : '❌ כבוי'}*\n`;
        text += `🔒 טשטוש: ${s.blurEnabled ? '✅ פעיל' : '❌ כבוי'}\n`;
        text += `🎨 סימון פנים: ${hlLabels[s.highlightMode] || '❌ כבוי'}\n`;
        text += `🎯 סף רגישות: ${s.threshold}\n`;
        text += `🔧 מנוע: ${s.initialized ? '✅ מוכן' : '⏳ טעינה...'}`;
        if (s.initError) text += ` (${s.initError.substring(0, 50)})`;
        text += '\n\n';
        if (s.monitoredGroups.length) {
          text += '📋 *קבוצות במעקב:*\n';
          s.monitoredGroups.forEach(g => { text += `  • ${g}\n`; });
        } else text += '📋 אין קבוצות במעקב\n';
        if (s.references.length) {
          text += '\n👤 *תמונות ייחוס:*\n';
          s.references.forEach(r => { text += `  • ${r.name}: ${r.count} תמונות\n`; });
        } else text += '\n👤 אין תמונות ייחוס — שלח תמונה עם כיתוב "ייחוס [שם]"\n';
        return text;
      }
      case 'add_group':
        if (!group_name) return '❌ ציין שם קבוצה';
        addMonitoredGroup(group_name);
        return `✅ הקבוצה "${group_name}" נוספה למעקב`;
      case 'remove_group':
        if (!group_name) return '❌ ציין שם קבוצה';
        return removeMonitoredGroup(group_name)
          ? `✅ הקבוצה "${group_name}" הוסרה`
          : `❌ הקבוצה "${group_name}" לא נמצאה`;
      case 'add_owner_group': {
        if (!group_name) return '❌ ציין שם קבוצת בדיקה';
        addOwnerGroup(group_name);
        return `✅ הקבוצה "${group_name}" הוגדרה כקבוצת בדיקה — גם תמונות שלך יבדקו`;
      }
      case 'remove_owner_group': {
        if (!group_name) return '❌ ציין שם קבוצה';
        return removeOwnerGroup(group_name)
          ? `✅ הקבוצה "${group_name}" הוסרה מקבוצות הבדיקה`
          : `❌ הקבוצה "${group_name}" לא נמצאה בקבוצות הבדיקה`;
      }
      case 'set_threshold': {
        if (threshold === undefined) return '❌ ציין סף (0.1-0.8)';
        if (name) {
          // Per-person threshold — uses setPersonThreshold from face-recognition.js
          const { setPersonThreshold } = require('./src/face-recognition');
          const val = setPersonThreshold(name, threshold);
          return `✅ סף רגישות אישי של *"${name}"* עודכן ל-*${val}*\n_נמוך=קפדן, גבוה=מתירני_`;
        }
        return `✅ סף רגישות עודכן ל-${setThreshold(threshold)}\n_נמוך=קפדן, גבוה=מתירני_`;
      }
      case 'clear_references': {
        const refCount = name ? getReferenceCount(name) : getReferenceCount();
        const label = name ? `של *"${name}"*` : 'של *כל האנשים*';
        // Set a 30-second pending confirmation — actual deletion happens when user replies "כן"
        pendingClearConfirm.set(OWNER_ID, { name: name || null, count: refCount, expiresAt: Date.now() + 30000 });
        return `⚠️ *אישור נדרש לפני מחיקה*\n\nהאם למחוק *${refCount} ייחוסים* ${label}?\n\n✅ ענה *"כן, מחק"* לאישור סופי\n❌ ענה *"לא"* לביטול`;
      }
      case 'toggle':
        setEnabled(enabled !== false);
        return `📷 סינון תמונות: ${enabled !== false ? '✅ פעיל' : '❌ כבוי'}`;
      case 'toggle_blur':
        setBlurEnabled(enabled !== false);
        return `🔒 טשטוש פנים: ${enabled !== false ? '✅ פעיל — פנים אחרות יטושטשו' : '❌ כבוי'}`;
      case 'set_highlight': {
        // name field reused as mode: 'none' | 'highlight' | 'highlight_blur'
        const mode = name || 'none';
        setHighlightMode(mode);
        const modeLabels = {
          none: '❌ כבוי — תמונות מקוריות',
          highlight: '🟢 פעיל — גבול ירוק על הפנים המזוהות, אדום על האחרות',
          highlight_blur: '🟢🔒 פעיל — גבול ירוק על הפנים המזוהות + טשטוש על האחרות',
        };
        return `🎨 מצב סימון: ${modeLabels[mode] || mode}`;
      }
      default: return `פעולה לא מוכרת: ${action}`;
    }
  },

  // ─── Media Tracker ────────────────────────────────────────────
  media_tracker: async ({ action, contact_id, topic }) => {
    const { listContacts, logOutreach, markReplied, resetContact } = require('./src/media-tracker');
    switch (action) {
      case 'list':    return listContacts();
      case 'log':     return logOutreach(contact_id, topic);
      case 'replied': return markReplied(contact_id);
      case 'reset':   return resetContact(contact_id);
      default:        return `פעולה לא מוכרת: ${action}`;
    }
  },

  // ─── Keyword Alerts ──────────────────────────────────────────
  keyword_alerts: async ({ action, keyword, enabled }) => {
    const ka = require('./src/keyword-alerts');
    switch (action) {
      case 'status': return ka.getFullStatus();
      case 'stats': return ka.getStats();
      case 'today': return ka.getTodayAlerts();
      case 'add': ka.addKeyword(keyword); return `✅ נוסף: "${keyword}"`;
      case 'remove': ka.removeKeyword(keyword); return `🗑️ הוסר: "${keyword}"`;
      case 'enable': ka.setEnabled(true); return '✅ התראות הופעלו';
      case 'disable': ka.setEnabled(false); return '🔕 התראות כובו';
      default: return `פעולה לא מוכרת: ${action}`;
    }
  },

  // ─── Templates Library ────────────────────────────────────────
  templates: async ({ action, name, content }) => {
    const tmpl = require('./src/templates');
    switch (action) {
      case 'save': return tmpl.saveTemplate(name, content);
      case 'get': {
        const t = tmpl.getTemplate(name);
        return t || `❌ תבנית "${name}" לא נמצאה. הצג רשימה עם "תבניות"`;
      }
      case 'list': return tmpl.listTemplates();
      case 'delete': return tmpl.deleteTemplate(name);
      default: return `פעולה לא מוכרת: ${action}`;
    }
  },

  // ─── Navigation (Waze/Maps links + ETA) ────────────────────────
  // Bot sends links to user's WhatsApp; tapping on phone opens the app
  // automatically (Waze universal link or Google Maps deep link).
  navigation: async ({ action, destination, from, home_address }) => {
    const nav = require('./src/navigation');
    try {
      switch (action) {
        case 'waze_link':
          if (!destination) return '❌ יעד חסר. לדוגמה: "בוא נסע לירושלים"';
          logger.info(`🚗 waze_link → "${destination}"`);
          return nav.wazeLinkOnly(destination);
        case 'maps_link':
          if (!destination) return '❌ יעד חסר. לדוגמה: "פתח מפות לכנסת"';
          logger.info(`🗺️ maps_link → "${destination}"${from ? ' from ' + from : ''}`);
          return nav.mapsLinkOnly(destination, from || null);
        case 'eta':
          if (!destination) return '❌ יעד חסר. לדוגמה: "כמה זמן לוקח לי לאילת"';
          return await nav.eta(destination, { from: from || null });
        case 'set_home':
          if (!home_address) return '❌ כתובת חסרה. לדוגמה: "קבע את הבית שלי במודיעין"';
          return nav.setHome(home_address);
        default:
          return `פעולה לא מוכרת: ${action}`;
      }
    } catch (e) {
      logger.warn(`navigation error: ${e.message?.substring(0,80)}`);
      return `❌ *שגיאה בניווט:* ${e.message?.substring(0, 120) || 'שגיאה לא ידועה'}`;
    }
  },
  // ─── Collective Memory (search across scans+chats+calls+memory) ─
  memory_search: async ({ query, days, sources }) => {
    if (!query || !query.trim()) return '❌ צריך מילת חיפוש. לדוגמה: "תחפש בזיכרון: בגץ"';
    const collMem = require('./src/collective-memory');
    const since = new Date(Date.now() - (days || 30) * 24 * 60 * 60 * 1000);
    try {
      logger.info(`🧠 memory_search: "${query}" (${days || 30}d, sources=${sources ? sources.join(',') : 'all'})`);
      const r = await collMem.searchMemory(query, { since, limit: 25, sources });
      return r.answer;
    } catch (e) {
      logger.warn(`memory_search error: ${e.message?.substring(0, 100)}`);
      return `❌ *שגיאה בחיפוש בזיכרון:* ${e.message?.substring(0, 120) || 'שגיאה'}`;
    }
  },
});

// ─── Express ─────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

let botStatus = 'disconnected';
let botName = 'בוטי';
let botPhone = '';
let currentQR = null;
let currentQRRaw = null;     // The original QR string (for /qr endpoint)
let lastError = null;         // { message, stack, ts } — captured for /debug
let qrCount = 0;              // How many times we've shown a QR (high count = repeated re-pair = volume issue)
let lastQRTime = null;
const messageLog = [];
const conversations = loadConversations();
let stats = { received: 0, sent: 0 };

// ─── Recent reference context (for multi-photo batches) ─────────
// When user sends "ייחוס [name]" on one photo, remember name for 8s
// so subsequent photos in the same batch are treated as references too
const recentRefContext = new Map(); // chatId → { name, expiresAt }
const pendingClearConfirm = new Map(); // chatId → { name, count, expiresAt } — awaiting "כן" before clearing refs

// ─── Feedback store ──────────────────────────────────────────────
// Key: bot's sent message ID → { name, imageBuffer, confidence, groupName }
// Also keep "last" per chatId for text-based "פידבק כן/לא"
const forwardedPhotos = new Map();   // msgId → photoData
const lastForwardedPhoto = new Map(); // chatId → photoData (for text-only feedback)
const MAX_FEEDBACK_STORE = 50;       // don't grow unbounded

const OWNER_ID = '972524243250@c.us';

// ─── Owner's self-LID (for new "Message Yourself" format) ──────────
// WhatsApp's new format uses @lid identifiers. The user's own LID is
// captured from the first lid→lid (same) self-DM, then persisted to
// data/owner-lid.json so it survives restarts. Used to STRICTLY identify
// self-chat without false-positives on other @lid contacts.
const OWNER_LID_PATH = path.join(__dirname, 'data', 'owner-lid.json');
let ownerSelfLid = null;
try {
  if (fs.existsSync(OWNER_LID_PATH)) {
    ownerSelfLid = JSON.parse(fs.readFileSync(OWNER_LID_PATH, 'utf8')).lid || null;
    if (ownerSelfLid) console.log(`📌 Loaded owner self-LID: ${ownerSelfLid}`);
  }
} catch (_) { ownerSelfLid = null; }
function saveOwnerLid(lid) {
  if (!lid || ownerSelfLid === lid) return;
  ownerSelfLid = lid;
  try { fs.writeFileSync(OWNER_LID_PATH, JSON.stringify({ lid, capturedAt: new Date().toISOString() }, null, 2)); } catch (_) {}
  console.log(`📌 Captured owner self-LID: ${lid}`);
}
const BOT_MARKER = '\u200B\u200C\u200B';
const BOT_SIG = '\n\n— *🤖 בוטי*';
let lastVideoPath = null;

// ─── Bot sleep mode ──────────────────────────────────────────────
let botSleeping = false;

// ─── Daily face match tracker (resets each day) ──────────────────
const _dailyFaceMatches = new Map(); // "YYYY-MM-DD" → Map<name, {count, groups:Set}>

// ─── Weekly face photo buffer (for Saturday album) ────────────────
const _weeklyFacePhotos = []; // { name, base64, groupName, date, confidence }
const MAX_WEEKLY_PHOTOS = 50; // keep max 50 photos

function _trackFaceMatch(name, groupName) {
  const day = new Date().toISOString().slice(0, 10);
  if (!_dailyFaceMatches.has(day)) _dailyFaceMatches.set(day, new Map());
  const dayMap = _dailyFaceMatches.get(day);
  if (!dayMap.has(name)) dayMap.set(name, { count: 0, groups: new Set() });
  const entry = dayMap.get(name);
  entry.count++;
  entry.groups.add(groupName);
}

// ─── Scheduled messages system ──────────────────────────────────
const scheduledMessages = new Map(); // id → { type, target, message, subject?, timer, sendAt, label }
let scheduleIdCounter = 1;

// ─── Daily recurring tasks ──────────────────────────────────────
const nodeCron = require('node-cron');
const dailyTasks = new Map(); // id → { cronJob, time, action, params, label }
let dailyIdCounter = 1;

// ─── Stale Chromium-lock cleanup ──────────────────────────────────
// If the bot crashed ungracefully (watchdog kill, OS shutdown, OOM),
// Chromium leaves behind SingletonLock/SingletonCookie/SingletonSocket
// inside the userDataDir. The next launch sees them as "another browser
// is using this" and refuses to start. Same logic that start.sh runs in
// Docker — needed locally too. Safe: we only run one bot at a time.
(function clearStaleLocks() {
  try {
    const authDir = path.join(__dirname, '.wwebjs_auth');
    if (!fs.existsSync(authDir)) return;
    const targets = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
    let cleared = 0;
    const walk = (dir, depth = 0) => {
      if (depth > 4) return;
      try {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, item.name);
          if (item.isDirectory()) { walk(p, depth + 1); continue; }
          if (targets.includes(item.name)) {
            try { fs.unlinkSync(p); cleared += 1; } catch (_) {}
          }
        }
      } catch (_) {}
    };
    walk(authDir);
    if (cleared > 0) console.log(`🔓 Cleared ${cleared} stale Chromium lock file(s)`);
  } catch (e) {
    console.warn('⚠️ Lock cleanup failed:', e.message?.substring(0, 60));
  }
})();

// ─── WhatsApp Client ─────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'ai-personal-bot', dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    // Increase CDP protocol timeout for cloud environments (Railway/Render
    // in distant regions like Singapore can be slow under load — 5 min
    // headroom prevents Runtime.callFunctionOn timeouts during warm-up).
    protocolTimeout: 300000, // 5 minutes (default is 30s)
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-translate',
      '--no-first-run',
      '--disable-software-rasterizer',
      '--disable-blink-features=AutomationControlled',
      '--no-zygote',
      '--memory-pressure-off',
    ],
  },
});

// ─── Puppeteer-fatal detection ──────────────────────────────────
// If protocolTimeout fires the underlying CDP connection is dead — express
// keeps serving (so /health, /debug return "connected") but WhatsApp events
// stop arriving. Detect & exit so Railway restarts cleanly.
process.on('uncaughtException', (err) => {
  const msg = err?.message || '';
  if (msg.includes('Runtime.callFunctionOn timed out') ||
      msg.includes('Protocol error') ||
      msg.includes('Target closed') ||
      msg.includes('Session closed')) {
    console.error(`💥 Puppeteer-fatal: ${msg.substring(0, 120)} — exiting for Railway restart`);
    setTimeout(() => process.exit(1), 1000);
    return;
  }
  console.error(`💥 uncaughtException: ${msg}`);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (msg.includes('Runtime.callFunctionOn timed out') ||
      msg.includes('Protocol error') ||
      msg.includes('Target closed')) {
    console.error(`💥 Puppeteer-fatal (rejection): ${msg.substring(0, 120)} — exiting for Railway restart`);
    setTimeout(() => process.exit(1), 1000);
  }
});

client.on('qr', async (qr) => {
  qrcodeTerminal.generate(qr, { small: true });
  console.log('\n📱 סרוק QR בוואטסאפ, או פתח http://localhost:3000\n');
  currentQR = await qrcode.toDataURL(qr);
  currentQRRaw = qr;
  qrCount += 1;
  lastQRTime = new Date().toISOString();
  botStatus = 'qr';
  io.emit('status', 'qr');
  io.emit('qr', currentQR);
});

client.on('loading_screen', (pct) => process.stdout.write(`\r⏳ טוען... ${pct}%`));
client.on('authenticated', () => { console.log('\n🔐 אומת!'); botStatus = 'authenticated'; io.emit('status', 'authenticated'); });

client.on('ready', () => {
  botStatus = 'connected';
  currentQR = null;
  const info = client.info;
  logger.info(`✅ בוטי מחובר! | ${info.pushname} (+${info.wid.user})`);
  io.emit('status', 'connected');
  botName = info.pushname || 'בוטי';
  botPhone = info.wid.user || '';
  io.emit('botInfo', { name: info.pushname, phone: info.wid.user });

  // ── Initialize face recognition in background ──
  initFaceAPI().catch(err => console.error('Face API init:', err.message));

  // ── Restore scheduled tasks from disk ──
  const savedScheduled = loadScheduledTasks();
  let restoredScheduled = 0;
  for (const s of savedScheduled) {
    const sendAt = new Date(s.sendAt);
    const remaining = sendAt.getTime() - Date.now();
    if (remaining <= 0) continue; // Already expired
    const sid = s.id;
    if (sid >= scheduleIdCounter) scheduleIdCounter = sid + 1;
    const timer = setTimeout(async () => {
      try {
        let result;
        if (s.type === 'whatsapp') {
          let num = s.target.replace(/[\s\-\+\(\)]/g, ''); if (num.startsWith('0')) num = '972' + num.substring(1); if (!num.endsWith('@c.us')) num += '@c.us';
          const c = await client.getChatById(num); await c.sendMessage(s.message); result = `✅ הודעה נשלחה ל-${c.name||s.target}`;
        } else { const {sendEmail:se}=require('./src/gmail'); await se(s.target,s.subject||'',s.message); result = `✅ מייל נשלח ל-${s.target}`; }
        const oc = await client.getChatById(OWNER_ID); await botSend(oc, `⏰ *תזמון #${sid} בוצע!*\n${result}`);
      } catch (err) { logger.error(`❌ Scheduled #${sid}: ${err.message}`); }
      scheduledMessages.delete(sid); saveScheduledTasks(scheduledMessages);
    }, remaining);
    scheduledMessages.set(sid, { type: s.type, target: s.target, message: s.message, subject: s.subject, timer, sendAt, label: s.label });
    restoredScheduled++;
  }

  // ── Restore daily tasks from disk ──
  const savedDaily = loadDailyTasks();
  let restoredDaily = 0;
  for (const d of savedDaily) {
    const did = d.id;
    if (did >= dailyIdCounter) dailyIdCounter = did + 1;
    const m = d.time.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const cron = nodeCron.schedule(`${m[2]} ${m[1]} * * *`, async () => {
      logger.info(`🔄 Daily #${did}: ${d.label}`);
      try {
        const oc = await client.getChatById(OWNER_ID);
        if (d.action === 'group_summary') {
          const groupStats = [];
          const allMessages = [];
          const {smartChat:sc} = require('./src/claude');
          const _scanDay = Date.now()/1000-86400;
          const _cs2 = await client.getChats(); // fetch once
          for (const gn of (d.params.groups||[])) {
            try {
              const ch = findChatByName(_cs2, gn);
              if (!ch) { groupStats.push({name:gn,count:0}); continue; }
              const msgs = await safeFetchMessages(ch, 150);
              const rec = msgs.filter(m => m.body && m.timestamp > _scanDay);
              groupStats.push({name:ch.name, count:rec.length});
              // Tighter filter (>25 chars skip noise) + shorter body (180) — avoids
              // the API-400 "prompt too long" failures we saw with 200+ messages.
              for (const m of rec.filter(m => m.body.trim().length > 25))
                allMessages.push({group:ch.name, time:(()=>{const _d=new Date(m.timestamp*1000);return`${String(_d.getDate()).padStart(2,'0')}/${String(_d.getMonth()+1).padStart(2,'0')} ${String(_d.getHours()).padStart(2,'0')}:${String(_d.getMinutes()).padStart(2,'0')}`;})(), sender:safeTruncate(stripOrphanSurrogates(m._data?.notifyName||'משתתף'),15), body:safeTruncate(stripOrphanSurrogates(m.body),180), ts:m.timestamp});
            } catch (ge) { logger.warn(`scan skip "${gn}": ${ge.message?.substring(0,60)}`); groupStats.push({name:gn,count:0}); }
          }
          // Sort newest-first then cap at 120 — keeps prompt under safe size for Claude
          allMessages.sort((a,b)=>b.ts-a.ts);
          const _capped = allMessages.length > 120;
          if (_capped) {
            logger.info(`📋 Daily scan: capping ${allMessages.length} → 120 messages (newest)`);
            allMessages.length = 120;
          }
          // After cap, sort back chronologically for the prompt
          allMessages.sort((a,b)=>a.ts-b.ts);
          const totalM = groupStats.reduce((a,g)=>a+g.count,0);
          const activeGrps = groupStats.filter(g=>g.count>0);
          const hotG = [...groupStats].sort((a,b)=>b.count-a.count)[0];
          const lvl = totalM>300?'🔴🔴🔴🔴🔴 סוער':totalM>150?'🔴🔴🔴🟡 פעיל מאוד':totalM>50?'🟡🟡🟡 בינוני':'🟢🟢 שקט';
          const header = `📋 *סקירה יומית — ${d.time}*\n━━━━━━━━━━━━━━━━━━━━\n🌡️ ${lvl}  |  🏆 ${hotG?.name||'—'}  |  📊 ${totalM} הודעות מ-${activeGrps.length} קבוצות\n━━━━━━━━━━━━━━━━━━━━\n\n`;
          if (!allMessages.length) {
            await botSend(oc, header + '_אין הודעות חדשות ב-24 השעות האחרונות_');
          } else {
            const pool = allMessages.map(m=>`⏰${m.time} [${m.group}] ${m.sender}: "${m.body}"`).join('\n');
            const scanPrompt = `אתה מנתח מודיעין פוליטי לדובר ח"כ אריאל קלנר (ליכוד).\n\nנתונים: ${allMessages.length} הודעות מ-${activeGrps.length} קבוצות.\nפורמט נתונים: ⏰DD/MM HH:MM [שם-קבוצה] שולח: "הודעה"\n\n${pool}\n\nכתוב סריקה לפי נושאים חמים. לכל נושא — בדיוק 2 שורות:\n\nשורה 1: [סמל] *[כותרת — עד 8 מילים]*\nשורה 2: 📍 [כל הקבוצות שדיווחו על הנושא, מופרדות בפסיק] | 🕐 HH:MM — \"[ציטוט ישיר]\"\n\n⚠️ שורה 2 חייבת תמיד:\n- כל שמות הקבוצות שהזכירו נושא זה (מתוך [שם-קבוצה] בנתונים — כולם, לא רק אחת)\n- שעת הפרסום הראשונה (מתוך ⏰ בנתונים)\n- ציטוט ישיר\nאסור להמציא.\n\nדוגמה — נושא שדווח ב-3 קבוצות:\n⚡ *ביטול היטל העברת כספים*\n📍 ממשלה בעבודה, זירה פוליטית, הימנים בליכוד | 🕐 09:15 — \"מדובר בביטול שיהיה מחר בבוקר\"\n\nדוגמה — נושא שדווח בקבוצה אחת:\n🔥 *גיוס חרדים נדחה בכנסת*\n📍 הודעות דוברות לתקשורת | 🕐 11:30 — \"הצבעה על חוק הגיוס נדחתה\"\n\nאחרי כל הנושאים:\n━━━━━━━━━━━━━━━━━━━━\n💡 *זווית קלנר:* [נושא מדויק לתגובה]\n📲 *פעולה מוצעת:* [הצהרה / פוסט / יוזמה — ספציפי]\n\nכללי: 3-7 נושאים מהחם לשקט. ⚡ ב-2+ קבוצות | 🔥 בקבוצה אחת | ⭐ לפני הסמל אם רלוונטי במיוחד לקלנר. עברית בלבד. אין כותרות, הקדמות, הסברים.`;
            const scanResult = await sc(scanPrompt, [], { prefill: '📋 *' });
            const _legend = `\n━━━━━━━━━━━━━━━━━━━━\n🔑 *מפתח:* ⚡ = נושא ב-2+ קבוצות | 🔥 = קבוצה אחת | ⭐ = רלוונטי במיוחד לקלנר`;
            await botSend(oc, header + scanResult + _legend);
          }
        } else if (d.action === 'send_message') {
          const {target:t,message:msg,type:tp} = d.params;
          if (tp==='email') { const{sendEmail:se}=require('./src/gmail'); await se(t,d.params.subject||'',msg); await botSend(oc,`⏰ יומי #${did} — מייל ל-${t}`); }
          else { let n=t.replace(/[\s\-\+\(\)]/g,''); if(n.startsWith('0'))n='972'+n.substring(1); if(!n.endsWith('@c.us'))n+='@c.us'; const tc=await client.getChatById(n); await tc.sendMessage(msg); await botSend(oc,`⏰ יומי #${did} — הודעה ל-${tc.name||t}`); }
        }
      } catch (err) { logger.error(`❌ Daily #${did}: ${err.message}`); }
    }, { timezone: 'Asia/Jerusalem' });
    dailyTasks.set(did, { cronJob: cron, time: d.time, action: d.action, params: d.params, label: d.label });
    restoredDaily++;
  }

  if (restoredScheduled || restoredDaily) {
    logger.info(`♻️ שוחזרו: ${restoredScheduled} תזמונים, ${restoredDaily} משימות יומיות`);
  }

  // ── Warm-up scan groups + extra chats into WhatsApp Store ─────
  // After restart, Chromium cache is empty → groups return 0-1 msgs.
  // Two-pass warm-up: first at 15s, retry sparse groups at 60s.
  // The list combines:
  //   1. The daily group_summary scan-task groups (from daily.json)
  //   2. Extra chats from data/extra-warmup.json (user-editable list,
  //      e.g. lobby chats that aren't part of the daily political scan
  //      but should still be summarizable on demand).
  const _loadExtraWarmupChats = () => {
    try {
      const p = path.join(__dirname, 'data', 'extra-warmup.json');
      if (!fs.existsSync(p)) return [];
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(data?.chats) ? data.chats.filter(Boolean) : [];
    } catch (e) {
      logger.warn(`⚠️ Could not load extra-warmup.json: ${e.message?.substring(0, 60)}`);
      return [];
    }
  };
  const _doWarmup = async (passLabel) => {
    try {
      const scanTask = [...dailyTasks.values()].find(d => d.action === 'group_summary');
      const scanGroups = scanTask?.params?.groups || [];
      const extraGroups = _loadExtraWarmupChats();
      // Merge + dedupe (some chats may appear in both lists)
      const allTargets = [...new Set([...scanGroups, ...extraGroups])];
      if (!allTargets.length) return [];
      const allChats = await client.getChats();
      const sparseGroups = [];
      logger.info(`🔥 Warming up ${allTargets.length} chats (${scanGroups.length} scan + ${extraGroups.length} extra) (${passLabel})...`);
      for (const gn of allTargets) {
        try {
          const ch = findChatByName(allChats, gn);
          if (!ch) { logger.warn(`⚠️ Warm-up: group not found: "${gn}"`); continue; }
          const msgs = await safeFetchMessages(ch, 50);
          if (msgs._usedFallback || msgs.length < 3) sparseGroups.push(gn);
        } catch { sparseGroups.push(gn); }
      }
      logger.info(`✅ Warm-up (${passLabel}) complete — ${sparseGroups.length} sparse groups remain`);
      return sparseGroups;
    } catch (e) { logger.warn('⚠️ Warm-up failed:', e.message?.substring(0, 60)); return []; }
  };
  setTimeout(async () => {
    const sparse = await _doWarmup('pass 1');
    if (sparse.length > 0) {
      // Give WhatsApp Web 45 more seconds to sync, then retry sparse groups
      setTimeout(() => _doWarmup('pass 2'), 45000);
    }
  }, 15000);

  // ── Blocklist sweep: purge cached messages from spam groups on startup ──
  if (_BLOCKED_GROUP_PATTERNS.length > 0) {
    setTimeout(async () => {
      try {
        let purgedGroups = 0, purgedMsgs = 0;
        for (const cid of Object.keys(_msgCache)) {
          if (_blockedJids.has(cid)) continue;
          try {
            const chat = await client.getChatById(cid);
            const name = chat?.name || '';
            _jidNames.set(cid, name);
            if (_BLOCKED_GROUP_PATTERNS.some(p => name.includes(p))) {
              _blockedJids.add(cid);
              const n = _msgCache[cid]?.length || 0;
              logger.info(`🚫 Blocked group "${name}" — purging ${n} cached msgs`);
              delete _msgCache[cid];
              _msgCacheDirty = true;
              purgedGroups++; purgedMsgs += n;
            }
          } catch {}
        }
        if (purgedGroups > 0) logger.info(`🚫 Blocklist sweep: purged ${purgedGroups} group(s), ${purgedMsgs} msg(s)`);
      } catch (e) { logger.warn('⚠️ Blocklist sweep failed:', e.message?.substring(0, 60)); }
    }, 20000);
  }

  // ── Startup notification (cloud deploy only) ──────────────────
  // Sends a message to the owner when the bot starts on Railway/Render.
  // Confirms the bot can both connect AND send messages.
  if (process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER_EXTERNAL_URL) {
    setTimeout(async () => {
      try {
        const oc = await client.getChatById(OWNER_ID);
        const env = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_URL || 'cloud';
        await oc.sendMessage(
          `🚀 *בוטי הופעל!*\n✅ מחובר ומוכן לפקודות\n📡 ${env}\n⏰ ${new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}` + BOT_MARKER,
        );
        logger.info('📲 Startup notification sent to owner');
      } catch (e) {
        logger.warn('⚠️ Startup notification failed:', e.message?.substring(0, 60));
      }
    }, 8000); // wait 8s for connection to fully stabilise
  }
});

// ─── Owner notification (email) — rate-limited so we never spam ───────
const OWNER_EMAIL = 'moshikoohana@gmail.com';
const _notifyStateFile = path.join(__dirname, 'data', 'bot-down-notify.json');
function _loadNotifyState() { try { return JSON.parse(fs.readFileSync(_notifyStateFile, 'utf8')); } catch { return { lastSent: 0 }; } }
function _saveNotifyState(s) { try { fs.writeFileSync(_notifyStateFile, JSON.stringify(s)); } catch {} }
let _reconnectAttempts = 0;

async function notifyOwnerBotDown(kind, details) {
  const now = Date.now();
  const state = _loadNotifyState();
  // Rate-limit: at most one email per 5 minutes (avoid spam on flap)
  if (now - (state.lastSent || 0) < 5 * 60 * 1000) {
    logger.info(`📧 Bot-down email suppressed (rate-limit) — ${kind}`);
    return;
  }
  try {
    const { sendEmail } = require('./src/gmail');
    const hostName = os.hostname();
    const whenIL = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    const subject = `🚨 בוטי נותק מוואטסאפ — ${kind}`;
    const body = [
      `<b>⚠️ הבוט איבד את החיבור לוואטסאפ</b>`,
      ``,
      `<b>סוג:</b> ${kind}`,
      `<b>פרטים:</b> ${String(details || '').replace(/[<>]/g,'')}`,
      `<b>שעה:</b> ${whenIL}`,
      `<b>מחשב:</b> ${hostName}`,
      `<b>PID:</b> ${process.pid}`,
      `<b>Uptime:</b> ${Math.round(process.uptime()/60)} דקות`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<b>מה לעשות:</b>`,
      `1. פתח <a href="http://localhost:3000">http://localhost:3000</a>`,
      `2. אם רואים QR — סרוק בוואטסאפ (מכשירים מקושרים)`,
      `3. אם לא רואים כלום — הפעל מחדש את הבוט`,
      ``,
      `הבוט מנסה להתחבר אוטומטית כרגע (עד 5 ניסיונות).`,
    ].join('\n');
    await sendEmail(OWNER_EMAIL, subject, body);
    _saveNotifyState({ lastSent: now, kind, details: String(details||'').substring(0,200) });
    logger.info(`📧 Bot-down email sent to ${OWNER_EMAIL} — ${kind}`);
  } catch (e) {
    logger.warn(`📧 Bot-down email FAILED: ${e.message?.substring(0,120)}`);
  }
}

// ─── Auto-reconnect: try to revive the client in-process before exiting ──
async function attemptReconnect(reason) {
  _reconnectAttempts++;
  if (_reconnectAttempts > 5) {
    logger.error(`💀 Reconnect exhausted (5 attempts). Exiting so process-supervisor can restart.`);
    await notifyOwnerBotDown('reconnect-exhausted', `תם מכסת ניסיונות החיבור (5). סיבה אחרונה: ${reason}`);
    process.exit(1);
    return;
  }
  const delayS = Math.min(60, 5 * _reconnectAttempts); // 5s, 10s, 15s, 20s, 25s
  logger.warn(`🔄 Reconnect attempt ${_reconnectAttempts}/5 in ${delayS}s — reason: ${reason}`);
  setTimeout(async () => {
    // ── Cleanup before reconnect ──
    // Watchdog kills can leave: (a) the puppeteer Chromium still
    // running and holding the userDataDir lock, (b) stale Singleton*
    // files in .wwebjs_auth/. If we don't clean both, initialize()
    // will fail with "browser is already running for ...". We do that
    // BEFORE every retry — safe because we only run one bot/dataDir.
    try {
      // Try graceful destroy of the old client (closes its puppeteer)
      try { await client.destroy(); } catch (_) {}
    } catch (_) {}
    try {
      const authDir = path.join(__dirname, '.wwebjs_auth');
      const lockNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
      let cleared = 0;
      const walk = (dir, depth = 0) => {
        if (depth > 4) return;
        try {
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, item.name);
            if (item.isDirectory()) { walk(p, depth + 1); continue; }
            if (lockNames.includes(item.name)) { try { fs.unlinkSync(p); cleared += 1; } catch (_) {} }
          }
        } catch (_) {}
      };
      if (fs.existsSync(authDir)) walk(authDir);
      if (cleared > 0) logger.info(`🔓 Pre-reconnect: cleared ${cleared} stale lock file(s)`);
    } catch (_) {}

    try {
      await client.initialize();
      logger.info(`✅ Reconnect attempt ${_reconnectAttempts} — initialize() resolved`);
    } catch (e) {
      logger.warn(`⚠️ Reconnect attempt ${_reconnectAttempts} failed: ${e.message?.substring(0,80)}`);
      attemptReconnect(`init-fail: ${e.message?.substring(0,50)}`);
    }
  }, delayS * 1000);
}

client.on('disconnected', async (reason) => {
  console.log('❌ נותק:', reason);
  botStatus = 'disconnected';
  lastError = { message: `disconnected: ${reason}`, ts: new Date().toISOString() };
  io.emit('status', 'disconnected');
  // Fire-and-forget — don't block the disconnect handler
  notifyOwnerBotDown('disconnected', reason).catch(()=>{});
  attemptReconnect(`disconnected: ${reason}`);
});

client.on('auth_failure', async (msg) => {
  logger.error(`🔴 auth_failure: ${msg}`);
  botStatus = 'disconnected';
  lastError = { message: `auth_failure: ${msg}`, ts: new Date().toISOString() };
  io.emit('status', 'disconnected');
  notifyOwnerBotDown('auth_failure', msg).catch(()=>{});
  // auth_failure usually means session invalid — need QR; process-level restart helps
  attemptReconnect(`auth_failure: ${msg}`);
});

// Reset reconnect counter once we're fully ready again
client.on('ready', () => { _reconnectAttempts = 0; });

// ─── Crisis War-Room — auto-triggered when 3+ critical alerts fire in 30 min ─────
// Replaces the noise of 4 separate alerts with one consolidated brief:
// aggregated group activity, web context, and a draft response. The user
// gets the FULL situational picture in one place + ready-to-send draft.
async function triggerWarRoom(trigger) {
  const { startCrisis } = require('./src/crisis-mode');
  startCrisis(trigger);   // mark active so subsequent alerts are suppressed
  try {
    const oc = await client.getChatById(OWNER_ID);
    const { smartChat: _sc } = require('./src/claude');

    // Build the alert summary table for the war-room header
    const alertSummary = trigger.alerts.map(a => {
      const t = new Date(a.ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
      return `🕐 ${t} · "${a.keyword}" · 📍 ${a.group}`;
    }).join('\n');

    // Send opening message immediately so user knows war-room is starting
    const opener = [
      '🚨🚨🚨 *מצב חירום — מצב חירום זוהה אוטומטית*',
      `📊 ${trigger.count} התראות קריטיות תוך ${trigger.spanMinutes} דקות:`,
      '━━━━━━━━━━━━━━━━━━━━',
      alertSummary,
      '━━━━━━━━━━━━━━━━━━━━',
      '_מכין סקירה מצרפית + טיוטת תגובה... (15-30 שניות)_',
    ].join('\n');
    await botSend(oc, opener);

    // Aggregate analysis prompt — let Claude do web_search + spokesperson
    const dominantKeywords = trigger.keywords.join(', ');
    const dominantGroups = trigger.groups.join(', ');
    const previews = trigger.alerts.slice(0, 5).map((a, i) =>
      `${i + 1}. [${a.group}] "${a.preview.substring(0, 200)}"`).join('\n');

    const warRoomPrompt = `<crisis_brief>
זוהה מצב חירום: ${trigger.count} התראות קריטיות מ-${trigger.groups.length} קבוצות תוך ${trigger.spanMinutes} דק'.
מילות מפתח: ${dominantKeywords}
קבוצות פעילות: ${dominantGroups}

<recent_messages_from_groups>
${previews}
</recent_messages_from_groups>
</crisis_brief>

<task>
1. הפעל web_search לזיהוי הסיפור המרכזי (1-2 חיפושים, השתמש בכותרות מההודעות).
2. הפעל spokesperson(action=response, topic=הנושא המרכזי) כדי לקבל הקשר עמדות+הישגים.
3. נסח טיוטת תגובת דוברות בסגנון קלנר (חד, ישיר, לאומי).
</task>

<rules>
- אם החיפוש לא העלה תוכן רלוונטי — השתמש רק בקטעי ההודעות מהקבוצות.
- אסור להמציא עובדות.
- הציטוט: 2-3 משפטים בלבד.
</rules>

<output_format>
🌐 *הסיפור המרכזי (web search):*
[2-3 משפטים מסכמים, עם מקור]

📊 *מצב הקבוצות:*
[רשימת קבוצות פעילות + ספירה]

📝 *טיוטת תגובה:*
ח"כ אריאל קלנר (ליכוד): "[ציטוט]"

⚡ *פעולות מהירות:*
1️⃣ שלח לכל הכתבים (media_tracker)
2️⃣ פרסם כציוץ (טיוטת X — קצרה יותר)
3️⃣ סיים מצב חירום
</output_format>`;

    const result = await _sc(warRoomPrompt, [], { webSearchMaxUses: 2, timeoutMs: 120000 });
    await botSend(oc, `📋 *מצב חירום — סקירה מצרפית*\n${'━'.repeat(20)}\n\n${result}`);
  } catch (e) {
    logger.error('triggerWarRoom error:', e.message?.substring(0, 100));
    try {
      const oc = await client.getChatById(OWNER_ID);
      await botSend(oc, `⚠️ ניסיתי להפעיל מצב חירום אבל הסקירה המצרפית נכשלה: ${e.message?.substring(0, 80)}\n\nההתראות עדיין נרשמו ב-data/crisis-recent-alerts.json. תגיד "סיים חירום" כדי לחזור למצב רגיל.`);
    } catch (_) {}
  }
}

// ─── Interactive calendar-event flow — multi-step poll-based UI ──
// Drives the user through Date → Time → Duration → Location → Title →
// Confirm using WhatsApp polls (tap-to-pick) instead of free typing.
// Each step is one poll OR (in title's case) a free-text prompt.
async function advanceCalendarFlow(flow) {
  const ifl = require('./src/interactive-flow');
  const { Poll } = require('whatsapp-web.js');

  const oc = await client.getChatById(OWNER_ID);
  const stepName = ifl.getStepName(flow);
  const prompt = ifl.getStepPrompt(flow);

  // ALL flow messages must include BOT_MARKER so they don't bounce back
  // through the self-DM message_create handler and re-trigger Claude.

  // Title step — plain text prompt (no poll)
  if (stepName === 'title') {
    await oc.sendMessage(prompt + BOT_MARKER);
    return;
  }

  // Confirm step — poll, but result handler must commit/cancel
  if (stepName === 'confirm') {
    await oc.sendMessage(prompt + BOT_MARKER);
    const opts = ifl.getOptionsForStep(flow);
    const poll = new Poll('בחר פעולה:', opts.map(o => o.label), { allowMultipleAnswers: false });
    const sentMsg = await oc.sendMessage(poll);
    ifl.updateFlow(flow.chatId, { activePollId: sentMsg?.id?._serialized || null });
    return;
  }

  // Last step? — flow.step >= CALENDAR_STEPS.length means commit time
  if (flow.step >= ifl.CALENDAR_STEPS.length) {
    await commitCalendarFlow(flow);
    return;
  }

  // Regular poll-based step (date / time / duration / location)
  const opts = ifl.getOptionsForStep(flow);
  if (!opts.length) {
    await oc.sendMessage(`⚠️ שלב לא ידוע: ${stepName}` + BOT_MARKER);
    ifl.endFlow(flow.chatId);
    return;
  }

  // Send the prompt (with marker) + poll
  await oc.sendMessage(prompt + BOT_MARKER);
  const pollName = `בחר אופציה (שלב ${flow.step + 1}/${ifl.CALENDAR_STEPS.length})`;
  const poll = new Poll(pollName, opts.map(o => o.label), { allowMultipleAnswers: false });
  const sentMsg = await oc.sendMessage(poll);
  ifl.updateFlow(flow.chatId, { activePollId: sentMsg?.id?._serialized || null });
}

async function commitCalendarFlow(flow) {
  const ifl = require('./src/interactive-flow');
  const oc = await client.getChatById(OWNER_ID);
  const d = flow.data;

  try {
    // Bypass the natural-language parser in addCalendarEvent — call the
    // Google Calendar API directly with our structured data.
    const calendarLib = require('./src/calendar');
    const { google } = require('googleapis');
    const auth = await calendarLib.getAuthClient();
    const cal = google.calendar({ version: 'v3', auth });

    const [hh, mm] = (d.time || '09:00').split(':').map(n => parseInt(n, 10));
    // Build local "wall-time" ISO string + send timeZone=Asia/Jerusalem
    // so Google interprets the times in the right zone.
    const startLocal = `${d.dateISO}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
    const startDate = new Date(`${startLocal}+03:00`);
    const endDate = new Date(startDate.getTime() + (d.durationMinutes || 60) * 60000);

    const event = {
      summary: d.title,
      start: { dateTime: startLocal, timeZone: 'Asia/Jerusalem' },
      end: {
        dateTime: endDate.toISOString().replace(/\.\d+Z$/, ''),
        timeZone: 'Asia/Jerusalem',
      },
    };
    if (d.location) event.location = d.location;

    const res = await cal.events.insert({ calendarId: 'primary', resource: event });

    await botSend(oc,
      `✅ *הפגישה נוספה ליומן!*\n\n` +
      `📌 *${d.title}*\n` +
      `📅 ${d.dateLabel}\n` +
      `🕐 ${d.time} (${d.duration})\n` +
      (d.location ? `📍 ${d.location}\n` : '') +
      (res?.data?.htmlLink ? `\n🔗 ${res.data.htmlLink}` : '')
    );
  } catch (e) {
    logger.error('commitCalendarFlow failed:', e.message?.substring(0, 200));
    await botSend(oc, `❌ הוספה ליומן נכשלה: ${e.message?.substring(0, 100)}\n\n_הפרטים שאספתי:_\n📌 ${d.title}\n📅 ${d.dateLabel} ${d.time}\n${d.location ? '📍 ' + d.location : ''}\n\nתוכל להוסיף ידנית או לנסות שוב ("פגישה חדשה").`);
  } finally {
    ifl.endFlow(flow.chatId);
  }
}

// ─── Onboarding flow — show menu / category content ─────────────
async function advanceOnboardingFlow(flow) {
  const onb = require('./src/onboarding-flow');
  const { Poll } = require('whatsapp-web.js');

  const oc = await client.getChatById(OWNER_ID);
  const prompt = onb.getCurrentMenuPrompt(flow);
  const opts = onb.getCurrentMenuOptions(flow);

  // BOT_MARKER on all outgoing so they don't bounce back as input
  await oc.sendMessage(prompt + BOT_MARKER);
  if (!opts.length) return;

  const pollName = flow.state === 'top_menu' ? 'בחר נושא:' : 'מה הלאה?';
  const poll = new Poll(pollName, opts.map(o => o.label), { allowMultipleAnswers: false });
  const sentMsg = await oc.sendMessage(poll);
  onb.updateFlow(flow.chatId, { activePollId: sentMsg?.id?._serialized || null });
}

// ─── Poll vote handler — drives all interactive flows ─────────
client.on('vote_update', async (vote) => {
  try {
    const ifl = require('./src/interactive-flow');
    const onb = require('./src/onboarding-flow');
    const parentId = vote.parentMessage?.id?._serialized;
    if (!parentId) return;

    // Don't react to votes from anyone but the owner
    if (vote.voter && vote.voter !== OWNER_ID && !vote.voter.includes('48129453875330')) {
      return;
    }

    const selected = vote.selectedOptions?.[0]?.name || vote.selectedOptions?.[0]?.localId;
    if (!selected) return;

    const oc = await client.getChatById(OWNER_ID);

    // Try matching the calendar-event flow first
    for (const f of ifl.flows.values()) {
      if (f.activePollId === parentId) {
        const result = ifl.applyVote(f, selected);
        if (result.error) { await botSend(oc, `⚠️ ${result.error}`); return; }
        if (result.cancel) { ifl.endFlow(f.chatId); await botSend(oc, '❌ הפגישה בוטלה.'); return; }
        if (result.restart) {
          ifl.endFlow(f.chatId);
          ifl.startFlow(f.chatId, 'calendar_event');
          await botSend(oc, '🔄 מתחילים מחדש...');
          await advanceCalendarFlow(ifl.getFlow(f.chatId));
          return;
        }
        if (result.commit) { await commitCalendarFlow(f); return; }
        if (result.needsText) { await botSend(oc, `✏️ ${result.needsText}`); return; }
        if (result.ok) { await advanceCalendarFlow(f); }
        return;
      }
    }

    // Try matching the onboarding flow
    for (const f of onb.flows.values()) {
      if (f.activePollId === parentId) {
        const result = onb.applyVote(f, selected);
        if (result.error) { await botSend(oc, `⚠️ ${result.error}`); return; }
        if (result.exit) {
          onb.endFlow(f.chatId);
          await botSend(oc, '✅ נסגר. תמיד אפשר לחזור עם "תפריט". יום מוצלח! 🚀');
          return;
        }
        if (result.ok) { await advanceOnboardingFlow(f); }
        return;
      }
    }
  } catch (e) {
    logger.error('vote_update handler failed:', e.message?.substring(0, 100));
  }
});

// ─── Send helper (auto-split long messages) ────────────────────
const MAX_MSG_LEN = 3000;

async function botSend(chat, text) {
  // Persist outgoing message to chat log (best-effort, never throws)
  try { appendChatLog({ from: 'בוטי', text, direction: 'out', chatId: chat?.id?._serialized || '' }); } catch {}
  const full = text + BOT_SIG + BOT_MARKER;
  if (full.length <= MAX_MSG_LEN) {
    return chat.sendMessage(full);
  }

  // Smart split: break at paragraph boundaries (double newline), then section
  // headers (lines starting with * or ━), then single newlines as last resort.
  const LIMIT = MAX_MSG_LEN - 200;
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? current + '\n\n' + para : para;
    if (candidate.length > LIMIT && current.length > 0) {
      chunks.push(current);
      // If single paragraph is too long, split by lines
      if (para.length > LIMIT) {
        const lines = para.split('\n');
        let lineBuf = '';
        for (const line of lines) {
          const lc = lineBuf ? lineBuf + '\n' + line : line;
          if (lc.length > LIMIT && lineBuf.length > 0) {
            chunks.push(lineBuf);
            lineBuf = line;
          } else {
            lineBuf = lc;
          }
        }
        current = lineBuf;
      } else {
        current = para;
      }
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  // Send chunks with part numbers
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    // Every chunk must include BOT_SIG — WhatsApp may strip BOT_MARKER, which would
    // re-trigger the self-chat handler for intermediate parts only.
    const suffix = isLast ? BOT_SIG + BOT_MARKER : `\n\n_📄 חלק ${i + 1}/${chunks.length}_` + BOT_SIG + BOT_MARKER;
    await chat.sendMessage(chunks[i] + suffix);
  }
}

// ─── Face-recognition queue ───────────────────────────────────────
// TensorFlow.js is single-threaded. Running 20+ detections concurrently
// (e.g. when a burst of photos arrives) saturates the CPU and causes silent
// failures. This queue serialises all face-detection work so photos are
// processed one at a time.
let _faceQueue = Promise.resolve();
function _queueFace(fn) {
  const next = _faceQueue
    .then(fn)
    .catch((err) => console.error('Face queue error:', err.message?.substring(0, 80)));
  _faceQueue = next.catch(() => {}); // never let the chain break
  return next;
}

// ─── Message Handler ─────────────────────────────────────────────
// album = multiple photos sent at once (WhatsApp bundles them)
const ALLOWED_TYPES = new Set(['chat', 'image', 'sticker', 'ptt', 'audio', 'document', 'album']);

client.on('message_create', async (msg) => {
  // 🔍 Early diagnostic log — visible in Railway/cloud logs
  console.log(`📩 msg_create: type=${msg.type} from=${(msg.from||'').substring(0,25)} to=${(msg.to||'').substring(0,25)} fromMe=${msg.fromMe}`);
  // Persist group messages to disk for scan resilience across restarts
  if (!msg.fromMe) _cacheGroupMsg(msg);
  try {
    // Only handle text and images
    if (!ALLOWED_TYPES.has(msg.type)) return;

    // ── Owner-sent group photo → ownerGroups face recognition ──────
    // Must run BEFORE the self-chat-only check below.
    // Supports: @g.us (modern groups), @g (legacy groups), @newsletter (WhatsApp Channels)
    const _isGroupJid = (jid) => jid && (jid.endsWith('@g.us') || jid.endsWith('@g') || jid.includes('@newsletter') || jid.includes('@newsle'));
    const _isGroupMsg = _isGroupJid(msg.from) || _isGroupJid(msg.to);
    if (msg.fromMe && (msg.type === 'image' || msg.type === 'album') && _isGroupMsg) {
      // Guard: skip the bot's own result photos to prevent infinite loop
      if (msg.body?.includes(BOT_MARKER)) return;
      // Queue — don't run concurrent face detections (CPU saturation)
      _queueFace(async () => {
      try {
        const status = getFaceStatus();
        if (status.enabled && status.totalReferences > 0 && (status.ownerGroups || []).length > 0) {
          const grpChat = await msg.getChat();
          if (!grpChat.isGroup) { /* skip non-group */ } else {
          const groupName = grpChat.name || '';
          const ownerGroups = status.ownerGroups || [];
          const isOwnerGroup = ownerGroups.some(g => groupName.includes(g) || g.includes(groupName));
          if (isOwnerGroup) {
            console.log(`📷 Owner photo in test group "${groupName}" — checking faces...`);
            const media = await msg.downloadMedia();
            if (media?.data) {
              const imageBuffer = Buffer.from(media.data, 'base64');
              const matches = await findMatches(imageBuffer);
              const ownerChat = await client.getChatById(OWNER_ID);
              if (matches.length > 0) {
                const match = matches[0];
                const allNames = matches.map(m => `${m.name} (${m.confidence}%)`).join(', ');
                const time = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
                const { MessageMedia } = require('whatsapp-web.js');
                const baseCaption = `🧪 *בדיקה:* זוהה — *${allNames}*\n📍 ${groupName} · ⏰ ${time}`;
                // Compute highlight once — reuse for both owner DM and group reply
                let markedBuf = null; let hlNote = '';
                try {
                  const { buffer: _b, highlighted, blurred: hlB } =
                    await highlightMatchingFaces(imageBuffer, { blurOthers: false });
                  markedBuf = _b;
                  hlNote = ` · 🟢 ${highlighted} זוהה${hlB > 0 ? ` · 🔴 ${hlB} לא זוהה` : ''}`;
                } catch (hlErr) { /* will send text fallback */ }
                // Send to owner DM
                if (markedBuf) {
                  const mm = new MessageMedia('image/jpeg', markedBuf.toString('base64'), 'test.jpg');
                  await ownerChat.sendMessage(mm, { caption: baseCaption + hlNote + BOT_MARKER });
                } else {
                  await ownerChat.sendMessage(baseCaption + BOT_MARKER);
                }
                // Reply directly to the photo in the group (test group only)
                try {
                  if (markedBuf) {
                    const gm = new MessageMedia('image/jpeg', markedBuf.toString('base64'), 'result.jpg');
                    await msg.reply(gm, null, { caption: `🟢 זוהה: *${allNames}*` + BOT_MARKER });
                  } else {
                    await msg.reply(`🟢 זוהה: *${allNames}*` + BOT_MARKER);
                  }
                } catch (e) { /* silent */ }
                console.log(`🎀 Test match: ${allNames} in "${groupName}"`);
              } else {
                console.log(`📷 No match in owner test photo from "${groupName}"`);
                // Reply directly to the photo so it's clear which image wasn't recognized
                try { await msg.reply(`🔍 לא זוהו פנים מוכרים` + BOT_MARKER); } catch (e) { /* silent */ }
              }
            }
          }
        }
        } // closes if (status.enabled...)
      } catch (ownerGrpErr) {
        if (!ownerGrpErr.message?.includes('not initialized')) {
          console.error('Owner group photo error:', ownerGrpErr.message?.substring(0, 80));
        }
      }
      }); // closes _queueFace
      return; // done — don't fall through to self-chat handler
    }

    // ── Keyword alert for owner's OWN messages to groups ─────────────
    // (messages fromMe=true to groups bypass the self-chat check below)
    if (msg.fromMe && _isGroupMsg && msg.body && msg.body.length > 2 && !msg.body.includes(BOT_MARKER)) {
      const { checkMessage: _ckOwner } = require('./src/keyword-alerts');
      const _matchOwner = _ckOwner(msg.body, msg.to || msg.from);
      if (_matchOwner) {
        try {
          const _grpCht = await msg.getChat();
          const _ownerC = await client.getChatById(OWNER_ID);
          const _preview = stripUrls(msg.body.substring(0, 150));
          await botSend(_ownerC,
            `🚨 *התראה — מילת מפתח: "${_matchOwner}"*\n` +
            `📍 *${_grpCht.name || msg.to}*\n` +
            `👤 אתה\n` +
            `💬 "${_preview}${_preview.length >= 150 ? '...' : ''}"`
          );
          require('./src/keyword-alerts').logAlert(_matchOwner, _grpCht.name || msg.to, 'אתה', _preview);
        } catch (_oe) { /* silent */ }
      }
    }

    const chatId = msg.from;
    const toId = msg.to;

    // ── Self-LID auto-capture ─────────────────────────────────────
    // WhatsApp "Message Yourself" feature: when we see a fromMe message
    // where from === to and both are @lid, that's the user's own self-LID.
    // Save it once, then use it for strict filtering (avoid responding in
    // other contacts' chats that happen to use @lid identifiers).
    if (msg.fromMe === true &&
        typeof chatId === 'string' && typeof toId === 'string' &&
        chatId.endsWith('@lid') && toId.endsWith('@lid') &&
        chatId === toId) {
      saveOwnerLid(chatId);
    }

    // ONLY self-chat — covers 3 strict formats:
    //   1. Legacy:    from=OWNER@c.us, to=OWNER@c.us
    //   2. Hybrid:    from=OWNER@c.us, to=ownerSelfLid (fromMe=true)
    //   3. Pure LID:  from=ownerSelfLid, to=ownerSelfLid (fromMe=true)
    if (!chatId || !toId) return;
    const isLegacySelf = chatId === OWNER_ID && toId === OWNER_ID;
    const isHybridSelf = ownerSelfLid && chatId === OWNER_ID && msg.fromMe === true && toId === ownerSelfLid;
    const isLidSelf    = ownerSelfLid && msg.fromMe === true && chatId === ownerSelfLid && toId === ownerSelfLid;
    if (!isLegacySelf && !isHybridSelf && !isLidSelf) return;

    let rawBody = msg.body || '';
    if (rawBody.includes(BOT_MARKER)) return;
    // WhatsApp often strips zero-width BOT_MARKER when syncing; botSend() always
    // appends a visible signature — use it to ignore our own self-chat replies.
    if (rawBody.includes('— *🤖 בוטי*')) return;
    // Interim lines sent with sendMessage (no BOT_SIG) — must not re-enter the AI
    const _trimSelf = rawBody.trim();
    if (_trimSelf.startsWith('📸 _שומר תמונת ייחס') || _trimSelf.startsWith('🔍 _בודק פנים') || _trimSelf.startsWith('⏳ שנייה, עובד')) {
      return;
    }
    if (_trimSelf.startsWith('🎬 הנה הסרטון!') || _trimSelf.includes('🧪 *בדיקת חיבור מ-Railway')) return;
    // Image captions from face test / feedback (only BOT_MARKER — may be stripped on echo)
    if (/^🟢 \d+ מסומן|^🔴 אף אחד לא זוהה|^🔒 \d+ פנים טושטשו|^🟢 \*תיקון:\*|^📸 תמונה מקורית ללא עיבוד/.test(_trimSelf)) {
      return;
    }

    // ── Bot sleep/wake toggle ─────────────────────────────────────
    if (rawBody.trim() === 'היי בוטי') {
      botSleeping = false;
      try { await msg.react('✅'); } catch (_) {}
      const _wakeChat = await client.getChatById(OWNER_ID);
      await botSend(_wakeChat, 'בוטי ער ומוכן לפקודות! 🤖✅');
      return;
    }
    if (rawBody.trim() === 'ביי בוטי') {
      botSleeping = true;
      try { await msg.react('💤'); } catch (_) {}
      const _sleepChat = await client.getChatById(OWNER_ID);
      await botSend(_sleepChat, 'בוטי הולך לישון... 💤 שלח "היי בוטי" כדי להעיר אותי.');
      return;
    }
    // ── Crisis mode commands ─────────────────────────────────────
    const _trim = rawBody.trim();
    if (_trim === 'סיים חירום' || _trim === 'סיום חירום' || _trim === 'בטל חירום') {
      const { isCrisisActive: _isAct, endCrisis: _endC } = require('./src/crisis-mode');
      const wasActive = _isAct();
      _endC();
      try { await msg.react('✅'); } catch (_) {}
      const _ec = await client.getChatById(OWNER_ID);
      await botSend(_ec, wasActive ? '✅ מצב חירום הסתיים. חוזרים להתראות רגילות.' : 'ℹ️ לא היה מצב חירום פעיל.');
      return;
    }
    if (_trim === 'סטטוס חירום' || _trim === 'מצב חירום') {
      const { getActiveCrisis: _getC } = require('./src/crisis-mode');
      const c = _getC();
      const _sc = await client.getChatById(OWNER_ID);
      if (!c) { await botSend(_sc, '🟢 אין מצב חירום פעיל כרגע.'); return; }
      const ageMin = Math.round((Date.now() - c.startedAt) / 60000);
      await botSend(_sc, `🚨 *מצב חירום פעיל*\nהחל: לפני ${ageMin} דק'\nסיבה: ${c.triggerCount} התראות (${c.triggerKeywords.join(', ')}) ב-${c.spanMinutes} דק'\nקבוצות: ${c.triggerGroups.join(', ')}\n\nאמור "סיים חירום" כדי לכבות.`);
      return;
    }
    if (botSleeping) return;

    // ── Interactive flow — text input for active flow ────────────
    // Polls let the user tap an option (handled by vote_update). When
    // a step requires free text (e.g. event title) OR the user typed
    // an "OTHER" custom value, the flow waits for incoming text here.
    {
      const ifl = require('./src/interactive-flow');
      const flowChatId = msg.from;
      const activeFlow = ifl.getFlow(flowChatId);
      if (activeFlow && rawBody && rawBody.trim().length > 0) {
        // Cancel keywords abort the flow at any step
        if (/^(בטל|ביטול|cancel|stop|עצור)$/i.test(rawBody.trim())) {
          ifl.endFlow(flowChatId);
          const _c = await client.getChatById(OWNER_ID);
          await botSend(_c, '❌ הפגישה בוטלה. אם תרצה לנסות שוב — אמור "פגישה חדשה".');
          return;
        }
        const result = ifl.applyText(activeFlow, rawBody);
        if (result.error) {
          const _c = await client.getChatById(OWNER_ID);
          await botSend(_c, `⚠️ ${result.error}\n\n_שלח שוב או "בטל"_`);
          return;
        }
        if (result.ok) {
          await advanceCalendarFlow(activeFlow);
          return;
        }
      }
    }

    // ── Calendar event flow trigger ──────────────────────────────
    if (/^(פגישה חדשה|תכניס פגישה|תוסיף לי פגישה|תוסיף פגישה|פגישה חדשה ביומן|אירוע חדש)$/i.test(rawBody.trim())) {
      const ifl = require('./src/interactive-flow');
      const _c = await client.getChatById(OWNER_ID);
      ifl.startFlow(msg.from, 'calendar_event');
      const flow = ifl.getFlow(msg.from);
      await advanceCalendarFlow(flow);
      return;
    }

    // ── Onboarding/Help menu trigger ─────────────────────────────
    if (/^(תפריט|עזרה|מה אתה יכול\??|ברוכים הבאים|ברוך הבא|\/help|\/start|הסבר|help|menu)$/i.test(rawBody.trim())) {
      const onb = require('./src/onboarding-flow');
      onb.startFlow(msg.from);
      const flow = onb.getFlow(msg.from);
      await advanceOnboardingFlow(flow);
      return;
    }

    // ── Onboarding active — text input ignored (user must vote) ──
    {
      const onb = require('./src/onboarding-flow');
      const onbFlow = onb.getFlow(msg.from);
      if (onbFlow) {
        // User typed during onboarding — abort flow only if "בטל"/"exit"
        if (/^(בטל|ביטול|exit|stop|סגור|עצור)$/i.test(rawBody.trim())) {
          onb.endFlow(msg.from);
          const _c = await client.getChatById(OWNER_ID);
          await botSend(_c, '✅ תפריט נסגר. תמיד אפשר לחזור עם "תפריט".');
          return;
        }
        // Otherwise let normal Claude handler run (user might have a real question)
        // but DON'T return — fall through.
      }
    }

    // ── Reply-based feedback on forwarded photos / quoted context ────
    // Any reply to a bot photo message → smart feedback handler
    // Any other reply → include quoted text as context for Claude
    if (msg.hasQuotedMsg) {
      try {
        const quotedMsg = await msg.getQuotedMessage();
        const quotedId = quotedMsg?.id?._serialized;
        const photoData = quotedId ? forwardedPhotos.get(quotedId) : null;
        if (photoData) {
          const chat = await msg.getChat();
          await chat.sendStateTyping();
          const reply = await handlePhotoFeedback(rawBody.trim(), photoData, quotedId);
          await botSend(chat, reply);
          stats.sent++;
          log({ time: ts(), from: 'בוטי', text: reply.substring?.(0, 120) || '📸', direction: 'out' });
          return;
        }
        // Not a photo — prepend quoted text as context so Claude understands the reply
        const quotedText = (quotedMsg?.body || '').replace(BOT_MARKER, '').trim();
        if (quotedText) {
          rawBody = `[בתגובה ל: "${quotedText.substring(0, 300)}"]\n${rawBody}`;
        }
      } catch (quotedErr) {
        console.warn('Quoted msg lookup failed:', quotedErr.message?.substring(0, 60));
      }
    }

    // Handle voice messages
    if (msg.type === 'ptt' || msg.type === 'audio') {
      console.log(`📨 [${ts()}] 🎤 הודעה קולית`);
      stats.received++;
      log({ time: ts(), from: 'מושיקו', text: '🎤 הודעה קולית', direction: 'in' });

      const chat = await msg.getChat();
      await chat.sendStateTyping();

      const response = await handleVoice(msg, chatId);
      await botSend(chat, response);
      stats.sent++;
      log({ time: ts(), from: 'בוטי', text: response.substring(0, 120), direction: 'out' });
      return;
    }

    // Handle image messages
    if (msg.type === 'image' || msg.type === 'sticker') {
      const caption = rawBody.trim() || 'מה יש בתמונה?';

      // ── Reference photo for face recognition ──
      const refMatch = caption.match(/ייחוס\s+(?:של\s+)?(.+)/i);
      // Also check if this is a batch photo (no caption) after a recent "ייחוס" caption
      const batchRef = !refMatch && recentRefContext.get(chatId);
      const activeBatchRef = batchRef && batchRef.expiresAt > Date.now() ? batchRef : null;

      if (refMatch || activeBatchRef) {
        const refName = refMatch ? refMatch[1].trim() : activeBatchRef.name;
        // Update/extend the batch context
        recentRefContext.set(chatId, { name: refName, expiresAt: Date.now() + 8000 });
        console.log(`📨 [${ts()}] 📸 תמונת ייחוס: ${refName}`);
        stats.received++;
        log({ time: ts(), from: 'מושיקו', text: `📸 ייחוס ${refName}`, direction: 'in' });
        const chat = await msg.getChat();
        await chat.sendMessage('📸 _שומר תמונת ייחוס..._' + BOT_MARKER);
        const response = await handleReferencePhoto(msg, refName);
        await botSend(chat, response);
        stats.sent++;
        log({ time: ts(), from: 'בוטי', text: response.substring(0, 120), direction: 'out' });
        return;
      }

      // ── Test / highlight mode detection ───────────────────────
      // Caption triggers (prefix match, case-insensitive):
      //   "ייחוס [שם]"        → add reference photo
      //   "בדיקה"             → face match text report
      //   "בדיקת טשטוש"       → blur non-matching faces + report
      //   "סימון"             → green/red border overlay
      //   "סימון טשטוש"       → green border + blur others
      const trimCap = caption.trim();
      const isBlurTest     = /^(בדיקת טשטוש|טשטוש בלבד|blur test|blur)/i.test(trimCap);
      const isHighlightBlur = /^(סימון טשטוש|highlight blur|סמן טשטוש|בדיקת סימון טשטוש)/i.test(trimCap);
      const isHighlight    = /^(סימון|highlight|mark|סמן|הצג פנים|בדיקת סימון)/i.test(trimCap);
      const isFeedbackYes  = /^(פידבק כן|feedback yes|✅ נכון|נכון)/i.test(trimCap);
      const isFeedbackNo   = /^(פידבק לא|feedback no|❌ לא נכון|לא נכון)/i.test(trimCap);
      // "בדיקה" prefix (not "בדיקת טשטוש"/"בדיקת סימון" which are caught above)
      const isMatchTest    = /^(בדיקה|בדוק|test|טסט|זיהוי)/i.test(trimCap) && !isBlurTest && !isHighlightBlur && !isHighlight;

      if (isBlurTest || isHighlight || isHighlightBlur || isMatchTest) {
        const testType = isBlurTest ? '🔒 בדיקת טשטוש' : isHighlightBlur ? '🟢 סימון+טשטוש' : isHighlight ? '🟢 סימון' : '🔍 בדיקת זיהוי';
        console.log(`📨 [${ts()}] ${testType}`);
        stats.received++;
        log({ time: ts(), from: 'מושיקו', text: testType, direction: 'in' });
        const chat = await msg.getChat();
        await chat.sendMessage('🔍 _בודק פנים בתמונה..._' + BOT_MARKER);
        const response = await handleFaceTest(msg, isBlurTest, isHighlight || isHighlightBlur, isHighlightBlur);
        await botSend(chat, response);
        stats.sent++;
        log({ time: ts(), from: 'בוטי', text: response.substring(0, 120), direction: 'out' });
        return;
      }

      // ── If the caption is a WhatsApp/bot command, ignore the image and route as text ──
      // e.g. user sends a group screenshot with "סרוק לי את 50 ההודעות האחרונות בקבוצת X"
      const _isWACmd = caption.length > 5 && (
        /סריקת קבוצות|סקירת קבוצות|תסרוק|סרוק לי|הודעות אחרונות בקבוצת|סכם קבוצת|סכם את הקבוצה/i.test(caption) ||
        /שלח הודעה ל|תזמן הודעה|דוח התראות|התראות היום|מה חדש בבוט|סטטוס ניטור|תעשה סקירה|תעשה לי סריקה/i.test(caption)
      );
      if (_isWACmd) {
        console.log(`📨 [${ts()}] 🖼️→📝 כיתוב=פקודה: ${caption.substring(0, 80)}`);
        stats.received++;
        log({ time: ts(), from: 'מושיקו', text: caption, direction: 'in' });
        const chat = await msg.getChat();
        await chat.sendStateTyping();
        const response = await route(chatId, caption);
        await botSend(chat, response);
        stats.sent++;
        log({ time: ts(), from: 'בוטי', text: response.substring(0, 120), direction: 'out' });
        return;
      }

      console.log(`📨 [${ts()}] 🖼️ תמונה: ${caption.substring(0, 60)}`);
      stats.received++;
      log({ time: ts(), from: 'מושיקו', text: `🖼️ ${caption}`, direction: 'in' });

      const chat = await msg.getChat();
      await chat.sendStateTyping();

      const response = await handleImage(msg, caption, chatId);
      await botSend(chat, response);
      stats.sent++;
      log({ time: ts(), from: 'בוטי', text: response.substring(0, 120), direction: 'out' });
      return;
    }

    // Handle document messages (PDF, Word, text files, audio recordings)
    if (msg.type === 'document') {
      const caption = rawBody.trim() || '';
      const fileName = msg._data?.filename || 'document';
      const ext = fileName.split('.').pop().toLowerCase();

      // Audio file → call recording handler
      if (AUDIO_EXTENSIONS.has(ext)) {
        console.log(`📨 [${ts()}] 🎙️ הקלטת שיחה: ${fileName} ${caption ? '— ' + caption.substring(0, 60) : ''}`);
        stats.received++;
        log({ time: ts(), from: 'מושיקו', text: `🎙️ ${fileName} ${caption}`, direction: 'in' });

        const chat = await msg.getChat();
        await chat.sendStateTyping();

        const response = await handleCallRecording(msg, caption, fileName, chatId);
        await botSend(chat, response);
        stats.sent++;
        log({ time: ts(), from: 'בוטי', text: response.substring(0, 120), direction: 'out' });
        return;
      }

      // Regular document (PDF, Word, text, etc.)
      console.log(`📨 [${ts()}] 📄 קובץ: ${fileName} ${caption ? '— ' + caption.substring(0, 60) : ''}`);
      stats.received++;
      log({ time: ts(), from: 'מושיקו', text: `📄 ${fileName} ${caption}`, direction: 'in' });

      const chat = await msg.getChat();
      await chat.sendStateTyping();

      const response = await handleDocument(msg, caption, fileName, chatId);
      await botSend(chat, response);
      stats.sent++;
      log({ time: ts(), from: 'בוטי', text: response.substring(0, 120), direction: 'out' });
      return;
    }

    // Handle text messages
    const text = rawBody.trim();
    if (!text) return;

    console.log(`📨 [${ts()}] ${text.substring(0, 80)}`);
    stats.received++;
    log({ time: ts(), from: 'מושיקו', text, direction: 'in' });

    const chat = await msg.getChat();
    await chat.sendStateTyping();

    // ── Pending "clear references" confirmation check ────────────
    const pendingClear = pendingClearConfirm.get(chatId);
    if (pendingClear && pendingClear.expiresAt > Date.now()) {
      if (/^(כן|כן מחק|אישור|confirm|מחק)/i.test(text)) {
        pendingClearConfirm.delete(chatId);
        clearReferences(pendingClear.name);
        const doneLabel = pendingClear.name ? `של "${pendingClear.name}"` : '';
        await botSend(chat, `✅ *${pendingClear.count} ייחוסים נמחקו ${doneLabel}*`);
        stats.sent++;
        return;
      } else if (/^(לא|ביטול|cancel|לא מחק)/i.test(text)) {
        pendingClearConfirm.delete(chatId);
        await botSend(chat, `↩️ *מחיקה בוטלה*`);
        stats.sent++;
        return;
      }
      // Any other text — cancel the pending confirm (user moved on)
      pendingClearConfirm.delete(chatId);
    }

    // ── Direct face-status shortcut (bypass Claude) ─────────────
    // "פקודות זיהוי" or "עזרה זיהוי" → instant command guide
    if (/^(פקודות זיהוי|עזרה זיהוי|help זיהוי|זיהוי help|face commands|מדריך זיהוי)/i.test(text)) {
      const helpReply =
        `📷 *פקודות זיהוי פנים — מדריך מהיר:*\n\n` +
        `*שלח תמונה עם אחד מהכיתובים:*\n` +
        `• *"ייחוס [שם]"* — לשמור תמונת ייחוס\n` +
        `  _דוגמה: "ייחוס מיה"_\n` +
        `• *"בדיקה"* — לראות ציון זיהוי (טקסט)\n` +
        `• *"סימון"* — תמונה עם גבולות 🟢מוכר / 🔴לא מוכר\n` +
        `• *"סימון טשטוש"* — ירוק על מוכרים + טשטוש לאחרים\n` +
        `• *"בדיקת טשטוש"* — טשטוש לא מוכרים בלבד\n\n` +
        `*פקודות טקסט:*\n` +
        `• *"כמה ייחוסים יש"* — סטטוס המערכת\n` +
        `• *"תחמיר רגישות"* — פחות זיהויים שגויים\n` +
        `• *"תרחיב רגישות"* — יזהה גם דמיון חלקי\n` +
        `• *"פקודות זיהוי"* — המדריך הזה 😊\n\n` +
        `*כשהבוט שולח תמונה מקבוצה — ענה עליה:*\n` +
        `• *"כן"* / *"נכון"* — מוסיף לייחוסים\n` +
        `• *"לא"* / *"טעות"* — מסמן שגיאה\n` +
        `• כל הסבר חופשי — Claude מבין ומתקן 🤖`;
      await botSend(chat, helpReply);
      stats.sent++;
      log({ time: ts(), from: 'בוטי', text: helpReply.substring(0, 120), direction: 'out' });
      return;
    }

    // Catches plain-text questions about reference counts / recognition status
    const isFaceQuery = /כמה (תמונות|ייחוסים|ייחוס) (יש|של)|סטטוס זיהוי|מצב זיהוי|זיהוי פנים סטטוס|מה הסטטוס של (זיהוי|פנים)|כמה פנים|ייחוס סטטוס/i.test(text);
    if (isFaceQuery) {
      const st = getFaceStatus();
      const refs = st.references.map(r => `  👤 *${r.name}*: ${r.count} ייחוסים`).join('\n') || '  _אין ייחוסים עדיין_';
      const groups = st.monitoredGroups.length > 0 ? st.monitoredGroups.map(g => `  📲 ${g}`).join('\n') : '  _אין קבוצות מנוטרות_';
      const ownerGrps = st.ownerGroups?.length > 0 ? st.ownerGroups.map(g => `  🧪 ${g}`).join('\n') : '  _אין_';
      const blurMode = st.blurEnabled ? '🔒 טשטוש פעיל' : (st.highlightMode !== 'none' ? `🟢 סימון: ${st.highlightMode}` : '⬜ ללא עיבוד');
      const faceReply = `📊 *סטטוס זיהוי פנים:*\n\n` +
        `${st.enabled ? '✅ פעיל' : '❌ כבוי'} | ${blurMode} | סף: ${st.threshold}\n\n` +
        `*ייחוסים שמורים:*\n${refs}\n\n` +
        `*קבוצות מנוטרות:*\n${groups}\n\n` +
        `*קבוצות בדיקה (גם תמונות שלך):*\n${ownerGrps}\n\n` +
        `💡 _לבדיקה: שלח תמונה עם כיתוב "בדיקה" / "סימון" / "סימון טשטוש"_`;
      await botSend(chat, faceReply);
      stats.sent++;
      log({ time: ts(), from: 'בוטי', text: faceReply.substring(0, 120), direction: 'out' });
      return;
    }

    // ── Manual briefing trigger — runs scheduled group_summary now ─
    // Match scan request: either exact start-phrase OR "סריקת/סקירת קבוצות" anywhere in message
    // Catch every scan-request variation — skips scheduling commands
    // Only block when user explicitly wants to SCHEDULE (not when describing existing routine)
    const _isSchedCmd = /(?:תזמן|צור תזמון|הגדר תזמון)/i.test(text) ||
      /כל (?:יום|בוקר|ערב|לילה)\s+ב-?\d{1,2}:\d{2}/i.test(text);
    // Skip multi-group scan if user asked about a specific single group — let Claude route to whatsapp.summarize
    // Catches: "קבוצת X", "את הקבוצה X", "של קבוצת X", "סכם את X", "מהקבוצה X"
    // Note: Hebrew chars aren't \w in JS regex, so we avoid \b and rely on explicit prefixes
    const _mentionsSingleGroup =
      // "(את) (ה)קבוצה/קבוצת X" — where X is a letter/digit (not space/punct)
      /(?:^|\s)(?:את\s+)?ה?קבוצ[הת]\s+["״']?[\u0590-\u05FFa-zA-Z0-9]/i.test(text) ||
      // "של/מה/ב + קבוצה/קבוצת X"
      /(?:של|מה|\sב)ה?קבוצ[הת]\s+["״']?[\u0590-\u05FFa-zA-Z0-9]/i.test(text) ||
      // "סכם את הקבוצה/קבוצת ..."
      /סכם\s+(?:לי\s+)?(?:את\s+)?ה?קבוצ[הת]/i.test(text);
    if (!_isSchedCmd && !_mentionsSingleGroup && (
      // user says "תעשה/עשה/תריץ/תן לי/רוצה... סריקה/סקירה" — bare, no specific group
      /(?:תעשה|עשה|תריץ|הרץ|תן לי|תוציא|רוצה|צריך|אפשר|בצע|תפעיל|תשלח|הפעל)\s+(?:לי\s+)?(?:סריקה|סקירה)\b/i.test(text) ||
      // starts with סריקה/סקירה (any suffix: יומית, עכשיו, ידנית, מהירה...)
      /^(?:סריקה|סקירה)\b/i.test(text) ||
      // classic exact phrases — explicit multi-group wording
      /סריקת קבוצות|סקירת קבוצות|תסרוק קבוצות|תסרוק לי את הקבוצות/i.test(text) ||
      // "תסרוק לי" alone — only when followed by time-window or nothing (not by a specific target)
      /תסרוק לי(?:\s+(?:מ|עד|עכשיו|את הקבוצות|קבוצות)|$|[\?\.!])/i.test(text) ||
      // english
      /^(?:run briefing|briefing now|run scan)/i.test(text)
    )) {
      const summaryTask = [...dailyTasks.values()].find(d => d.action === 'group_summary');
      if (!summaryTask) {
        await botSend(chat, `❌ לא נמצאה משימת סקירה מתוזמנת. הגדר אחת קודם.`);
        stats.sent++; return;
      }
      // ── Parse time window from user request ──────────────────────
      // "4 שעות אחרונות" | "שעה אחרונה" | "מאתמול" | "24 שעות" | "מהבוקר" | "מ-8" | "מ-8:30" | default
      let _scanDay, _windowLabel;
      const _hoursM = text.match(/(\d+)\s*שעות?\s*(?:אחרונות?|האחרונות?|אחרוני)/i);
      const _fromHourM = text.match(/מ-?(\d{1,2})(?::(\d{2}))?(?!\s*שעות?)(?:\s*(?:בבוקר|בצהריים|בערב|לפנה"צ|אחה"צ))?/i);
      if (_hoursM) {
        const h = parseInt(_hoursM[1]);
        _scanDay = Date.now()/1000 - h * 3600;
        _windowLabel = `${h} שעות אחרונות`;
      } else if (/שעה\s*(?:אחרונה|האחרונה)/i.test(text)) {
        _scanDay = Date.now()/1000 - 3600;
        _windowLabel = 'שעה אחרונה';
      } else if (/מ?-?אתמול|מ?-?אמש/i.test(text)) {
        const _yd = new Date(); _yd.setDate(_yd.getDate()-1); _yd.setHours(0,0,0,0);
        _scanDay = _yd.getTime()/1000;
        _windowLabel = 'מאתמול (מחצות אתמול)';
      } else if (/48\s*שעות?|יומיים/i.test(text)) {
        _scanDay = Date.now()/1000 - 172800;
        _windowLabel = '48 שעות אחרונות';
      } else if (/24\s*שעות?/i.test(text)) {
        _scanDay = Date.now()/1000 - 86400;
        _windowLabel = '24 שעות אחרונות';
      } else if (/מה?בוקר|מ?-?הבוקר/i.test(text)) {
        const _md = new Date(); _md.setHours(6,0,0,0);
        _scanDay = _md.getTime()/1000;
        _windowLabel = 'מהבוקר (06:00)';
      } else if (/מ?-?חצות/i.test(text)) {
        const _md = new Date(); _md.setHours(0,0,0,0);
        _scanDay = _md.getTime()/1000;
        _windowLabel = 'מחצות הלילה';
      } else if (_fromHourM && parseInt(_fromHourM[1]) <= 23) {
        // "מ-8" / "מ-8:30" / "מ-20:00" — specific hour today
        const _fh = parseInt(_fromHourM[1]);
        const _fm = parseInt(_fromHourM[2] || '0');
        const _ft = new Date(); _ft.setHours(_fh, _fm, 0, 0);
        _scanDay = _ft.getTime()/1000;
        _windowLabel = `מ-${String(_fh).padStart(2,'0')}:${String(_fm).padStart(2,'0')} היום`;
      } else {
        // default: from midnight today, or last 24h if evening
        const _nowH = new Date().getHours();
        const _todayStart = (() => { const _d = new Date(); _d.setHours(0,0,0,0); return _d.getTime()/1000; })();
        _scanDay = _nowH < 20 ? _todayStart : Date.now()/1000 - 86400;
        _windowLabel = _nowH < 20 ? 'מחצות הלילה' : '24 שעות אחרונות';
      }
      await botSend(chat, `⏳ *מריץ סקירת קבוצות עכשיו...*\n⏱ _${_windowLabel}_\n_${(summaryTask.params.groups||[]).length} קבוצות — זה ייקח כמה שניות_`);
      // Run the same logic as the cron job, in background
      setImmediate(async () => {
        let oc;
        try {
          oc = await client.getChatById(OWNER_ID);
          const day = _scanDay;
          const nowT = (()=>{const _n=new Date();return`${String(_n.getHours()).padStart(2,'0')}:${String(_n.getMinutes()).padStart(2,'0')}`;})();
          const groupStats = [];
          const allMessages = [];
          const { smartChat: sc } = require('./src/claude');
          const cs = await client.getChats(); // fetch once outside loop
          const _totalG = (summaryTask.params.groups || []).length;
          let _doneG = 0;
          for (const gn of (summaryTask.params.groups || [])) {
            try {
              const ch = findChatByName(cs, gn);
              if (!ch) { groupStats.push({name:gn,count:0,status:'not_found'}); _doneG++; continue; }
              const msgs = await safeFetchMessages(ch, 150);
              const rec = msgs.filter(m => m.body && m.timestamp > day);
              groupStats.push({name:ch.name, count:rec.length, status:'ok'});
              for (const m of rec.filter(m => m.body.trim().length > 15))
                allMessages.push({group:ch.name, time:(()=>{const _d=new Date(m.timestamp*1000);return`${String(_d.getDate()).padStart(2,'0')}/${String(_d.getMonth()+1).padStart(2,'0')} ${String(_d.getHours()).padStart(2,'0')}:${String(_d.getMinutes()).padStart(2,'0')}`;})(), sender:safeTruncate(stripOrphanSurrogates(m._data?.notifyName||'משתתף'),15), body:safeTruncate(stripOrphanSurrogates(m.body),250), ts:m.timestamp});
              _doneG++;
            } catch (ge) { logger.warn(`scan skip "${gn}": ${ge.message?.substring(0,60)}`); groupStats.push({name:gn,count:0,status:'error',error:ge.message?.substring(0,60)}); _doneG++; }
            // Progress indicator — emit at halfway through a long scan
            if (_totalG >= 6 && _doneG === Math.ceil(_totalG / 2)) {
              try { await botSend(oc, `⏳ *סריקה בעיצומה:* ${_doneG}/${_totalG} קבוצות נסרקו...`); } catch {}
            }
          }
          allMessages.sort((a,b)=>a.ts-b.ts);
          const totalM = groupStats.reduce((a,g)=>a+g.count,0);
          const activeGrps = groupStats.filter(g=>g.count>0);
          const silentGrps = groupStats.filter(g=>g.count===0 && g.status==='ok').map(g=>g.name);
          const notFoundGrps = groupStats.filter(g=>g.status==='not_found').map(g=>g.name);
          const errorGrps = groupStats.filter(g=>g.status==='error').map(g=>g.name);
          const skippedGrps = [...notFoundGrps, ...errorGrps]; // kept for scan history backward-compat
          const hotG = [...groupStats].sort((a,b)=>b.count-a.count)[0];
          const lvl = totalM>300?'🔴🔴🔴🔴🔴 סוער':totalM>150?'🔴🔴🔴🟡 פעיל מאוד':totalM>50?'🟡🟡🟡 בינוני':'🟢🟢 שקט';
          const _footerLines = [];
          if (silentGrps.length) _footerLines.push(`🔇 _שקטות (${silentGrps.length}): ${silentGrps.join(', ')}_`);
          if (notFoundGrps.length) _footerLines.push(`❓ _לא נמצאו בוואטסאפ (${notFoundGrps.length}): ${notFoundGrps.join(', ')}_`);
          if (errorGrps.length) _footerLines.push(`⚠️ _שגיאה (${errorGrps.length}): ${errorGrps.join(', ')}_`);
          const skippedLine = _footerLines.length ? '\n' + _footerLines.join('\n') : '';
          const header = `📋 *סקירה ידנית — ${nowT}*\n⏱ _${_windowLabel}_\n━━━━━━━━━━━━━━━━━━━━\n🌡️ ${lvl}  |  🏆 ${hotG?.name||'—'}\n📊 ${totalM} הודעות | ✅ ${activeGrps.length}/${groupStats.length} קבוצות עם תוכן${skippedLine}\n━━━━━━━━━━━━━━━━━━━━\n\n`;
          if (!allMessages.length) {
            await botSend(oc, header + `_אין הודעות ב${_windowLabel}_`);
            try { saveScanHistory({ kind: 'manual', windowLabel: _windowLabel, totalMessages: 0, activeGroups: 0, groupStats, skippedGroups: skippedGrps, hotGroup: null, scanOutput: '' }); } catch {}
          } else {
            const pool = allMessages.map(m=>`⏰${m.time} [${m.group}] ${m.sender}: "${m.body}"`).join('\n');
            // Manual scan — pure topic listing only. No analysis, no recommendations.
            // The previous version had a "אסור להוסיף..." rule but mentioning the
            // forbidden phrases sometimes still primed Claude to include them.
            // Cleanest fix: don't mention them at all + explicit "STOP after topics".
            const scanPrompt = `אתה מנתח מודיעין פוליטי לדובר ח"כ אריאל קלנר (ליכוד).\n\nנתונים: ${allMessages.length} הודעות מ-${activeGrps.length} קבוצות.\nפורמט נתונים: ⏰DD/MM HH:MM [שם-קבוצה] שולח: "הודעה"\n\n${pool}\n\nכתוב סריקה לפי נושאים חמים. לכל נושא — בדיוק 2 שורות:\n\nשורה 1: [סמל] *[כותרת — עד 8 מילים]*\nשורה 2: 📍 [כל הקבוצות שדיווחו על הנושא, מופרדות בפסיק] | 🕐 HH:MM — \"[ציטוט ישיר]\"\n\n⚠️ שורה 2 חייבת תמיד:\n- כל שמות הקבוצות שהזכירו נושא זה (מתוך [שם-קבוצה] בנתונים — כולם, לא רק אחת)\n- שעת הפרסום הראשונה (מתוך ⏰ בנתונים)\n- ציטוט ישיר\nאסור להמציא.\n\nדוגמה — נושא שדווח ב-3 קבוצות:\n⚡ *ביטול היטל העברת כספים*\n📍 ממשלה בעבודה, זירה פוליטית, הימנים בליכוד | 🕐 09:15 — \"מדובר בביטול שיהיה מחר בבוקר\"\n\nדוגמה — נושא שדווח בקבוצה אחת:\n🔥 *גיוס חרדים נדחה בכנסת*\n📍 הודעות דוברות לתקשורת | 🕐 11:30 — \"הצבעה על חוק הגיוס נדחתה\"\n\nכללי: 3-7 נושאים מהחם לשקט. ⚡ ב-2+ קבוצות | 🔥 בקבוצה אחת | ⭐ לפני הסמל אם רלוונטי במיוחד לקלנר. עברית בלבד. אין כותרות, הקדמות, הסברים.\n\n**עצור מיד אחרי הנושא האחרון. אל תוסיף שום סעיף סיכום, ניתוח, המלצה, פעולה, או הערה.**`;
            const scanResult = await sc(scanPrompt, [], { prefill: '📋 *' });
            const _legend = `\n━━━━━━━━━━━━━━━━━━━━\n🔑 *מפתח:* ⚡ = נושא ב-2+ קבוצות | 🔥 = קבוצה אחת | ⭐ = רלוונטי במיוחד לקלנר`;
            await botSend(oc, header + scanResult + _legend);
            try { saveScanHistory({ kind: 'manual', windowLabel: _windowLabel, totalMessages: totalM, activeGroups: activeGrps.length, groupStats, skippedGroups: skippedGrps, hotGroup: hotG?.name || null, scanOutput: scanResult }); } catch (e) { logger.warn('scan-history save failed:', e.message?.substring(0,80)); }
          }
        } catch (err) {
          logger.error('Manual briefing error:', err.message);
          try { if (oc) await botSend(oc, `❌ *שגיאה בסריקה:*\n_${err.message?.substring(0,120) || 'שגיאה לא ידועה'}_\n\nנסה שוב בעוד כמה שניות.`); } catch {}
        }
      });
      stats.sent++; return;
    }

    // ── Reference audit shortcut ─────────────────────────────────
    if (/^(רשימת ייחוסים|audit ייחוסים|ייחוסים פירוט|כמה ייחוסים לכל אחד|פירוט ייחוסים)/i.test(text)) {
      const st = getFaceStatus();
      if (st.references.length === 0) {
        await botSend(chat, `📋 *אין ייחוסים שמורים*\nשלח תמונה עם כיתוב "ייחוס [שם]" כדי להוסיף`);
      } else {
        let auditMsg = `📋 *פירוט ייחוסים שמורים:*\n\n`;
        for (const ref of st.references) {
          const filled = Math.min(ref.count, 10);
          const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
          const quality = ref.count >= 8 ? '✅ מעולה' : ref.count >= 4 ? '🟡 בסדר' : '🔴 מעט מדי';
          auditMsg += `👤 *${ref.name}*\n   ${bar} ${ref.count} — ${quality}\n\n`;
        }
        auditMsg += `_סה"כ: ${st.totalReferences} ייחוסים · סף: ${st.threshold}_\n`;
        auditMsg += `💡 _למחיקה: "נקה ייחוסים של [שם]"_`;
        await botSend(chat, auditMsg);
      }
      stats.sent++;
      log({ time: ts(), from: 'בוטי', text: 'audit ייחוסים', direction: 'out' });
      return;
    }

    // Send "working on it" if response takes too long
    let slowTimer = setTimeout(async () => {
      try { await chat.sendMessage('⏳ שנייה, עובד על זה...' + BOT_MARKER); } catch {}
    }, 5000);

    const response = await route(chatId, text);
    clearTimeout(slowTimer);
    await botSend(chat, response);
    stats.sent++;
    log({ time: ts(), from: 'בוטי', text: response.substring(0, 120), direction: 'out' });
  } catch (err) {
    // Persist to log file so we can actually diagnose crashes afterwards
    const errMsg = err?.message || String(err);
    const errStack = (err?.stack || '').split('\n').slice(0, 4).join(' | ');
    logger.error(`❌ Message handler crashed for ${chatId}: ${errMsg} | ${errStack}`);
    console.error('שגיאה:', errMsg);
    // If it's a 400 API error, clear history for this chat to recover
    if (err.status === 400 || (errMsg && errMsg.includes('400'))) {
      logger.warn(`🔴 400 error detected — clearing conversation history for ${chatId}`);
      conversations.delete(chatId);
      saveConversations(conversations);
    }
    try { const c = await msg.getChat(); await botSend(c, '❌ אופס, משהו השתבש. נסה שוב 🔄'); } catch {}
  }
});

// ─── Audio extensions for call recording detection ─────────────
const AUDIO_EXTENSIONS = new Set([
  'm4a', 'mp3', 'wav', 'ogg', 'opus', 'amr', '3gp', 'aac',
  'wma', 'flac', 'webm', '3ga', 'mp4a', 'oga',
]);

// ─── Shared audio transcription (Groq Whisper) ─────────────────
async function transcribeAudio(audioBuffer, mimetype, fileName) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('תמלול דורש GROQ_API_KEY ב-.env\nזה חינם — https://console.groq.com');
  }
  const sizeMB = audioBuffer.length / (1024 * 1024);
  if (sizeMB > 25) {
    throw new Error(`הקובץ גדול מדי (${sizeMB.toFixed(1)}MB). מקסימום 25MB לתמלול`);
  }
  const ext = (fileName || 'audio.ogg').split('.').pop().toLowerCase();
  const mimeMap = {
    m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
    ogg: 'audio/ogg', opus: 'audio/opus', amr: 'audio/amr',
    '3gp': 'audio/3gpp', aac: 'audio/aac', flac: 'audio/flac',
    webm: 'audio/webm', '3ga': 'audio/3gpp', wma: 'audio/x-ms-wma',
  };
  const actualMime = mimetype || mimeMap[ext] || 'audio/ogg';
  const blob = new Blob([audioBuffer], { type: actualMime });
  const formData = new FormData();
  formData.append('file', blob, fileName || `audio.${ext}`);
  formData.append('model', 'whisper-large-v3');
  formData.append('language', 'he');

  console.log(`🎤 Transcribing ${fileName || 'audio'} (${sizeMB.toFixed(1)}MB, ${actualMime})...`);
  const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
    body: formData,
  });
  if (!groqRes.ok) {
    const errText = await groqRes.text();
    console.error('Groq transcription error:', errText);
    throw new Error('שגיאה בתמלול: ' + errText.substring(0, 100));
  }
  const { text: transcript } = await groqRes.json();
  return transcript?.trim() || '';
}

// ─── Voice Handler (Groq Whisper transcription) ────────────────
async function handleVoice(msg, chatId) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return '❌ לא הצלחתי להוריד את ההודעה הקולית';

    const audioBuffer = Buffer.from(media.data, 'base64');
    const transcript = await transcribeAudio(audioBuffer, media.mimetype, 'voice.ogg');
    if (!transcript) return '🎤 לא הצלחתי להבין את ההודעה הקולית. נסה שוב.';

    console.log(`🎤 תמלול: ${transcript}`);

    // Route through smartChat — voice gets full tool access like text
    const history = getHistory(chatId);
    const reply = await smartChat(`[הודעה קולית]: ${transcript}`, history);

    history.push({ role: 'user', content: `[הודעה קולית]: ${transcript}` });
    history.push({ role: 'assistant', content: reply });
    if (history.length > 10) history.splice(0, 2);
    saveConversations(conversations);

    updateContext(`[הודעה קולית]: ${transcript}`, reply);

    // ── Auto-extract action items from voice note ──────────────────
    if (transcript.length > 50) {
      setImmediate(async () => {
        try {
          const { smartChat: _scv } = require('./src/claude');
          const extractPrompt = `מהתמלול הבא, אם יש פריטים שדורשים פעולה — חלץ אותם בלבד. אם אין — השב "none".
תמלול: "${transcript}"
חלץ אם קיים:
- 📅 אירועי יומן: [שם, תאריך/שעה] → השתמש ב-calendar add
- ✅ משימות: [מה לעשות]
- 📞 להתקשר ל: [שם]
אם חלצת פריטים — הוסף לזיכרון עם save_memory ולוח שנה עם calendar.
אם "none" — אל תשלח כלום.`;
          const extracted = await _scv(extractPrompt, []);
          if (extracted && extracted.toLowerCase() !== 'none' && extracted.trim().length > 10) {
            const _oc = await client.getChatById(OWNER_ID);
            await botSend(_oc, `📋 *חולץ מהודעה קולית:*\n${extracted}`);
          }
        } catch (_) { /* silent */ }
      });
    }

    return `🎤 _"${transcript}"_\n\n${reply}`;
  } catch (err) {
    console.error('שגיאת הודעה קולית:', err.message);
    return '❌ שגיאה בעיבוד הודעה קולית: ' + err.message.substring(0, 80);
  }
}

// ─── Call Recording Handler ─────────────────────────────────────
async function handleCallRecording(msg, caption, fileName, chatId) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return '❌ לא הצלחתי להוריד את ההקלטה';

    const audioBuffer = Buffer.from(media.data, 'base64');
    const sizeMB = (audioBuffer.length / (1024 * 1024)).toFixed(1);
    console.log(`🎙️ הקלטת שיחה: ${fileName} (${sizeMB}MB)`);

    const transcript = await transcribeAudio(audioBuffer, media.mimetype, fileName);
    if (!transcript) return '🎙️ לא הצלחתי לתמלל את ההקלטה. נסה שוב.';

    const wordCount = transcript.split(/\s+/).length;
    const estMinutes = Math.ceil(wordCount / 130);
    console.log(`🎙️ תמלול (${wordCount} מילים, ~${estMinutes} דק׳): ${transcript.substring(0, 150)}...`);

    const truncated = transcript.length > 12000
      ? transcript.substring(0, 12000) + '\n\n... (קוצר — הקלטה ארוכה)'
      : transcript;

    // ── Command Center #1.5: pre-analyze for media-tracker auto-sync ──
    // Run structured extraction *before* the conversational summary so we
    // can apply tracker updates deterministically and pass a JSON hint to
    // Claude (avoiding tool-use guesswork on "did this person reply?").
    let cmdSyncSummary = '';
    let cmdAnalysis = null;
    try {
      cmdAnalysis = await cmdCenter.analyzeCallTranscript(truncated);
      if (cmdAnalysis) {
        const applied = await cmdCenter.applyCallAnalysis(cmdAnalysis);
        cmdSyncSummary = applied.summary;
        if (applied.trackerUpdated) {
          logger.info(`📞 CommandCenter #1.5: media-tracker updated for ${cmdAnalysis.mediaContactId}`);
        }
      }
    } catch (e) {
      logger.warn(`CommandCenter #1.5 analyze error: ${e.message?.substring(0, 80)}`);
    }

    const cmdHint = cmdSyncSummary
      ? `\n\n[🤖 *Command Center — סינכרון אוטומטי כבר בוצע:*\n${cmdSyncSummary}\n— אל תכפיל פעולות שכבר בוצעו (כמו markReplied). אם זוהה ראיון מתוזמן, אשר/הוסף ליומן.]`
      : '';

    // If user provided caption, follow their intent; otherwise full analysis
    const prompt = caption
      ? `[🎙️ הקלטת שיחה — ${fileName} (${sizeMB}MB, ~${estMinutes} דק׳)]\n\nתמלול:\n${truncated}\n\n---\nבקשת המשתמש: ${caption}${cmdHint}`
      : `[🎙️ הקלטת שיחת טלפון — ${fileName} (${sizeMB}MB, ~${estMinutes} דק׳)]\n\nתמלול השיחה:\n${truncated}\n\n---\nזו הקלטת שיחת טלפון. בבקשה:\n1. 📝 *סכם* את השיחה — מי דיבר, על מה, מה סוכם\n2. ✅ *חלץ משימות* — כל דבר שסוכם/הובטח/נדרש פעולה. ציין אחראי ודדליין\n3. 📅 אם נקבעו *פגישות/מועדים* — הוסף ליומן אוטומטית (calendar add)\n4. ⏰ אם יש *משימות עם דדליין* — הצע תזכורת (schedule once)\n5. 🧠 *שמור בזיכרון* פרטים חשובים (memory save)\nפורמט מסודר עם אימוג'ים.${cmdHint}`;

    const history = getHistory(chatId);
    const reply = await smartChat(prompt, history);

    history.push({ role: 'user', content: `[🎙️ הקלטה: ${fileName}] ${caption || ''}`.trim() });
    history.push({ role: 'assistant', content: reply });
    if (history.length > 10) history.splice(0, 2);
    saveConversations(conversations);
    updateContext(`[🎙️ הקלטה: ${fileName}]`, reply);

    return `🎙️ *הקלטת שיחה — ${fileName}*\n📊 _תמלול: ${wordCount} מילים (~${estMinutes} דקות)_\n\n${reply}`;
  } catch (err) {
    logger.error('שגיאת הקלטה:', err.message || err.toString());
    return '❌ שגיאה בעיבוד ההקלטה: ' + (err.message || '').substring(0, 80);
  }
}

// ─── Reference Photo Handler (face recognition) ────────────────
async function handleReferencePhoto(msg, name) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return '❌ לא הצלחתי להוריד את התמונה';

    const imageBuffer = Buffer.from(media.data, 'base64');
    console.log(`📸 Adding reference for "${name}" (${(imageBuffer.length / 1024).toFixed(0)}KB)`);

    const result = await addReference(name, imageBuffer);

    if (!result.success) {
      return `❌ ${result.error}\nנסה תמונה אחרת שרואים בה את הפנים בבירור 🙏`;
    }

    const tips = result.totalReferences < 3
      ? `\n💡 _לדיוק טוב — שלח עוד ${3 - result.totalReferences} תמונות מזוויות שונות עם כיתוב "ייחוס ${name}"_`
      : result.totalReferences < 8
        ? `\n💡 _${result.totalReferences} ייחוסים — טוב! עוד כמה ישפרו את הדיוק_`
        : `\n✨ _${result.totalReferences} ייחוסים — מעולה! דיוק מקסימלי_`;

    const nextSteps = `\n\n🧪 *לבדיקה — שלח תמונה עם אחד מהכיתובים:*\n` +
      `• *"בדיקה"* — לראות ציון זיהוי (טקסט)\n` +
      `• *"סימון"* — לראות גבולות ירוק/אדום על הפנים\n` +
      `• *"סימון טשטוש"* — ירוק על ${name} + טשטוש לאחרים`;

    return `✅ *תמונת ייחוס נוספה ל-${name}!*\n` +
      `👤 פנים שנשמרו: ${result.facesAdded} | 📊 סה"כ: ${result.totalReferences}` +
      tips + nextSteps;
  } catch (err) {
    console.error('Reference photo error:', err.message);
    return '❌ שגיאה בעיבוד תמונת ייחוס: ' + err.message.substring(0, 80);
  }
}

// ─── Smart Photo Feedback Handler ───────────────────────────────
// Called when user replies to a bot-forwarded photo with any text.
// Uses Claude vision to understand the feedback and fix the image.
async function handlePhotoFeedback(feedbackText, photoData, quotedMsgId) {
  const { name, imageBuffer, confidence, groupName } = photoData;
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { MessageMedia } = require('whatsapp-web.js');

  try {
    // Ask Claude to classify the feedback intent using vision + text
    const base64 = imageBuffer.toString('base64');
    const classifyRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: `אתה מנתח פידבק על זיהוי פנים אוטומטי. הבוט זיהה את "${name}" בתמונה עם ביטחון ${confidence}%.
המשתמש הגיב בעברית על הזיהוי הזה.

כללי סיווג חשובים:
• "כן" / "נכון" / "זה הוא/היא" / "בדיוק" → intent: "correct"
• "לא" / "לא נכון" / "זה לא [שם]" / "זאת לא [שם]" / "הוא לא [שם]" / "שגוי" / "טעות" → intent: "wrong_person"
• אם המשתמש ציין שם אחר (כגון "זאת מיה" / "זה דן") → fixName: "[השם שצוין]"
• בקשה לראות התמונה המעובדת / לסמן → intent: "fix_highlight"
• אם הפנים טושטשו ולא היו אמורות → intent: "blurred_match"

החזר JSON בלבד:
{
  "intent": "correct" | "wrong_person" | "blurred_match" | "missed_match" | "fix_highlight" | "other",
  "action": "add_reference" | "false_positive" | "send_highlighted" | "send_blurred" | "send_original" | "none",
  "fixName": "שם אחר שצוין או null",
  "message": "הסבר קצר בעברית"
}`,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: `הבוט אמר: "${name}" (${confidence}%)\nהמשתמש ענה: "${feedbackText}"` },
        ],
      }],
    });

    let intent = { intent: 'other', action: 'none', fixName: null, message: '' };
    try {
      const raw = classifyRes.content.find(b => b.type === 'text')?.text || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) intent = JSON.parse(jsonMatch[0]);
    } catch {}

    console.log(`📣 Feedback intent: ${intent.intent} → action: ${intent.action}`);

    // ─── Auto-calibration tracking ──────────────────────────────────────
    try {
      const _fbStatsPath = require('path').join(__dirname, 'data', 'face-feedback-stats.json');
      const _fbStats = require('fs').existsSync(_fbStatsPath)
        ? JSON.parse(require('fs').readFileSync(_fbStatsPath, 'utf8'))
        : { correct: 0, incorrect: 0, threshold: null };

      if (intent.intent === 'confirmed' || intent.action === 'confirmed' || intent.intent === 'correct' || intent.action === 'add_reference') _fbStats.correct++;
      if (intent.intent === 'rejected' || intent.action === 'rejected' || intent.intent === 'wrong_person' || intent.action === 'false_positive') _fbStats.incorrect++;
      _fbStats.threshold = getFaceStatus().threshold;

      require('fs').writeFileSync(_fbStatsPath, JSON.stringify(_fbStats, null, 2));

      // Suggest calibration if enough data
      const total = _fbStats.correct + _fbStats.incorrect;
      if (total > 0 && total % 10 === 0) {
        const fpRate = _fbStats.incorrect / total;
        if (fpRate > 0.4) {
          const _oc2 = await client.getChatById(OWNER_ID);
          await botSend(_oc2, `💡 *הצעת כיול:* ${Math.round(fpRate * 100)}% מהזיהויים אינם נכונים (${_fbStats.incorrect}/${total}).\nכדאי להעלות את הסף. אמור "העלה סף זיהוי" לכיוון.`);
        } else if (fpRate < 0.1 && _fbStats.correct > 5) {
          const _oc2 = await client.getChatById(OWNER_ID);
          await botSend(_oc2, `💡 *הצעת כיול:* ${Math.round(fpRate * 100)}% שגיאות בלבד — הזיהוי מדויק מאוד! אפשר להוריד מעט את הסף לתפוס יותר תמונות.`);
        }
      }
    } catch (_calibErr) { /* silent */ }

    // ── Execute the action ─────────────────────────────────────
    if (intent.action === 'add_reference' || intent.intent === 'correct') {
      const refName = intent.fixName || name;
      const result = await addReference(refName, imageBuffer).catch(() => null);
      if (quotedMsgId) forwardedPhotos.delete(quotedMsgId);
      return `✅ *זיהוי נכון — תמונה נוספה לייחוסים של ${refName}!*\n🧠 ${result?.totalReferences || '?'} תמונות ייחוס — הזיהוי משתפר 📈`;
    }

    if (intent.action === 'false_positive' || intent.intent === 'wrong_person') {
      logger.warn(`❌ Feedback: false positive "${name}" (${confidence}%) from "${groupName}" — user said: "${feedbackText}"`);
      if (quotedMsgId) forwardedPhotos.delete(quotedMsgId);
      const fix = intent.fixName ? `\n💡 אם זו ${intent.fixName} — שלח תמונה שלה עם "ייחוס ${intent.fixName}" כדי ללמד אותי` : '\n💡 אם זה קורה הרבה — אמור "תחמיר רגישות"';
      return `📝 *סומן כזיהוי שגוי* — לא ${name} בתמונה הזו${fix}`;
    }

    if (intent.intent === 'blurred_match' || intent.action === 'send_highlighted') {
      // Person was blurred — send highlighted version so they can see who was found
      const ownerChat = await client.getChatById(OWNER_ID);
      try {
        const { buffer: markedBuf } = await highlightMatchingFaces(imageBuffer, { blurOthers: false });
        const markedMedia = new MessageMedia('image/jpeg', markedBuf.toString('base64'), 'fixed.jpg');
        await ownerChat.sendMessage(markedMedia, {
          caption: `🟢 *תיקון:* סימון פנים ללא טשטוש — ${name} מסומן בירוק` + BOT_MARKER,
        });
        return `📸 שלחתי את התמונה עם סימון ירוק על ${name} ואדום על האחרים`;
      } catch (e) {
        return `❌ לא הצלחתי לסמן: ${e.message?.substring(0, 60)}`;
      }
    }

    if (intent.intent === 'missed_match' || intent.action === 'send_original') {
      // Person wasn't recognized — send original for user to see
      const ownerChat = await client.getChatById(OWNER_ID);
      const origMedia = new MessageMedia('image/jpeg', base64, 'original.jpg');
      await ownerChat.sendMessage(origMedia, {
        caption: `📸 תמונה מקורית ללא עיבוד — ${name} לא זוהה (סף: ${confidence}%)` + BOT_MARKER,
      });
      return `שלחתי את התמונה המקורית. אם ${name} באמת שם — שלח את התמונה עם כיתוב "ייחוס ${name}" כדי ללמד אותי 🎓`;
    }

    // Generic — just acknowledge and log
    return `📝 פידבק נשמר. ${intent.message || ''}`;

  } catch (err) {
    if (err.status === 429 || err.status === 503 || err.status === 529) {
      // Recoverable: keep photoData in forwardedPhotos so user can retry
      logger.warn?.('Temporary API error in photo feedback:', err.status);
      return `⏳ *שגיאה זמנית ב-API* — נסה שוב בעוד דקה 🔄\n_${err.message?.substring(0, 50)}_`;
    }
    logger.error?.('Photo feedback error:', err.message);
    if (quotedMsgId) forwardedPhotos.delete(quotedMsgId);
    return `❌ שגיאה בעיבוד הפידבק: ${err.message?.substring(0, 60)}`;
  }
}

// ─── Face Test Handler ──────────────────────────────────────────
// withBlur: blur non-matching faces
// withHighlight: draw green/red borders
// highlightAndBlur: green border on match + blur others
async function handleFaceTest(msg, withBlur = false, withHighlight = false, highlightAndBlur = false) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return '❌ לא הצלחתי להוריד את התמונה';

    const imageBuffer = Buffer.from(media.data, 'base64');
    console.log(`🔍 Face test (${(imageBuffer.length / 1024).toFixed(0)}KB, blur=${withBlur}, highlight=${withHighlight})`);

    const { detectFaces } = require('./src/face-recognition');
    const detections = await detectFaces(imageBuffer);
    const matches = await findMatches(imageBuffer);

    let response = `🔍 *בדיקת זיהוי פנים:*\n\n`;
    response += `👤 פנים שזוהו בתמונה: *${detections.length}*\n`;

    if (detections.length === 0) {
      response += '\n❌ לא זוהו פנים. נסה תמונה שרואים בה פנים בבירור.';
      return response;
    }

    const status = getFaceStatus();

    if (matches.length > 0) {
      response += '\n✅ *התאמות:*\n';
      for (const m of matches) {
        const emoji = m.confidence >= 70 ? '🟢' : m.confidence >= 50 ? '🟡' : '🔴';
        response += `  ${emoji} *${m.name}* — ${m.confidence}% (מרחק: ${m.distance})\n`;
      }
      response += '\n_🟢 70%+ = בטוח, 🟡 50-70% = סביר, 🔴 <50% = לא בטוח_';
    } else {
      response += '\n❌ אין התאמה לאף תמונת ייחוס.\n';
      if (status.totalReferences === 0) {
        response += '\n💡 *שלב ראשון:* שלח תמונה ברורה עם כיתוב "ייחוס [שם]"';
      } else {
        response += `\n📊 יש ${status.totalReferences} ייחוסים (סף: ${status.threshold})`;
        response += '\n💡 אם אמור להיות שם — נסה להוסיף עוד ייחוסים מזוויות שונות';
        response += '\n💡 אפשר גם לומר "תרחיב רגישות" כדי שיזהה בקלות יותר';
      }
    }

    // ── Highlight mode: send image with colored borders ────────
    if ((withHighlight || highlightAndBlur) && detections.length > 0) {
      try {
        const { buffer: markedBuf, highlighted } = await highlightMatchingFaces(imageBuffer, { blurOthers: highlightAndBlur });
        const { MessageMedia } = require('whatsapp-web.js');
        const markedMedia = new MessageMedia('image/jpeg', markedBuf.toString('base64'), 'marked.jpg');
        const chat = await msg.getChat();
        const others = detections.length - highlighted;
        const capText = highlighted > 0
          ? `🟢 ${highlighted} מסומן${highlighted > 1 ? 'ות' : ''} — זוהה${others > 0 ? ` | ${highlightAndBlur ? '🔒 ' + others + ' טושטש' : '🔴 ' + others + ' לא זוהה'}` : ''}`
          : `🔴 אף אחד לא זוהה — כל ${others} פנים לא מוכרים`;
        await chat.sendMessage(markedMedia, { caption: capText + BOT_MARKER });
        // add tips after the image
        if (matches.length === 0 && status.totalReferences > 0) {
          response += `\n\n💡 *לא זיהיתי? נסה:*\n• שלח תמונה ברורה יותר עם כיתוב "ייחוס [שם]"\n• אמור "תרחיב רגישות" (סף נוכחי: ${status.threshold})`;
        }
      } catch (hErr) {
        response += `\n\n⚠️ סימון נכשל: ${hErr.message?.substring(0, 50)}`;
      }
    }
    // ── Blur mode ──────────────────────────────────────────────
    else if (withBlur && detections.length > matches.length) {
      try {
        const { buffer: blurredBuf, blurred } = await blurNonMatchingFaces(imageBuffer);
        if (blurred > 0) {
          const { MessageMedia } = require('whatsapp-web.js');
          const blurredMedia = new MessageMedia('image/jpeg', blurredBuf.toString('base64'), 'blurred.jpg');
          const chat = await msg.getChat();
          await chat.sendMessage(blurredMedia, {
            caption: `🔒 ${blurred} פנים טושטשו | ✅ ${matches.length} נשארו חדים` + BOT_MARKER,
          });
        }
      } catch (blurErr) {
        response += `\n\n⚠️ טשטוש נכשל: ${blurErr.message?.substring(0, 50)}`;
      }
    }

    // ── If plain test (no image sent back) — add next steps ────
    if (!withBlur && !withHighlight && !highlightAndBlur) {
      response += `\n\n📌 *שלבים הבאים:*\n`;
      if (matches.length > 0) {
        response += `• שלח שוב עם כיתוב *"סימון"* — תראה גבולות על הפנים 🟢\n`;
        response += `• שלח עם *"סימון טשטוש"* — ירוק על מוכרים + טשטוש לאחרים\n`;
      } else {
        response += `• שלח תמונה עם כיתוב *"ייחוס [שם]"* להוספת ייחוס\n`;
        if (status.totalReferences > 0) {
          response += `• אמור *"תרחיב רגישות"* אם הסף קשוח מדי\n`;
        }
      }
    }

    return response;
  } catch (err) {
    console.error('Face test error:', err.message);
    return '❌ שגיאה בבדיקת זיהוי: ' + err.message.substring(0, 80);
  }
}

// ─── Group Photo Monitor (face recognition) ─────────────────────
// IMPORTANT: Only READS from groups. NEVER sends to groups.
// Only forwards matching photos to OWNER's self-chat.
client.on('message', async (msg) => {
  // ── Keyword alert — runs for ALL message types (text, image, video…) ────────
  {
    const _kFromJid = msg.from || '';
    const _kIsGroup = _kFromJid.endsWith('@g.us') || _kFromJid.endsWith('@g');
    if (_kIsGroup && msg.body && msg.body.length > 2) {
      const { checkMessage: _checkKw } = require('./src/keyword-alerts');
      const _matchedKw = _checkKw(msg.body, _kFromJid);
      if (_matchedKw) {
        try {
          const _alertChat = await msg.getChat();
          const _groupNameForAlert = _alertChat.name || _kFromJid;
          const _sender = msg._data?.notifyName || 'מישהו';
          const _preview = stripUrls(msg.body.substring(0, 150));
          const _ownerC = await client.getChatById(OWNER_ID);
          // Crisis mode check — if this critical alert pushes us over the
          // war-room threshold, suppress this individual alert and trigger
          // the consolidated war-room flow instead.
          const { recordAlert: _recordCrisisAlert, isCrisisActive: _crisisActive } = require('./src/crisis-mode');
          const _crisisTrigger = _recordCrisisAlert({ keyword: _matchedKw, group: _groupNameForAlert, sender: _sender, preview: _preview });
          if (_crisisTrigger) {
            triggerWarRoom(_crisisTrigger).catch(e => logger.error('warRoom failed:', e.message));
          } else if (!_crisisActive()) {
            await botSend(_ownerC,
              `🚨 *התראה — מילת מפתח: "${_matchedKw}"*\n` +
              `📍 *${_groupNameForAlert}*\n` +
              `👤 ${_sender}\n` +
              `💬 "${_preview}${_preview.length >= 150 ? '...' : ''}"`
            );
          }
          // Always log to keyword-alerts journal (whether war-room or solo alert)
          require('./src/keyword-alerts').logAlert(_matchedKw, _groupNameForAlert, _sender, _preview);
        } catch (_alertErr) { /* silent */ }
      }
    }
  }
  // Persist group text messages to disk — survives bot restarts for scan resilience
  _cacheGroupMsg(msg);
  // Queue — share the same face-detection queue to avoid concurrent TF.js
  if (msg.type !== 'image' && msg.type !== 'album') return;
  _queueFace(async () => {
  try {
    // Support @g.us (modern groups) and @g (legacy groups).
    // NOTE: @newsletter JIDs are excluded here — getChat() on newsletters returns
    // a different structure (no .description) and crashes this handler.
    // Owner-sent newsletter photos are handled by message_create instead.
    const _fromJid = msg.from || '';
    const _isGroup = _fromJid.endsWith('@g.us') || _fromJid.endsWith('@g');
    if (!_isGroup) return;

    const status = getFaceStatus();
    if (!status.enabled || status.totalReferences === 0) return;
    if (status.monitoredGroups.length === 0) return;

    const chat = await msg.getChat();
    const groupName = chat.name || '';

    // Helper: normalize Hebrew strings — strip niqqud + zero-width chars
    // + bidi marks + ALL whitespace. Both the chat name and the configured
    // monitor name may contain different representations of the same visible
    // string (e.g. ״ vs " vs ׳, NFC vs NFD, RLM/LRM marks, optional space
    // before emoji). Removing whitespace entirely makes the comparison
    // tolerant to display formatting differences.
    const _normHe = s => (s || '')
      .normalize('NFC')
      .replace(/[֑-ׇ]/g, '')          // niqqud
      .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')  // zero-width / bidi
      .replace(/[״"]/g, '')                      // hebrew + ASCII double quote
      .replace(/[׳']/g, '')                      // hebrew + ASCII single quote
      .replace(/\s+/g, '').toLowerCase();        // strip ALL whitespace

    const _gNorm = _normHe(groupName);

    // Check if this group is in the monitored list — try (a) exact JID
    // match (status.monitoredGroupJids), (b) name partial-match on
    // normalized strings.
    const isMonitoredByJid = (status.monitoredGroupJids || []).includes(_fromJid);
    const isMonitoredByName = status.monitoredGroups.some(g => {
      const gn = _normHe(g);
      return _gNorm.includes(gn) || gn.includes(_gNorm);
    });
    const isMonitored = isMonitoredByJid || isMonitoredByName;
    if (!isMonitored) {
      // Diagnostic: log mismatches so we can debug naming issues.
      // Only log group images with non-empty names to avoid spam.
      if (groupName) {
        console.log(`⏩ Skip face-check (not monitored): "${groupName}" [${_fromJid}] · normalized="${_gNorm}" · monitoredList=${JSON.stringify(status.monitoredGroups.map(_normHe))}`);
      }
      return;
    }

    // Owner's photos are handled exclusively by message_create (ownerGroups block).
    // Never process them here to avoid double-processing and infinite loops.
    if (msg.fromMe) return;

    console.log(`📷 Group photo from "${groupName}" — checking faces...`);

    const media = await msg.downloadMedia();
    if (!media || !media.data) return;

    const imageBuffer = Buffer.from(media.data, 'base64');
    const allMatches = await findMatches(imageBuffer);

    // Apply per-group whitelist — e.g. "גן פיסטוק-תשפו💚" allows only "שי",
    // "מעון צעדים החדשה- תינוקות" allows only "מיה". Groups without an entry
    // in groupWhitelist accept all configured references (e.g. "קניות" test).
    const matches = applyGroupWhitelist(allMatches, groupName, status.groupWhitelist);

    if (allMatches.length > 0 && matches.length === 0) {
      const skipped = allMatches.map(m => m.name).join(', ');
      console.log(`🚫 "${groupName}": detected [${skipped}] but not in whitelist for this group — skipping alert`);
    }

    if (matches.length > 0) {
      const match = matches[0];
      console.log(`🎀 Match: ${match.name} (${match.confidence}%) from "${groupName}"`);
      _trackFaceMatch(match.name, groupName);

      // Save for weekly album
      if (_weeklyFacePhotos.length < MAX_WEEKLY_PHOTOS) {
        _weeklyFacePhotos.push({
          name: match.name,
          base64: media.data,
          mimetype: media.mimetype || 'image/jpeg',
          groupName,
          date: new Date().toLocaleDateString('he-IL'),
          confidence: match.confidence,
        });
      }

      const ownerChat = await client.getChatById(OWNER_ID);
      const sender = msg._data?.notifyName || 'מישהו';
      const time = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

      const photoData = { name: match.name, imageBuffer, confidence: match.confidence, groupName, sentAt: Date.now() };
      lastForwardedPhoto.set(OWNER_ID, photoData); // for text-only "פידבק כן/לא"

      // Helper: register a sent message for reply-based feedback
      const registerFeedbackMsg = (sentMsg) => {
        if (!sentMsg?.id?._serialized) return;
        // Prune BEFORE insert so we never exceed MAX_FEEDBACK_STORE
        if (forwardedPhotos.size >= MAX_FEEDBACK_STORE) {
          const firstKey = [...forwardedPhotos.keys()][0];
          forwardedPhotos.delete(firstKey);
        }
        forwardedPhotos.set(sentMsg.id._serialized, photoData);
      };

      // Send with blur / highlight / original
      const feedbackNote = `\n💬 _הגב: "כן" אם נכון, "לא" אם טעות_`;
      const { MessageMedia } = require('whatsapp-web.js');
      const hlMode = getHighlightMode(); // 'none' | 'highlight' | 'highlight_blur'

      const baseCaption = `🎀 *תמונה של ${match.name}!*\n📍 ${groupName} · 👤 ${sender}\n📊 ${match.confidence}%\n⏰ ${time}`;

      if (hlMode === 'highlight' || hlMode === 'highlight_blur') {
        try {
          const { buffer: markedBuf, highlighted, blurred: hlBlurred } =
            await highlightMatchingFaces(imageBuffer, { blurOthers: hlMode === 'highlight_blur' });
          const markedMedia = new MessageMedia('image/jpeg', markedBuf.toString('base64'), 'photo.jpg');
          const hlNote = highlighted > 0
            ? ` · 🟢 ${highlighted} מסומן${hlBlurred > 0 ? ` · 🔒 ${hlBlurred} טושטש` : ''}`
            : '';
          const sentMsg = await ownerChat.sendMessage(markedMedia, {
            caption: baseCaption + hlNote + feedbackNote + BOT_MARKER,
          });
          registerFeedbackMsg(sentMsg);
        } catch (hlErr) {
          console.error('Highlight failed, sending original:', hlErr.message?.substring(0, 60));
          const origMedia = new MessageMedia(media.mimetype || 'image/jpeg', media.data, 'photo.jpg');
          const sentMsg = await ownerChat.sendMessage(origMedia, {
            caption: baseCaption + feedbackNote + BOT_MARKER,
          });
          registerFeedbackMsg(sentMsg);
        }
      } else if (isBlurEnabled()) {
        try {
          const { buffer: blurredBuf, blurred } = await blurNonMatchingFaces(imageBuffer);
          const blurredMedia = new MessageMedia('image/jpeg', blurredBuf.toString('base64'), 'photo.jpg');
          const blurNote = blurred > 0 ? ` · 🔒 ${blurred} פנים טושטשו` : '';
          const sentMsg = await ownerChat.sendMessage(blurredMedia, {
            caption: baseCaption + blurNote + feedbackNote + BOT_MARKER,
          });
          registerFeedbackMsg(sentMsg);
        } catch (blurErr) {
          console.error('Blur failed, sending original:', blurErr.message?.substring(0, 60));
          const origMedia = new MessageMedia(media.mimetype || 'image/jpeg', media.data, 'photo.jpg');
          const sentMsg = await ownerChat.sendMessage(origMedia, {
            caption: baseCaption + feedbackNote + BOT_MARKER,
          });
          registerFeedbackMsg(sentMsg);
        }
      } else {
        // Send media directly with BOT_MARKER in caption so message_create won't re-process it
        const origMedia = new MessageMedia(media.mimetype || 'image/jpeg', media.data, 'photo.jpg');
        const sentMsg = await ownerChat.sendMessage(origMedia, {
          caption: baseCaption + feedbackNote + BOT_MARKER,
        });
        registerFeedbackMsg(sentMsg);
      }
      // ── ownerGroup: reply directly to the photo with highlighted result ──
      const isTestGrp = (status.ownerGroups || []).some(g => groupName.includes(g) || g.includes(groupName));
      if (isTestGrp) {
        try {
          const { MessageMedia: MMA } = require('whatsapp-web.js');
          const { buffer: grpBuf } = await highlightMatchingFaces(imageBuffer, { blurOthers: false });
          const grpMedia = new MMA('image/jpeg', grpBuf.toString('base64'), 'result.jpg');
          const allNames = matches.map(m => `*${m.name}* (${m.confidence}%)`).join(', ');
          await msg.reply(grpMedia, null, { caption: `🟢 זוהה: ${allNames}` + BOT_MARKER });
        } catch (e) { /* silent */ }
      }
      stats.sent++;
    } else {
      console.log(`📷 No match in "${groupName}" photo`);
      // For ownerGroups (test groups): reply directly to the photo so it's clear which one
      const isTestGrp = (status.ownerGroups || []).some(g => groupName.includes(g) || g.includes(groupName));
      if (isTestGrp) {
        try { await msg.reply(`🔍 לא זוהו פנים מוכרים` + BOT_MARKER); } catch (e) { /* silent */ }
      }
    }
  } catch (err) {
    // Silent — don't spam logs for every group photo error
    if (err.message?.includes('not initialized')) return; // models still loading
    console.error('Photo filter error:', (err.message || '').substring(0, 80));
  }
  }); // closes _queueFace
});

// ─── Image Handler ───────────────────────────────────────────────
async function handleImage(msg, caption, chatId) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return '❌ לא הצלחתי להוריד את התמונה';

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const history = getHistory(chatId);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: `אתה "בוטי" — העוזר האישי של מושיקו בוואטסאפ. ענה קצר וטבעי בעברית. תשתמש בסלנג ישראלי.

📸 תפקידך עכשיו: לתאר מה אתה רואה בתמונה.

🤖 *פקודות מיוחדות לזיהוי פנים — אלה פועלות דרך כיתוב בתמונה, לא דרכך:*
• כיתוב "ייחוס [שם]"       → שמירת תמונה כייחוס לזיהוי פנים
• כיתוב "בדיקה"             → בדיקת זיהוי פנים (טקסט + ציון)
• כיתוב "סימון"             → סימון פנים עם גבולות צבעוניים (🟢מוכר, 🔴לא מוכר)
• כיתוב "סימון טשטוש"       → סימון ירוק + טשטוש פנים לא מוכרים
• כיתוב "בדיקת טשטוש"       → טשטוש פנים לא מוכרים

🚫 אל תאמר שאתה "שומר", "מוסיף", "מזהה" פנים — זה נעשה בקוד בשרת, לא על ידך.
✅ אם המשתמש ביקש לסמן/לזהות/לשמור — הסבר לו *בדיוק* איזה כיתוב לשלח.
✅ לבדיקת כמות ייחוסים — הוא יכול לשאול "כמה ייחוסים יש" בהודעת טקסט.`,
      messages: [
        ...history,
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: media.mimetype || 'image/jpeg', data: media.data },
            },
            { type: 'text', text: caption },
          ],
        },
      ],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    const reply = textBlock ? textBlock.text.trim() : 'לא הצלחתי לקרוא את התמונה';

    history.push({ role: 'user', content: caption });
    history.push({ role: 'assistant', content: reply });
    if (history.length > 10) history.splice(0, 2);
    saveConversations(conversations);

    return reply;
  } catch (err) {
    console.error('שגיאת תמונה:', err.message);
    return '❌ שגיאה בעיבוד התמונה: ' + err.message.substring(0, 80);
  }
}

// ─── Document Handler ────────────────────────────────────────────
async function handleDocument(msg, caption, fileName, chatId) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return '❌ לא הצלחתי להוריד את הקובץ';

    const buf = Buffer.from(media.data, 'base64');
    let docText = '';
    const mime = media.mimetype || '';
    const ext = fileName.split('.').pop().toLowerCase();

    // Extract text based on file type
    if (ext === 'pdf' || mime.includes('pdf')) {
      try {
        const pdfParse = require('pdf-parse');
        const parsed = await pdfParse(buf);
        docText = parsed.text;
      } catch {
        docText = '[קובץ PDF — לא הצלחתי לחלץ טקסט. נסה לשלוח כתמונה]';
      }
    } else if (['txt', 'csv', 'json', 'xml', 'html', 'md', 'log', 'js', 'py', 'ts'].includes(ext)) {
      docText = buf.toString('utf-8');
    } else if (ext === 'docx' || mime.includes('wordprocessingml')) {
      try {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer: buf });
        docText = result.value;
      } catch {
        docText = '[קובץ Word — לא הצלחתי לחלץ טקסט]';
      }
    } else {
      // Try reading as text, fallback to base64 description
      try {
        const tryText = buf.toString('utf-8');
        if (/[\x00-\x08\x0E-\x1F]/.test(tryText.substring(0, 500))) {
          docText = `[קובץ בינארי: ${fileName}, ${(buf.length / 1024).toFixed(1)}KB, סוג: ${mime}]`;
        } else {
          docText = tryText;
        }
      } catch {
        docText = `[קובץ: ${fileName}, ${(buf.length / 1024).toFixed(1)}KB, סוג: ${mime}]`;
      }
    }

    // Truncate very long documents
    if (docText.length > 15000) {
      docText = docText.substring(0, 15000) + '\n\n... (קוצר — הקובץ ארוך מדי)';
    }

    const prompt = caption
      ? `[📄 קובץ: ${fileName}]\n\n${docText}\n\n---\nבקשת המשתמש: ${caption}`
      : `[📄 קובץ: ${fileName}]\n\n${docText}\n\n---\nקיבלתי קובץ. תסכם אותו בקצרה ותשאל אם רוצים משהו ספציפי.`;

    const history = getHistory(chatId);
    const reply = await smartChat(prompt, history);

    history.push({ role: 'user', content: `[📄 קובץ: ${fileName}] ${caption || ''}`.trim() });
    history.push({ role: 'assistant', content: reply });
    if (history.length > 10) history.splice(0, 2);
    saveConversations(conversations);
    updateContext(`[📄 קובץ: ${fileName}]`, reply);

    return reply;
  } catch (err) {
    logger.error('שגיאת קובץ:', err.message || err.toString());
    return '❌ שגיאה בעיבוד הקובץ: ' + (err.message || '').substring(0, 80);
  }
}

// ─── Router ──────────────────────────────────────────────────────
async function route(chatId, text) {

  // Auto-send last video if user confirms
  if (lastVideoPath && /^(כן|yes|✅|שלח|תשלח|בטח)/i.test(text)) {
    try {
      const { MessageMedia } = require('whatsapp-web.js');
      const media = MessageMedia.fromFilePath(lastVideoPath);
      const chat = await client.getChatById(chatId);
      await chat.sendMessage(media, { caption: '🎬 הנה הסרטון!' + BOT_MARKER });
      lastVideoPath = null;
      return '✅ הסרטון נשלח!';
    } catch (err) {
      lastVideoPath = null;
      return '❌ שגיאה בשליחת הסרטון: ' + err.message.substring(0, 80);
    }
  }

  // ── Face recognition feedback — natural language ────────────────
  // Short message after a forwarded photo → Claude feedback handler.
  // ALWAYS cleared after first use to prevent feedback loops.
  // TTL: 3 minutes (if user doesn't respond in time, they should reply directly to the photo).
  const lastPhoto = lastForwardedPhoto.get(chatId);
  const FEEDBACK_TTL = 3 * 60 * 1000; // 3 minutes
  if (lastPhoto && text.length < 150 && !text.startsWith('/')) {
    // Expire stale entries
    if (lastPhoto.sentAt && Date.now() - lastPhoto.sentAt > FEEDBACK_TTL) {
      lastForwardedPhoto.delete(chatId);
    } else {
      // Always delete after one attempt — prevents endless feedback loop.
      // On temp API error (⏳), user can still reply directly to the forwarded photo.
      lastForwardedPhoto.delete(chatId);
      const reply = await handlePhotoFeedback(text.trim(), lastPhoto, null);
      return reply;
    }
  }

  // Quick commands (still work for power users)
  if (/^\/(תפריט|menu|help|עזרה|start)/i.test(text)) return helpMenu();
  if (/^\/(חדש|חדשות|עדכון|changelog|whatsnew|מה חדש)/i.test(text)) return whatsNew();
  if (/^\/(נקה|clear)/i.test(text)) { conversations.delete(chatId); saveConversations(conversations); clearFailedTools(); return '🗑️ היסטוריה נוקתה!'; }
  if (/^\/think\s+/i.test(text)) return thinkWithClaude(text.replace(/^\/think\s+/i, ''), getHistory(chatId));
  if (/^\/(code|קוד)\s+/i.test(text)) return runClaudeCode(text.replace(/^\/(code|קוד)\s+/i, ''));

  // Reminder (keep as special — needs setTimeout)
  if (/^\/(תזכורת|remind)\s+/i.test(text)) return handleReminder(chatId, text.replace(/^\/(תזכורת|remind)\s+/i, ''));

  // ─── "מה חדש בבוט" natural language detection ───────────────────
  if (/מה (חדש|יש חדש|נשתנה|הוסף)|עדכונ(ים|י בוט)|changelog|פיצ'רים חדשים|מה בוצע/i.test(text.trim())) {
    const { formatChangelog } = require('./src/changelog');
    return formatChangelog(3);
  }

  // ─── Keyword alert — today's hits ────────────────────────────────
  if (/^(התראות היום|מה ניטרתי היום|מה קרה היום בניטור|ניטור היום|מילות מפתח היום|alerts today)/i.test(text.trim()) ||
      /התראות של היום|מה התראות היום|כמה התראות היום/i.test(text.trim())) {
    const { getTodayAlerts: _kwToday } = require('./src/keyword-alerts');
    return _kwToday();
  }

  // ─── Keyword alert — monitoring status (which groups, which keywords) ─
  if (/^(סטטוס ניטור|מצב ניטור|ניטור סטטוס|סטטוס מילות מפתח|מצב מילות מפתח|keyword status)/i.test(text.trim())) {
    const { getFullStatus: _kwStatus } = require('./src/keyword-alerts');
    return _kwStatus();
  }

  // ─── Keyword alert stats / log ───────────────────────────────────
  if (/^(דוח התראות|התראות מילות מפתח|דוח מילים|keyword stats|דוח מפתח|אזכורים)/i.test(text.trim())) {
    const { getStats: _kwStats } = require('./src/keyword-alerts');
    return _kwStats();
  }

  // ─── Keyword alert trends (today vs yesterday) ───────────────────
  if (/^(מגמות|trends|מגמות היום|מה בולט היום|שינויים)/i.test(text.trim())) {
    const { getTrends: _kwTrends, formatTrendsMessage: _fmtTrends } = require('./src/keyword-alerts');
    try {
      const trends = _kwTrends({ minHits: 3, minRatio: 2 });
      return _fmtTrends(trends);
    } catch (e) {
      logger.warn('trends failed:', e.message?.substring(0, 80));
      return '⚠️ שגיאה בחישוב מגמות';
    }
  }

  // ─── Manual backup ───────────────────────────────────────────────
  if (/^(גיבוי|גבה עכשיו|backup now|run backup)/i.test(text.trim())) {
    try {
      const { runBackup: _rb } = require('./src/backup');
      const r = await _rb();
      if (r.success) {
        const kb = (r.size / 1024).toFixed(1);
        return `✅ *גיבוי הושלם*\n📦 ${r.path.split(/[\\/]/).pop()}\n📊 ${kb} KB · ${r.durationMs}ms`;
      }
      return `❌ *גיבוי נכשל*\n${r.error?.substring(0, 120) || 'שגיאה לא ידועה'}`;
    } catch (e) {
      return `❌ שגיאה בגיבוי: ${e.message?.substring(0, 100)}`;
    }
  }

  // ─── Scan history — list recent scans ────────────────────────────
  if (/^(היסטוריית סריקות|סריקות אחרונות|scan history)/i.test(text.trim())) {
    try {
      const { listScans: _ls } = require('./src/scan-history');
      const scans = _ls({ limit: 10 });
      if (!scans.length) return '📭 אין סריקות שמורות עדיין.';
      let out = `🗂️ *סריקות אחרונות (${scans.length}):*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      for (const s of scans) {
        const kind = s.kind === 'daily' ? '🔄 יומית' : '⚡ ידנית';
        const when = `${s.date} ${s.time}`;
        const msgs = s.totalMessages ?? 0;
        const groups = s.activeGroups ?? 0;
        out += `${kind} · ${when}\n   📊 ${msgs} הודעות מ-${groups} קבוצות · ${s.filename}\n\n`;
      }
      return out.trim();
    } catch (e) {
      return `❌ שגיאה בהיסטוריית סריקות: ${e.message?.substring(0, 100)}`;
    }
  }

  // ─── Stats command ───────────────────────────────────────────────
  if (/^סטטיסטיקות|^stats|^כמה הודעות/i.test(text.trim())) {
    const _uptime = process.uptime();
    const _uptimeStr = _uptime > 3600
      ? `${Math.floor(_uptime / 3600)}ש׳ ${Math.floor((_uptime % 3600) / 60)}ד׳`
      : `${Math.floor(_uptime / 60)}ד׳`;
    return `📊 *סטטיסטיקות בוטי*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⏱️ זמן פעילות: ${_uptimeStr}\n` +
      `📨 הודעות שהתקבלו: ${stats.received || 0}\n` +
      `📤 תשובות שנשלחו: ${stats.sent || 0}\n` +
      `🎀 זיהויי פנים היום: ${[..._dailyFaceMatches.values()].reduce((s, m) => s + [...m.values()].reduce((a, e) => a + e.count, 0), 0)}`;
  }

  // ─── Quote accuracy checker ──────────────────────────────────────
  const _quoteMatch = text.match(/^(?:בדוק ציטוט|האם קלנר אמר|נכון ש)[:\s]*["״]?(.+?)["״]?$/i)
    || text.match(/^ציטוט[:\s]+(.+)/i);
  if (_quoteMatch) {
    const _quote = _quoteMatch[1].trim();
    const { smartChat: _sc } = require('./src/claude');
    const _checkPrompt = `בדוק את הדיוק של הציטוט הבא המיוחס לח"כ אריאל קלנר:\n\n"${_quote}"\n\n1. חפש ברשת (web_search) אם קלנר אמר את זה — ציין מקור ותאריך\n2. השווה לעמדותיו הידועות מהזיכרון\n3. קבע: ✅ נכון | ⚠️ חלקי/מוצא מהקשר | ❌ שגוי/המצאה\n\nפרמט:\n🔍 *בדיקת ציטוט*\n"${_quote}"\n\n📊 *תוצאה:* [✅/⚠️/❌]\n📝 *הסבר:* [מה מצאת]\n📎 *מקור:* [קישור אם נמצא]\n💬 *מה הוא אמר בפועל:* [אם נמצא גרסה מדויקת יותר]`;
    return _sc(_checkPrompt, []);
  }

  // ─── Interview prep ──────────────────────────────────────────────
  const _interviewMatch = text.match(/^הכן אות[יי] לראיון(?:\s+(?:ב-?|על\s+))(.+)/i)
    || text.match(/^הכנת ראיון[:\s]+(.+)/i)
    || text.match(/^interview prep[:\s]+(.+)/i);
  if (_interviewMatch) {
    const _topic = _interviewMatch[1].trim();
    const { smartChat: _sc } = require('./src/claude');
    const _prepPrompt = `הכן ח"כ אריאל קלנר (ליכוד) לראיון על הנושא: "${_topic}".\nבהתבסס על עמדותיו הידועות.\n\nכתוב בדיוק בפורמט הזה:\n\n🎙️ *הכנה לראיון: ${_topic}*\n\n📌 *3 נקודות מפתח לפתוח בהן:*\n1. [נקודה ראשונה — חזקה, בגוף ראשון]\n2. [נקודה שנייה]\n3. [נקודה שלישית]\n\n❓ *שאלות צפויות + תשובות מוכנות:*\nש: [שאלה קשה צפויה]\nת: [תשובה חדה ומוכנה, בגוף ראשון]\n\nש: [שאלה נוספת]\nת: [תשובה]\n\nש: [שאלה נוספת]\nת: [תשובה]\n\n⚠️ *מה לא להגיד:*\n• [נקודה לעקוף]\n• [נקודה נוספת]\n\n💡 *ציטוט מוכן לסיום:*\n"[משפט חזק לסיום ראיון]"`;
    return _sc(_prepPrompt, []);
  }

  // ─── Ruflo-inspired: Tiered routing ─────────────────────────
  // Tier 1: Fast-path simple greetings without API call
  const greetings = /^(היי|הי|שלום|מה קורה|בוקר טוב|ערב טוב|לילה טוב|מה נשמע|אהלן|בוקר|ערב)\??!?$/i;
  if (greetings.test(text.trim())) {
    const replies = ['היי מושיקו! 😊 מה אני יכול לעזור?', 'אהלן אחי! 💪 מה העניינים?', 'מה קורה מושיקו! 🔥 צריך משהו?', 'היי! 😎 אני פה בשבילך'];
    const reply = replies[Math.floor(Math.random() * replies.length)];
    const history = getHistory(chatId);
    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: reply });
    return reply;
  }

  // Tier 2: Everything else → Claude with tools (natural language)
  const history = getHistory(chatId);
  const reply = await smartChat(text, history);
  history.push({ role: 'user', content: text });
  history.push({ role: 'assistant', content: reply });
  if (history.length > 10) history.splice(0, 2);

  // Persist conversation and context
  saveConversations(conversations);
  updateContext(text, reply);

  return reply;
}

// ─── Help Menu ───────────────────────────────────────────────────
function helpMenu() {
  return `╭──── *🤖 בוטי* ────╮
│  _העוזר האישי שלך_  │
╰─────────────────╯

💬 *פשוט תכתוב לי ואני אבין!*
━━━━━━━━━━━━━━━━━━━━

📅 *יומן:*
• _"מה יש לי היום?"_
• _"מה בלוז השבוע?"_
• _"תקבע לי פגישה מחר ב-14:00"_
• _"תמחק את הפגישה הראשונה"_

📧 *מיילים:*
• _"יש לי מיילים חדשים?"_
• _"תחפש מייל מאמא"_
• _"תשלח מייל ל-..."_
• _"תשלח מייל לדני בעוד שעה"_ ⏰

🌐 *אינטרנט:*
• _"מה מזג האוויר היום?"_
• _"חפש לי טיסות לאילת"_

⏰ *תזמון שליחה:*
• _"תשלח הודעה לדני בעוד 30 דקות"_
• _"תזמן מייל ליובל מחר בבוקר"_
• _"מה מתוזמן?"_ · _"תבטל תזמון 1"_

🎬 *סרטונים:*
• _"תעשה סרטון עם כותרת: חדשות"_
• _"תעשה ציטוט של הרצל"_
• _"תעשה מצגת 3 שקפים"_
• _"איזה סרטונים יש?"_ — מדריך מלא

💻 *מחשב:*
• _"מה מצב המחשב?"_
• _"תראה לי קבצים בשולחן העבודה"_
• _"כמה סוללה נשארה?"_

📷 *זיהוי פנים:*
• _שלח תמונה + "ייחוס [שם]"_ — לשמור ייחוס
• _שלח תמונה + "בדיקה"_ — לראות ציון זיהוי
• _שלח תמונה + "סימון"_ — לסמן 🟢מוכר / 🔴לא מוכר
• _"פקודות זיהוי"_ — מדריך מלא

━━━━━━━━━━━━━━━━━━━━

⚡ *פקודות מיוחדות:*
├ /think [שאלה] — ניתוח מעמיק
├ /code [משימה] — Claude Code
├ /תזכורת [דקות] [מה]
├ /נקה — אפס שיחה
├ /מה חדש — עדכונים אחרונים
└ /תפריט — העזרה הזו`;
}

// ─── What's New ─────────────────────────────────────────────────
// !! כשמוסיפים עדכון — מוסיפים בלוק חדש בראש הרשימה עם תאריך + שעה !!
function whatsNew() {
  return `╭──── *🆕 עדכוני בוטי* ────╮
╰───────────────────────╯

━━━━━━━━━━━━━━━━━━━━
📅 *22/4/2026 — גרסה 1.9.0*
━━━━━━━━━━━━━━━━━━━━

*🛡️ חבילת יציבות + אוטומציה*

📈 *"מגמות"* — מילים שקופצות היום X2+ מאתמול
🗂️ *"היסטוריית סריקות"* — רשימת 10 הסריקות האחרונות
📦 *גיבוי אוטומטי 23:00* — כל data/ ל-ZIP (7 ימים אחורה). "גיבוי" = ידני
⏳ אינדיקטור התקדמות בסריקה ארוכה (6+ קבוצות)
🔄 Auto-retry ל-529/503/429 + timeout (backoff מעריכי)
📝 לוג צ'אט קבוע → logs/chat-YYYY-MM-DD.log
🛡️ הגנה מפני משימות יומיות כפולות (schedule_daily)

━━━━━━━━━━━━━━━━━━━━
📅 *18/4/2026 — 23:15*
━━━━━━━━━━━━━━━━━━━━

*📷 זיהוי פנים — שיפור מסיבי*

🐛 *תיקוני באגים:*
• תמונות ייחוס עם כמה פנים נדחות (מנע זיהום)
• אותו שם לא יופיע פעמיים בתוצאות
• ניקוי ייחוסים מזוהמים

🎯 *דיוק:*
• רזולוציה זיהוי: 640px ← *1280px* (פנים קטנות)
• חידוד תמונה אוטומטי לפני זיהוי
• זיהוי פנים קטנות: minConfidence 0.5 ← *0.3*
• בקרת איכות ייחוס — דוחה תמונות חשוכות/שרופות
• threshold אישי לכל אדם ("שנה סף של מיה ל-0.38")

🖥️ *UX:*
• "🔍 בודק פנים..." — אינדיקטור בזמן עיבוד
• תשובה ישירות *על* התמונה (reply) — ברור איזו תמונה
• אישור לפני מחיקת ייחוסים — לא עוד מחיקה בטעות
• פקודה חדשה: _"רשימת ייחוסים"_ — progress bar + תווית איכות
• זיהוי פנים נוסף לתפריט /תפריט

⚡ *ביצועים ויציבות:*
• Config cache — קורא קובץ רק כשמשתנה (×15 פחות I/O)
• זיהוי פנים מתבצע פעם אחת לתמונה במקום כפול
• confidence מנורמל לסף (100% = התאמה מושלמת, 0% = בגבול)
• תור תמונות לא עולה על הגבול (prune-before-insert)
• Claude API נפל? — מנסה שוב במקום לאבד פידבק

━━━━━━━━━━━━━━━━━━━━
📅 *13/4/2026*
━━━━━━━━━━━━━━━━━━━━

*💬 קריאת שיחות וואטסאפ*
• _"תראה שיחות"_ — רשימת כל השיחות
• _"תקרא את השיחה עם יובל"_ — הודעות אחרונות
• _"תחפש בוואטסאפ ראיון"_ — חיפוש בכל השיחות

*📋 סיכום קבוצות*
• _"תסכם את הקבוצה של..."_ — סיכום תמציתי

*↗️ העברת הודעות*
• _"תעביר את ההודעה מהקבוצה לקלנר"_ — עם אישור

*🔄 משימות יומיות חוזרות*
• _"כל יום ב-8:00 תשלח סקירה"_
• _"מה יש יומי?"_ לצפייה ובטל

*⏰ תזמון שליחה*
• _"תשלח הודעה לדני בעוד 30 דקות"_
• וואטסאפ + מייל · אישור כשנשלח

*🎬 יצירת סרטונים (Remotion)*
• text / quote / slideshow · RTL · אנימציות

*🎤 הודעות קוליות*
• תמלול Whisper · אחרי תמלול — כל הכלים

━━━━━━━━━━━━━━━━━━━━
*⚙️ בסיס תמיד פעיל:*
📅 יומן · 📧 Gmail · 📲 וואטסאפ · 🌐 אינטרנט
🖼️ תמונות · 💻 מחשב · 🧠 זיכרון · ⚠️ אישור

━━━━━━━━━━━━━━━━━━━━
💡 _/עדכון לרשימה זו · /תפריט לעזרה_`;
}

// ─── Reminder ────────────────────────────────────────────────────
function handleReminder(chatId, text) {
  const hMatch = text.match(/^(\d+)\s*(שעות?|hours?)\s+(.+)/i);
  const mMatch = text.match(/^(\d+)\s*(דקות?|mins?|minutes?)\s+(.+)/i);
  let ms, what;
  if (hMatch) { ms = parseInt(hMatch[1]) * 3600000; what = hMatch[3]; }
  else if (mMatch) { ms = parseInt(mMatch[1]) * 60000; what = mMatch[3]; }
  else return '❌ למשל:\n_/תזכורת 30 דקות לצאת_\n_/תזכורת 2 שעות לפגישה_';
  if (ms < 60000) return '❌ מינימום דקה';
  if (ms > 86400000) return '❌ מקסימום 24 שעות';
  setTimeout(async () => {
    try { const c = await client.getChatById(chatId); await botSend(c, `⏰ *תזכורת!*\n\n${what}`); } catch {}
  }, ms);
  const label = ms >= 3600000 ? `${Math.round(ms / 3600000)} שעות` : `${Math.round(ms / 60000)} דקות`;
  return `⏰ אזכיר לך עוד *${label}*:\n"${what}"`;
}

// ─── Helpers ─────────────────────────────────────────────────────
function getHistory(id) {
  if (!conversations.has(id)) conversations.set(id, []);
  return conversations.get(id);
}

function log(entry) {
  messageLog.unshift(entry);
  if (messageLog.length > 100) messageLog.pop();
  io.emit('newMessage', { ...entry, stats });
  // Persist to daily chat log file (JSONL) — best-effort, never throws
  try {
    appendChatLog({
      from: entry?.from,
      text: entry?.text,
      direction: entry?.direction,
      chatId: entry?.chatId || OWNER_ID,
    });
  } catch {}
}

function ts() {
  return new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

// ─── Socket ──────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('status', botStatus);
  socket.emit('stats', stats);
  if (currentQR) socket.emit('qr', currentQR);
  socket.emit('messages', messageLog.slice(0, 50));
});

// ─── Start ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   🤖 בוטי — עוזר אישי בוואטסאפ      ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  סרוק QR: http://localhost:${PORT}       ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  // ── Schedule daily backup (23:00 Israel time) ──
  try {
    const { scheduleDailyBackup } = require('./src/backup');
    scheduleDailyBackup(nodeCron);
    logger.info('📦 Daily backup scheduled — 23:00 Asia/Jerusalem');
  } catch (err) {
    logger.warn('⚠️ Daily backup scheduling failed:', err.message);
  }
});

// ─── Health endpoint (for hosting keep-alive) ──────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', bot: botStatus, uptime: Math.round(process.uptime()), mem: Math.round(process.memoryUsage.rss?.() / 1048576 || process.memoryUsage().rss / 1048576) + 'MB' });
});

// ─── Debug endpoint — single-shot diagnostic for Railway/cloud deploys ──
// Visit this URL after deploy to see EVERYTHING needed to diagnose issues.
// Returns: bot state, env vars (presence only — values masked), volume mount
// status, Chromium binary check, recent QR count, last error, memory stats.
app.get('/debug', async (_req, res) => {
  const fs = require('fs');
  const checks = {};

  // 1) Bot state
  checks.bot = {
    status: botStatus,
    name: botName || null,
    phone: botPhone || null,
    uptime_sec: Math.round(process.uptime()),
    mem_mb: Math.round(process.memoryUsage().rss / 1048576),
    last_error: lastError,
  };

  // 2) QR state (critical: high qrCount with mounted volume = pairing keeps failing)
  checks.qr = {
    available_now: !!currentQR,
    raw_present: !!currentQRRaw,
    qr_events_total: qrCount,
    last_qr_time: lastQRTime,
    note: qrCount === 0 && botStatus === 'qr'
      ? 'Status is QR but no QR ever emitted — check Chromium init'
      : qrCount > 5
      ? 'QR shown >5 times — volume probably NOT persisting session'
      : null,
  };

  // 3) Env var presence (masked)
  const required = ['ANTHROPIC_API_KEY', 'GOOGLE_TOKEN', 'GOOGLE_CREDENTIALS', 'PORT', 'CHROMIUM_PATH'];
  checks.env = {};
  for (const k of required) {
    const v = process.env[k];
    checks.env[k] = v ? `present (${v.length} chars)` : 'MISSING';
  }
  checks.env.NODE_ENV = process.env.NODE_ENV || 'undefined';
  checks.env.RAILWAY_ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT || 'not on Railway';
  checks.env.RAILWAY_PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || null;

  // 4) Volume / persistence check
  const wwebDir = path.join(__dirname, '.wwebjs_auth');
  const dataDir = path.join(__dirname, 'data');
  try {
    const wwebExists = fs.existsSync(wwebDir);
    const wwebSession = fs.existsSync(path.join(wwebDir, 'session-ai-personal-bot'));
    let wwebSize = null;
    if (wwebExists) {
      try {
        // Quick recursive size — bounded so we don't hang
        let total = 0; let count = 0;
        const walk = (d, depth = 0) => {
          if (depth > 4 || count > 5000) return;
          const items = fs.readdirSync(d, { withFileTypes: true });
          for (const it of items) {
            count += 1;
            const p = path.join(d, it.name);
            if (it.isDirectory()) walk(p, depth + 1);
            else { try { total += fs.statSync(p).size; } catch {} }
          }
        };
        walk(wwebDir);
        wwebSize = `${(total / 1048576).toFixed(1)} MB (${count} items scanned)`;
      } catch (e) { wwebSize = `error: ${e.message}`; }
    }
    checks.volume = {
      wwebjs_auth_dir_exists: wwebExists,
      wwebjs_session_dir_exists: wwebSession,
      wwebjs_size: wwebSize,
      data_dir_exists: fs.existsSync(dataDir),
      data_files: fs.existsSync(dataDir) ? fs.readdirSync(dataDir).slice(0, 20) : [],
      note: !wwebExists
        ? '❌ .wwebjs_auth/ MISSING — volume not mounted!'
        : !wwebSession
        ? '⚠️ Volume mounted but no session yet — first run, or just-cleared session'
        : '✅ Session directory present',
    };
  } catch (e) {
    checks.volume = { error: e.message };
  }

  // 5) Chromium binary check
  try {
    const chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
    checks.chromium = {
      configured_path: chromiumPath,
      path_exists: fs.existsSync(chromiumPath),
      note: !fs.existsSync(chromiumPath)
        ? '❌ Chromium binary NOT FOUND at configured path — Puppeteer will fail'
        : '✅ Chromium binary present',
    };
  } catch (e) {
    checks.chromium = { error: e.message };
  }

  // 6) Recent activity (last 10 messages from in-memory log)
  checks.recent_messages = (messageLog || []).slice(0, 10).map(m => ({
    ts: m.ts || m.time, dir: m.dir, from: m.from, snippet: (m.text || m.body || '').substring(0, 80),
  }));

  res.json(checks);
});

// ─── Test-send endpoint (diagnostic) ───────────────────────────
// Hit /test-send from browser to verify the bot can send a WhatsApp message.
app.get('/test-send', async (_req, res) => {
  try {
    const chat = await client.getChatById(OWNER_ID);
    await chat.sendMessage(`🧪 *בדיקת חיבור מ-Railway*\n⏰ ${new Date().toLocaleTimeString('he-IL')}` + BOT_MARKER);
    res.json({ ok: true, status: botStatus });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Manual trigger endpoints — for testing the daily crons NOW ──────
// Same logic as the cron callbacks, just runs immediately. Result is
// sent to your WhatsApp DM (same as the cron would). Returns immediate
// ack so the browser doesn't hang while Claude searches.
app.get('/run-media-briefing', async (_req, res) => {
  res.json({ ok: true, msg: 'מעקב מדיה רץ ברקע — התוצאה תגיע ל-WhatsApp שלך תוך 30-90 שניות' });
  // Run async so we don't block the HTTP response
  (async () => {
    try {
      const { smartChat: _sc } = require('./src/claude');
      const oc = await client.getChatById(OWNER_ID);
      const now = new Date();
      const today = now.toLocaleDateString('he-IL');
      const todayISO = now.toISOString().slice(0, 10);
      const yesterdayISO = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
      const twoDaysAgoISO = new Date(now.getTime() - 2 * 86400000).toISOString().slice(0, 10);
      const todayHe = now.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
      const yesterdayHe = new Date(now.getTime() - 86400000).toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });

      await botSend(oc, `🧪 *בדיקה ידנית — מעקב מדיה*\n_מריץ עכשיו, יחזור עם תוצאה תוך כדקה..._`);

      const twitterPrompt = `חפש אזכורים *טריים בלבד* של ח"כ אריאל קלנר מ-${twoDaysAgoISO} (לפני יומיים) עד ${todayISO} (היום).

⏰ *חוקי תאריכים — קריטי!*
- היום: ${todayHe} (${todayISO})
- אתמול: ${yesterdayHe} (${yesterdayISO})
- לפני יומיים: ${twoDaysAgoISO}
- **אסור** לכלול ציוץ/כתבה לפני ${twoDaysAgoISO}.
- אסור fallback לתוצאות ישנות. אם אין — אמור זאת.

🔍 *חיפושים (web_search):*
1. \`"אריאל קלנר" after:${twoDaysAgoISO}\`
2. \`"ArielKallner" OR "קלנר" site:x.com after:${twoDaysAgoISO}\`
3. \`"אריאל קלנר" (site:ynet.co.il OR site:maariv.co.il OR site:walla.co.il) after:${twoDaysAgoISO}\`

📋 *פורמט:*
🐦 *אזכורי X (${twoDaysAgoISO} — ${todayISO}):*
[שם · תאריך · 1-2 שורות · קישור] — או "אין"
📰 *חדשות (${twoDaysAgoISO} — ${todayISO}):*
[כותרת · מקור · תאריך · קישור] — או "אין"
⚡ *פעולה מוצעת:*
[רק אם יש משהו טרי דחוף — אחרת "לא נדרשת"]`;

      const result = await _sc(twitterPrompt, [], { webSearchMaxUses: 5, timeoutMs: 180000, prefill: '🔍 *' });
      await botSend(oc, `🔍 *מעקב מדיה (בדיקה ידנית) — ${today}*\n📅 _טווח: ${twoDaysAgoISO} → ${todayISO}_\n━━━━━━━━━━━━━━━━━━━━\n\n${result}`);
    } catch (e) {
      logger.error(`/run-media-briefing failed: ${e.message?.substring(0, 100)}`);
      try { const oc = await client.getChatById(OWNER_ID); await botSend(oc, `❌ בדיקה ידנית של מעקב מדיה נכשלה: ${e.message?.substring(0, 80)}`); } catch (_) {}
    }
  })().catch(() => {});
});

app.get('/run-group-scan', async (_req, res) => {
  // Find the first daily task with action=group_summary
  const task = [...dailyTasks.values()].find(t => t.action === 'group_summary');
  if (!task) {
    return res.status(404).json({ ok: false, error: 'אין משימת group_summary פעילה. צור אחת קודם דרך schedule.daily.' });
  }
  res.json({ ok: true, msg: `סקירת קבוצות רצה ברקע — תוצאה תגיע ל-WhatsApp תוך כדקה. ${(task.params.groups||[]).length} קבוצות.` });

  (async () => {
    try {
      const { smartChat: _sc } = require('./src/claude');
      const oc = await client.getChatById(OWNER_ID);
      const groupStats = [];
      const allMessages = [];
      const _scanDay = Date.now() / 1000 - 86400;
      const _cs = await client.getChats();

      await botSend(oc, `🧪 *בדיקה ידנית — סקירת קבוצות*\n_סורק ${(task.params.groups || []).length} קבוצות..._`);

      for (const gn of (task.params.groups || [])) {
        try {
          const ch = findChatByName(_cs, gn);
          if (!ch) { groupStats.push({ name: gn, count: 0 }); continue; }
          const msgs = await safeFetchMessages(ch, 150);
          const rec = msgs.filter(m => m.body && m.timestamp > _scanDay);
          groupStats.push({ name: ch.name, count: rec.length });
          for (const m of rec.filter(m => m.body.trim().length > 25)) {
            const _d = new Date(m.timestamp * 1000);
            allMessages.push({
              group: ch.name,
              time: `${String(_d.getDate()).padStart(2, '0')}/${String(_d.getMonth() + 1).padStart(2, '0')} ${String(_d.getHours()).padStart(2, '0')}:${String(_d.getMinutes()).padStart(2, '0')}`,
              sender: safeTruncate(stripOrphanSurrogates(m._data?.notifyName || 'משתתף'), 15),
              body: safeTruncate(stripOrphanSurrogates(m.body), 180),
              ts: m.timestamp,
            });
          }
        } catch (ge) { logger.warn(`scan skip "${gn}": ${ge.message?.substring(0, 60)}`); groupStats.push({ name: gn, count: 0 }); }
      }
      // Cap newest 120 then re-sort chronologically
      allMessages.sort((a, b) => b.ts - a.ts);
      if (allMessages.length > 120) allMessages.length = 120;
      allMessages.sort((a, b) => a.ts - b.ts);

      const totalM = groupStats.reduce((a, g) => a + g.count, 0);
      const activeGrps = groupStats.filter(g => g.count > 0);
      const hotG = [...groupStats].sort((a, b) => b.count - a.count)[0];
      const lvl = totalM > 300 ? '🔴🔴🔴🔴🔴 סוער' : totalM > 150 ? '🔴🔴🔴🟡 פעיל מאוד' : totalM > 50 ? '🟡🟡🟡 בינוני' : '🟢🟢 שקט';
      const header = `📋 *סקירה ידנית — ${new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}*\n━━━━━━━━━━━━━━━━━━━━\n🌡️ ${lvl}  |  🏆 ${hotG?.name || '—'}  |  📊 ${totalM} הודעות מ-${activeGrps.length} קבוצות${allMessages.length < totalM ? ` (מנותח: ${allMessages.length})` : ''}\n━━━━━━━━━━━━━━━━━━━━\n\n`;

      if (!allMessages.length) {
        await botSend(oc, header + '_אין הודעות חדשות ב-24 השעות האחרונות_');
        return;
      }
      const pool = allMessages.map(m => `⏰${m.time} [${m.group}] ${m.sender}: "${m.body}"`).join('\n');
      // Manual scan via /run-group-scan endpoint — pure topic listing.
      // No analysis, no recommendations. User asks separately if needed.
      const scanPrompt = `אתה מנתח מודיעין פוליטי לדובר ח"כ אריאל קלנר (ליכוד).\n\nנתונים: ${allMessages.length} הודעות מ-${activeGrps.length} קבוצות.\nפורמט: ⏰DD/MM HH:MM [קבוצה] שולח: "הודעה"\n\n${pool}\n\nכתוב סריקה לפי נושאים חמים. לכל נושא — בדיוק 2 שורות:\nשורה 1: [סמל] *[כותרת — עד 8 מילים]*\nשורה 2: 📍 [כל הקבוצות שדיווחו, מופרדות בפסיק] | 🕐 HH:MM — \"[ציטוט]\"\n\nכללי: 3-7 נושאים מחם לשקט. ⚡ ב-2+ קבוצות | 🔥 בקבוצה אחת | ⭐ אם רלוונטי במיוחד לקלנר. עברית בלבד.\n\n**עצור מיד אחרי הנושא האחרון. אל תוסיף שום סעיף סיכום, ניתוח, המלצה או פעולה.**`;

      const scanResult = await _sc(scanPrompt, [], { timeoutMs: 150000 });
      const _legend = `\n━━━━━━━━━━━━━━━━━━━━\n🔑 *מפתח:* ⚡ = 2+ קבוצות | 🔥 = קבוצה אחת | ⭐ = רלוונטי לקלנר`;
      await botSend(oc, header + scanResult + _legend);
    } catch (e) {
      logger.error(`/run-group-scan failed: ${e.message?.substring(0, 100)}`);
      try { const oc = await client.getChatById(OWNER_ID); await botSend(oc, `❌ בדיקה ידנית של סקירת קבוצות נכשלה: ${e.message?.substring(0, 80)}`); } catch (_) {}
    }
  })().catch(() => {});
});

// ─── Restart-WA endpoint ────────────────────────────────────────
// If the WhatsApp connection is alive but not delivering events (broken session),
// hit /restart-wa from the browser → bot logs out, deletes session, exits cleanly.
// Railway restarts the container and shows a fresh QR code.
app.get('/restart-wa', async (_req, res) => {
  logger.info('🔄 Manual WA restart triggered via /restart-wa');
  res.json({ ok: true, msg: 'מתנתק מ-WhatsApp ומאתחל מחדש — סרוק QR חדש בעוד ~30 שניות' });
  setTimeout(async () => {
    try {
      await client.logout(); // logs out + deletes local session files
    } catch (_) {}
    process.exit(0);        // Railway restarts, starts fresh with new QR
  }, 1000);
});

// ─── Google OAuth2 re-auth endpoints ───────────────────────────
// For installed apps, Google allows any localhost port even if only "http://localhost" is registered.
function _makeGoogleWebAuth() {
  if (!process.env.GOOGLE_CREDENTIALS) throw new Error('GOOGLE_CREDENTIALS לא מוגדר');
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const { client_id, client_secret } = creds.installed || creds.web;
  const { google: googl } = require('googleapis');
  const callbackUri = `http://localhost:${process.env.PORT || 3000}/auth/google/callback`;
  return new googl.auth.OAuth2(client_id, client_secret, callbackUri);
}

app.get('/auth/google', (_req, res) => {
  try {
    const auth = _makeGoogleWebAuth();
    const url = auth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',          // always forces new refresh_token
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/contacts.readonly',
      ],
    });
    res.redirect(url);
  } catch (e) {
    res.status(500).send(`<h2>שגיאה</h2><pre>${e.message}</pre>`);
  }
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`<html dir="rtl"><body><h2>גישה נדחתה</h2><p>${error}</p></body></html>`);
  if (!code) return res.status(400).send('<html dir="rtl"><body><h2>קוד חסר</h2></body></html>');
  try {
    const auth = _makeGoogleWebAuth();
    const { tokens } = await auth.getToken(code);
    googleUpdateEnvToken(tokens);
    googleResetAuthClient(); // force singleton rebuild with new token on next call
    gmailResetAuth();        // same for Gmail
    logger.info('✅ Google OAuth token refreshed via web callback');

    // Notify owner via WhatsApp
    setImmediate(async () => {
      try {
        const oc = await client.getChatById(OWNER_ID);
        await botSend(oc, '✅ *Google מחובר מחדש!*\nהגישה ליומן ו-Gmail חודשה בהצלחה 🎉\nהטוקן נשמר אוטומטית.');
      } catch (_) {}
    });

    res.send(`
      <html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0fdf4">
        <h1 style="color:#16a34a">✅ Google מחובר מחדש!</h1>
        <p>הגישה ליומן ו-Gmail חודשה בהצלחה.</p>
        <p style="color:#6b7280">הטוקן נשמר אוטומטית. אפשר לסגור את החלון הזה.</p>
      </body></html>
    `);
  } catch (e) {
    logger.error('❌ Google OAuth callback error:', e.message);
    res.status(500).send(`<html dir="rtl"><body><h2>שגיאה</h2><pre>${e.message}</pre></body></html>`);
  }
});

// ─── Connection Watchdog ─────────────────────────────────────────
// Checks every 20 min whether the WhatsApp Web page is truly alive.
// If it becomes unresponsive (page crashed, WebSocket died) we logout
// and exit so Railway restarts the container with a clean session.
setInterval(async () => {
  if (botStatus !== 'connected') return;
  try {
    // Ask the Chromium page to evaluate a tiny expression.
    // If the CDP connection is dead this will throw/timeout.
    const pageAlive = await Promise.race([
      client.pupPage.evaluate(() => typeof window.Store !== 'undefined'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('watchdog-timeout')), 15000)),
    ]);
    logger.info(`🔍 Watchdog: page=${pageAlive ? 'alive' : 'dead'}`);
    if (!pageAlive) throw new Error('Store not found');
  } catch (e) {
    const why = e.message?.substring(0, 60) || 'unknown';
    logger.warn(`⚠️ Watchdog: connection dead (${why}) — trying in-process reconnect`);
    // Email owner BEFORE we try reconnect (so they know even if reconnect silently hangs)
    notifyOwnerBotDown('watchdog-dead', why).catch(()=>{});
    // Try to revive the client WITHOUT exiting the process.
    // Only exit after 5 reconnect attempts fail (see attemptReconnect).
    attemptReconnect(`watchdog: ${why}`);
  }
}, 20 * 60 * 1000);

// ─── Command Center: proactive layer (#1 in feature roadmap) ─────
// 1.1 Pending media follow-up: every 1h, if any contact is pending 6h+
//     without reply, send Moshiko a nudge. Cooldown 12h per alert.
const cmdCenter = require('./src/command-center');

async function runPendingMediaCheck() {
  if (botStatus !== 'connected') return;
  try {
    const alerts = cmdCenter.checkPendingMedia({ hoursThreshold: 6, reAlertHours: 12 });
    if (!alerts.length) return;
    logger.info(`🔔 CommandCenter: ${alerts.length} pending media alert(s) firing`);
    const oc = await client.getChatById(OWNER_ID);
    for (const a of alerts) {
      await botSend(oc, a.text);
      // Small delay between alerts so they arrive in order, not as a burst
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (e) {
    logger.warn(`CommandCenter pending-media error: ${e.message?.substring(0, 80)}`);
  }
}

// First pass 90s after startup (give bot time to settle)
setTimeout(runPendingMediaCheck, 90 * 1000);
// Then every 60 minutes
setInterval(runPendingMediaCheck, 60 * 60 * 1000);

// 1.2 Interview brief: every 5 min, find interviews starting in ~30 min and
//     send a brief (Kellner positions + current news + tip). One alert per event.
async function runInterviewBriefCheck() {
  if (botStatus !== 'connected') return;
  try {
    const alerts = await cmdCenter.checkUpcomingInterviews();
    if (!alerts.length) return;
    logger.info(`📺 CommandCenter: ${alerts.length} interview brief(s) firing`);
    const oc = await client.getChatById(OWNER_ID);
    for (const a of alerts) {
      await botSend(oc, a.text);
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (e) {
    logger.warn(`CommandCenter interview-brief error: ${e.message?.substring(0, 80)}`);
  }
}

// First pass 60s after startup
setTimeout(runInterviewBriefCheck, 60 * 1000);
// Then every 5 minutes
setInterval(runInterviewBriefCheck, 5 * 60 * 1000);

// 1.3 Waze ETA proactive: every 5 min, find events starting in ~60 min with
//     a physical location and send a "leave at X" alert with Waze link + ETA.
async function runTravelETACheck() {
  if (botStatus !== 'connected') return;
  try {
    const alerts = await cmdCenter.checkUpcomingTravelETA({ bufferMinutes: 10 });
    if (!alerts.length) return;
    logger.info(`🚦 CommandCenter: ${alerts.length} travel ETA alert(s) firing`);
    const oc = await client.getChatById(OWNER_ID);
    for (const a of alerts) {
      await botSend(oc, a.text);
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (e) {
    logger.warn(`CommandCenter travel-ETA error: ${e.message?.substring(0, 80)}`);
  }
}

// First pass 75s after startup (offset from interview check to spread API load)
setTimeout(runTravelETACheck, 75 * 1000);
// Then every 5 minutes
setInterval(runTravelETACheck, 5 * 60 * 1000);

// 1.4 Trending keyword auto-pitch: every 30 min, find keywords appearing in
//     5+ groups today and send a Kellner-style draft for owner approval.
async function runTrendingKeywordCheck() {
  if (botStatus !== 'connected') return;
  try {
    const alerts = await cmdCenter.checkTrendingKeywords({
      minGroups: 5,
      minHits: 3,
      minRatio: 1.5,
    });
    if (!alerts.length) return;
    logger.info(`🔥 CommandCenter: ${alerts.length} trending keyword pitch(es) firing`);
    const oc = await client.getChatById(OWNER_ID);
    for (const a of alerts) {
      await botSend(oc, a.text);
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (e) {
    logger.warn(`CommandCenter trending-keyword error: ${e.message?.substring(0, 80)}`);
  }
}

// First pass 5 min after startup (let the bot accumulate keyword hits)
setTimeout(runTrendingKeywordCheck, 5 * 60 * 1000);
// Then every 30 minutes
setInterval(runTrendingKeywordCheck, 30 * 60 * 1000);

// ─── Daily 20:00 face-match summary ─────────────────────────────
nodeCron.schedule('0 20 * * *', async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dayMap = _dailyFaceMatches.get(today);
    // Clean up days older than today
    for (const key of _dailyFaceMatches.keys()) {
      if (key !== today) _dailyFaceMatches.delete(key);
    }
    if (!dayMap || dayMap.size === 0) return; // nothing detected today — silent
    let lines = ['📊 *סיכום יומי — זיהוי פנים*', ''];
    for (const [name, { count, groups }] of dayMap.entries()) {
      const groupList = [...groups].join(', ');
      lines.push(`👤 *${name}* — זוהה *${count}* פעמים`);
      lines.push(`   📍 קבוצות: ${groupList}`);
    }
    lines.push('');
    lines.push(`🗓️ ${new Date().toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' })}`);
    const ownerChat = await client.getChatById(OWNER_ID);
    await botSend(ownerChat, lines.join('\n'));
  } catch (cronErr) {
    console.error('Daily face summary cron error:', cronErr.message?.substring(0, 80));
  }
}, { timezone: 'Asia/Jerusalem' });

// ─── Auto follow-up reminder (every 3h) ──────────────────────────
nodeCron.schedule('0 */3 * * *', async () => {
  try {
    const { getPendingContacts } = require('./src/media-tracker');
    const pending = getPendingContacts(6);
    if (!pending.length) return;

    const oc = await client.getChatById(OWNER_ID);
    let msg = `⏰ *תזכורת — ממתינים לתשובה:*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const c of pending) {
      const hoursAgo = Math.floor((Date.now() - new Date(c.lastOutreach).getTime()) / 3600000);
      msg += `📞 *${c.name}* | ${c.outlet}\n`;
      msg += `   נושא: ${c.lastTopic || 'לא צוין'} | לפני ${hoursAgo}ש׳\n\n`;
    }
    msg += `_אמור "פנינו ל[שם] ענה" לעדכן סטטוס_`;
    await botSend(oc, msg);
  } catch (e) {
    console.error('Follow-up cron error:', e.message?.substring(0, 60));
  }
}, { timezone: 'Asia/Jerusalem' });

// ─── Weekly spokesperson report (Sunday 20:00) ───────────────────
nodeCron.schedule('0 20 * * 0', async () => {
  try {
    const { loadContacts } = require('./src/media-tracker');
    const contacts = loadContacts();
    const oc = await client.getChatById(OWNER_ID);

    const week = `${new Date(Date.now() - 7 * 86400000).toLocaleDateString('he-IL')}–${new Date().toLocaleDateString('he-IL')}`;

    const total = contacts.length;
    const replied = contacts.filter(c => c.status === 'replied').length;
    const pending = contacts.filter(c => c.status === 'pending').length;
    const idle = contacts.filter(c => c.status === 'idle').length;

    // Count outreach from past 7 days
    const weekAgo = Date.now() - 7 * 86400000;
    const weeklyOutreach = contacts.filter(c => c.lastOutreach && new Date(c.lastOutreach).getTime() > weekAgo).length;

    // Face recognition weekly count
    let faceCount = 0;
    for (const [, dayMap] of _dailyFaceMatches) {
      for (const [, entry] of dayMap) faceCount += entry.count;
    }

    let report = `📊 *דוח שבועי דוברות*\n${week}\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    report += `📞 *פניות תקשורת:*\n`;
    report += `  • פניות שנשלחו השבוע: ${weeklyOutreach}\n`;
    report += `  • ✅ ענו: ${replied} | ⏳ ממתינים: ${pending} | ⬜ לא פנינו: ${idle}\n\n`;
    report += `🎀 *זיהוי פנים:*\n  • זיהויים שבועיים: ${faceCount}\n\n`;
    report += `💡 *לסיכום:* ${replied > pending ? 'שבוע טוב — רוב הכתבים ענו! 💪' : 'יש ממתינים — כדאי לעקוב 📞'}`;

    await botSend(oc, report);
  } catch (e) {
    console.error('Weekly report cron error:', e.message?.substring(0, 60));
  }
}, { timezone: 'Asia/Jerusalem' });

// ─── Weekly Mia photo album (Saturday 19:00) ─────────────────────
nodeCron.schedule('0 19 * * 6', async () => {
  try {
    if (!_weeklyFacePhotos.length) return;
    const { MessageMedia } = require('whatsapp-web.js');
    const oc = await client.getChatById(OWNER_ID);

    await botSend(oc, `🎀 *אלבום שבועי — זיהוי פנים*\n${_weeklyFacePhotos.length} תמונות מהשבוע:`);

    // Send up to 10 photos (WhatsApp limitation)
    const toSend = _weeklyFacePhotos.slice(-10);
    for (const photo of toSend) {
      try {
        const mm = new MessageMedia(photo.mimetype, photo.base64, 'photo.jpg');
        await oc.sendMessage(mm, {
          caption: `🎀 ${photo.name} (${photo.confidence}%) — ${photo.groupName} · ${photo.date}`,
        });
        await new Promise(r => setTimeout(r, 1000)); // 1s between photos
      } catch (_) { /* skip failed */ }
    }

    // Clear for next week
    _weeklyFacePhotos.length = 0;
    await botSend(oc, `✅ האלבום הושלם! שבוע טוב 🌟`);
  } catch (e) {
    console.error('Weekly album cron error:', e.message?.substring(0, 60));
  }
}, { timezone: 'Asia/Jerusalem' });

// ─── Daily Twitter/X + News monitoring (08:00) ───────────────────
nodeCron.schedule('0 8 * * *', async () => {
  try {
    const { smartChat: _sc } = require('./src/claude');
    const oc = await client.getChatById(OWNER_ID);
    const now = new Date();
    const today = now.toLocaleDateString('he-IL');
    const todayISO = now.toISOString().slice(0, 10);                                    // 2026-04-29
    const yesterdayISO = new Date(now.getTime() - 86400000).toISOString().slice(0, 10); // 2026-04-28
    const twoDaysAgoISO = new Date(now.getTime() - 2 * 86400000).toISOString().slice(0, 10); // 2026-04-27
    const todayHe = now.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
    const yesterdayHe = new Date(now.getTime() - 86400000).toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });

    const twitterPrompt = `חפש אזכורים *טריים בלבד* של ח"כ אריאל קלנר מ-${twoDaysAgoISO} (לפני יומיים) עד ${todayISO} (היום).

⏰ *חוקי תאריכים — קריטי לעקוב אחריהם!*
- היום: ${todayHe} (${todayISO})
- אתמול: ${yesterdayHe} (${yesterdayISO})
- לפני יומיים: ${twoDaysAgoISO}
- **אסור** לכלול בתשובה ציוץ/כתבה שתאריך הפרסום שלה לפני ${twoDaysAgoISO}.
- אם הבדיקה שלך מעלה משהו ישן (שבוע, חודש, שלושה חודשים) — **השמט אותו לחלוטין מהתשובה.**
- אסור "ליפול חזרה" לתוצאות ישנות אם אין חדשות. במקרה כזה כתוב במפורש שאין.

🔍 *חיפושים שצריך לבצע (השתמש ב-web_search):*
1. \`"אריאל קלנר" after:${twoDaysAgoISO}\`
2. \`"ArielKallner" OR "קלנר" site:x.com after:${twoDaysAgoISO}\`
3. \`"אריאל קלנר" (site:ynet.co.il OR site:maariv.co.il OR site:walla.co.il) after:${twoDaysAgoISO}\`

📋 *פורמט התשובה הנדרש:*

🐦 *אזכורי X/טוויטר (${twoDaysAgoISO} — ${todayISO}):*
[לכל ציוץ: שם המצייץ · תאריך מדויק · 1-2 שורות תוכן · קישור]
אם אין ציוצים בטווח — "אין אזכורים חדשים ב-X ביומיים האחרונים"

📰 *אזכורים בחדשות (${twoDaysAgoISO} — ${todayISO}):*
[לכל כתבה: כותרת · מקור · תאריך מדויק · קישור]
אם אין כתבות בטווח — "אין אזכורים בחדשות ביומיים האחרונים"

⚡ *פעולה מוצעת:*
[רק אם יש אזכור טרי שדורש תגובה — אחרת "לא נדרשת פעולה דחופה"]

⚠️ *תזכורת אחרונה:* אם אין אזכורים מ-${twoDaysAgoISO} ואילך — אמור זאת **בכנות**. אל תכלול אזכורים ישנים יותר אפילו אם נמצאו בחיפוש.`;

    const result = await _sc(twitterPrompt, [], { webSearchMaxUses: 5, timeoutMs: 180000, prefill: '🔍 *' });
    await botSend(oc, `🔍 *מעקב מדיה יומי — ${today}*\n📅 _טווח: ${twoDaysAgoISO} → ${todayISO} (יומיים אחרונים)_\n━━━━━━━━━━━━━━━━━━━━\n\n${result}`);
  } catch (e) {
    console.error('Twitter monitor cron error:', e.message?.substring(0, 80));
  }
}, { timezone: 'Asia/Jerusalem' });

// ─── Morning briefing cron (07:00) ───────────────────────────────
nodeCron.schedule('0 7 * * *', async () => {
  try {
    const oc = await client.getChatById(OWNER_ID);
    const { getTodaySchedule } = require('./src/calendar');
    const { getUnreadEmails } = require('./src/gmail');
    const { listContacts } = require('./src/media-tracker');

    // Track auth failures so we surface ONE consolidated alert + auth link
    let authBroken = false;

    // Calendar
    let calendarSection = '📅 *לוח שנה — היום:*\n';
    try {
      const events = await getTodaySchedule();
      if (!events || !events.length) {
        calendarSection += '_אין אירועים_';
      } else {
        calendarSection += events.map((e, i) => {
          const time = e.allDay ? 'כל היום' : `${formatTimeOnly(e.start)}–${formatTimeOnly(e.end)}`;
          return `${i + 1}. ${e.summary} (${time})${e.location ? ' 📍 ' + e.location : ''}`;
        }).join('\n');
      }
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('invalid_grant') || msg.includes('Token has been expired') || msg.includes('Token has been revoked')) {
        authBroken = true;
        calendarSection += '⚠️ _הרשאת Google פגה_';
      } else {
        calendarSection += `_שגיאה: ${msg.substring(0, 80)}_`;
      }
    }

    // Emails — meaningful only (filters Twitch/AliExpress/LinkedIn-games spam)
    let emailSection = '\n\n📧 *מיילים חדשים:*\n';
    try {
      const { getMeaningfulUnreadEmails } = require('./src/gmail');
      const emails = await getMeaningfulUnreadEmails(5);
      emailSection += emails ? emails.substring(0, 500) : '_אין מיילים_';
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('invalid_grant') || msg.includes('Token has been expired') || msg.includes('Token has been revoked')) {
        authBroken = true;
        emailSection += '⚠️ _הרשאת Google/Gmail פגה_';
      } else {
        emailSection += `_שגיאה: ${msg.substring(0, 80)}_`;
      }
    }

    // Pending media contacts
    let mediaSection = '\n\n📞 *ממתינים לתשובה:*\n';
    try {
      const contacts = listContacts();
      const pendingMatch = contacts.match(/⏳[^\n]+(\n[^\n]+)*/g);
      mediaSection += pendingMatch?.length ? pendingMatch.slice(0, 3).join('\n') : '_אין ממתינים_';
    } catch (e) { mediaSection += `_שגיאה: ${(e.message || '').substring(0, 80)}_`; }

    // If auth is broken, append a loud notice + auth URL so the user can fix it
    let authNotice = '';
    if (authBroken) {
      // Reset auth singletons so the next call re-reads the new token after re-auth
      try { googleResetAuthClient(); } catch (_) {}
      try { gmailResetAuth(); } catch (_) {}
      const authUrl = `http://localhost:${process.env.PORT || 3000}/auth/google`;
      authNotice = `\n\n━━━━━━━━━━━━━━━━━━━━\n🔑 *הרשאת Google פגה!*\nהטוקן של Google (יומן + Gmail) פג או בוטל.\nלחץ לחידוש:\n${authUrl}`;
    }

    const greeting = `☀️ *בוקר טוב מושיקו!*\n━━━━━━━━━━━━━━━━━━━━\n`;
    await botSend(oc, greeting + calendarSection + emailSection + mediaSection + authNotice);
  } catch (e) {
    console.error('Morning briefing cron error:', e.message?.substring(0, 80));
  }
}, { timezone: 'Asia/Jerusalem' });

// ─── Keep-alive self-ping (prevents free-tier hosting from sleeping) ─
{
  const _rawUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    || process.env.RENDER_EXTERNAL_URL
    || process.env.KEEP_ALIVE_URL;
  if (_rawUrl) {
    let _keepAliveUrl = _rawUrl.trim();
    if (!_keepAliveUrl.startsWith('http://') && !_keepAliveUrl.startsWith('https://')) {
      _keepAliveUrl = 'https://' + _keepAliveUrl;
    }
    _keepAliveUrl += '/health';
    console.log('💓 Keep-alive target:', _keepAliveUrl);
    setInterval(() => {
      try {
        const _mod = _keepAliveUrl.startsWith('https://') ? require('https') : require('http');
        _mod.get(_keepAliveUrl, (res) => { res.resume(); }).on('error', () => {});
      } catch (_) {}
      console.log('💓 Keep-alive ping');
    }, 13 * 60 * 1000); // every 13 minutes
  }
}

// ─── Performance endpoint ───────────────────────────────────────
app.get('/perf', (_req, res) => {
  const perf = logger.getPerfSummary();
  const cacheStats = cache.getStats();
  const usage = getUsageSummary();
  res.json({ ...perf, cache: cacheStats, usage });
});

// ─── Dashboard API endpoints ─────────────────────────────────────
app.get('/api/keyword-alerts', (_req, res) => {
  try {
    const ka = require('./src/keyword-alerts');
    const cfg = ka.getStatus();
    const log = JSON.parse(require('fs').readFileSync(path.join(__dirname,'data','keyword-alerts-log.json'),'utf8'));
    const today = new Date().toLocaleDateString('he-IL');
    const todayEntries = log.entries.filter(e => e.date === today).slice(-50);
    res.json({ enabled: cfg.enabled, keywords: cfg.keywords, today: todayEntries, total: log.entries.length });
  } catch { res.json({ enabled: false, keywords: [], today: [], total: 0 }); }
});

app.get('/api/dashboard', (_req, res) => {
  try {
    const ka = require('./src/keyword-alerts');
    const cfg = ka.getStatus();
    const logPath = path.join(__dirname,'data','keyword-alerts-log.json');
    const log = require('fs').existsSync(logPath) ? JSON.parse(require('fs').readFileSync(logPath,'utf8')) : { entries: [] };
    const today = new Date().toLocaleDateString('he-IL');
    const todayAlerts = log.entries.filter(e => e.date === today);
    // Group activity
    const groupMap = {};
    log.entries.forEach(e => { groupMap[e.group] = (groupMap[e.group]||0)+1; });
    const topGroups = Object.entries(groupMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,count])=>({name,count}));
    // Keyword frequency
    const kwMap = {};
    todayAlerts.forEach(e => { kwMap[e.keyword] = (kwMap[e.keyword]||0)+1; });
    const kwFreq = Object.entries(kwMap).sort((a,b)=>b[1]-a[1]).map(([kw,count])=>({kw,count}));
    const dailyArr = [...dailyTasks.values()].map(d=>({label:d.label, time:d.time, action:d.action}));
    res.json({
      bot: { status: botStatus, name: botName, phone: botPhone },
      alerts: { enabled: cfg.enabled, keywords: cfg.keywords, todayCount: todayAlerts.length, total: log.entries.length, recent: todayAlerts.slice(-20).reverse(), topGroups, kwFreq },
      scheduled: { daily: dailyArr, oneTime: scheduledMessages.size },
      uptime: Math.round(process.uptime()),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Graceful shutdown ──────────────────────────────────────────
function shutdown() {
  logger.info('🛑 Shutting down — saving data...');
  flushConversations();
  saveScheduledTasks(scheduledMessages);
  saveDailyTasks(dailyTasks);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.initialize().catch(async (err) => {
  console.error('שגיאת אתחול:', err.message);
  try { await notifyOwnerBotDown('init-crash', err.message?.substring(0, 200)); } catch {}
  process.exit(1);
});

// Catch last-resort unhandled errors so the bot doesn't die silently
process.on('uncaughtException', (err) => {
  logger.error(`💥 uncaughtException: ${err.message?.substring(0, 200)}`);
  notifyOwnerBotDown('uncaught-exception', err.message?.substring(0, 200)).catch(()=>{});
  // Don't exit — log and continue. The watchdog will catch true dead state.
});
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  logger.error(`💥 unhandledRejection: ${msg.substring(0, 200)}`);
  // These are usually benign (API retries); don't email for every one — just log.
});
