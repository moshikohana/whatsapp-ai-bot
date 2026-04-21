'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

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
const { formatContextForClaude, matchTopicToPositions, getBriefingSearchQueries } = require('./src/spokesperson');
const {
  initFaceAPI, addReference, findMatches, blurNonMatchingFaces, highlightMatchingFaces,
  isBlurEnabled, setBlurEnabled, getHighlightMode, setHighlightMode,
  getMonitoredGroups, addMonitoredGroup, removeMonitoredGroup,
  addOwnerGroup, removeOwnerGroup,
  getReferenceCount, clearReferences, setThreshold, setEnabled, getStatus: getFaceStatus,
  loadConfig: loadFaceConfig,
} = require('./src/face-recognition');

// ─── Helper: fetch messages — 3-strategy robust loader ──────────
// Strategy 1: chat.fetchMessages (official API)
// Strategy 2: Store.Chat.get + looped loadEarlierMsgs (best fallback)
// Strategy 3: WWebJS.getChat (last resort)
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

  // ── Strategy 2: Direct Store access with iterative loading ────
  try {
    const rawMsgs = await client.pupPage.evaluate(async (cid, lim) => {
      const chat = window.Store?.Chat?.get(cid);
      if (!chat) return null;
      let prev = 0;
      for (let i = 0; i < 5 && chat.msgs.length < lim; i++) {
        prev = chat.msgs.length;
        try {
          await window.Store.ConversationMsgs.loadEarlierMsgs(chat, chat.msgs);
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
      result._usedFallback = result.length < Math.min(limit * 0.3, 10);
      if (!result._usedFallback) logger.info(`fetchMessages S2 ok for "${chat.name}": ${result.length} msgs`);
      return result;
    }
  } catch (e2) {
    logger.warn(`fetchMessages S2 failed for "${chat.name}": ${e2.message?.substring(0, 60)}`);
  }

  // ── Strategy 3: WWebJS fallback ──────────────────────────────
  try {
    const rawMsgs = await client.pupPage.evaluate(async (cid, lim) => {
      const chat = await window.WWebJS.getChat(cid, { getAsModel: false });
      let msgs = chat.msgs.getModelsArray().filter(m => !m.isNotification);
      for (let i = 0; i < 3 && msgs.length < lim; i++) {
        try {
          const loaded = await window.Store.ConversationMsgs.loadEarlierMsgs(chat, chat.msgs);
          if (!loaded?.length) break;
          msgs = [...loaded.filter(m => !m.isNotification), ...msgs];
        } catch { break; }
      }
      msgs.sort((a, b) => a.t - b.t);
      if (msgs.length > lim) msgs = msgs.slice(-lim);
      return msgs.map(m => window.WWebJS.getMessageModel(m));
    }, chatId, limit);
    const result = rawMsgs.map(m => new Message(client, m));
    result._usedFallback = true;
    logger.warn(`fetchMessages S3 (last resort) for "${chat.name}": ${result.length} msgs`);
    return result;
  } catch (e3) {
    logger.error(`fetchMessages all strategies failed for "${chat.name}": ${e3.message?.substring(0, 60)}`);
    const empty = []; empty._usedFallback = true; return empty;
  }
}

// Returns true when fallback was used AND returned suspiciously few messages
function isFetchIncomplete(msgs, requested) {
  return msgs._usedFallback && msgs.length < Math.max(3, requested * 0.15);
}

// ─── Smart chat finder: exact > prefix > shortest-include ────────
// Prevents "קניות" from matching "קניות חכמות ברשת" when an exact match exists.
function findChatByName(chats, query) {
  const q = query.trim().toLowerCase();
  // 1. Exact match
  const exact = chats.find(c => (c.name || c.pushname || '').toLowerCase() === q);
  if (exact) return exact;
  // 2. Starts-with match (shortest name wins)
  const prefixes = chats.filter(c => (c.name || c.pushname || '').toLowerCase().startsWith(q));
  if (prefixes.length) return prefixes.sort((a, b) => (a.name||'').length - (b.name||'').length)[0];
  // 3. Includes match — prefer shortest name (closest to query)
  const includes = chats.filter(c => (c.name || c.pushname || '').toLowerCase().includes(q));
  if (includes.length) return includes.sort((a, b) => (a.name||'').length - (b.name||'').length)[0];
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
  whatsapp: async ({ action, phone, message, chatName, query, limit, toPhone, messageIndex }) => {
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
          return `❌ *שגיאה בטעינת ההיסטוריה של "${ch.name}"*\nWhatsApp Web לא הצליח לגשת להודעות הישנות יותר.\n💡 _פתח את הקבוצה ב-WhatsApp ולחץ על גלול למעלה, ואז שאל שוב._`;
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
          const reqLim = Math.min(limit||50, 100);
          const rawMsgs = await safeFetchMessages(ch, reqLim);
          if (isFetchIncomplete(rawMsgs, reqLim)) {
            return `❌ *שגיאה בטעינת ההיסטוריה של "${ch.name}"*\nWhatsApp Web לא הצליח לגשת להודעות הישנות יותר.\n💡 _פתח את הקבוצה ב-WhatsApp ולחץ על גלול למעלה, ואז שאל שוב._`;
          }
          const msgs = rawMsgs.filter(m => m.body?.trim().length > 2);
          if (!msgs.length) return `📋 אין הודעות ב-"${ch.name}" לסיכום.`;
          const dump = msgs.map(m => `[${new Date(m.timestamp*1000).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})}] ${m.fromMe?'מושיקו':(m._data?.notifyName||'משתתף')}: ${m.body}`).join('\n');
          return `📋 *"${ch.name}"* (${msgs.length} הודעות):\n━━━━━━━━━━━━━━━━━━━━\n\n${dump}\n\n━━━━━━━━━━━━━━━━━━━━\n_סכם בנקודות תמציתיות. נושאים עיקריים, החלטות, פעולות._`;
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
        const did = dailyIdCounter++; const tl = label || (daily_action==='group_summary'?'סקירת קבוצות':daily_action==='media_briefing'?'סקירת תקשורת בוקר':'שליחת הודעה');
        const cron = nodeCron.schedule(`${m[2]} ${m[1]} * * *`, async () => {
          console.log(`🔄 Daily #${did}: ${tl}`);
          try {
            const oc = await client.getChatById(OWNER_ID);
            if (daily_action === 'group_summary') {
              let sum = `📋 *סקירה יומית — ${time}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
              const allGroupContent = [];
              const groupStats = [];
              const {smartChat:sc} = require('./src/claude');
              for (const gn of (params.groups||[])) {
                const cs = await client.getChats(); const ch = findChatByName(cs, gn);
                if (!ch) { groupStats.push({name:gn,count:0,lastTs:0}); sum += `❌ "${gn}" — לא נמצאה\n\n`; continue; }
                const msgs = await safeFetchMessages(ch, 150); const day = Date.now()/1000-86400;
                const rec = msgs.filter(m => m.body && m.timestamp > day);
                groupStats.push({name:ch.name, count:rec.length, lastTs: msgs.length ? msgs[msgs.length-1].timestamp : 0});
                if (!rec.length) { sum += `*${ch.name}:* אין חדש\n\n`; continue; }
                const d = rec.map(m => `${m._data?.notifyName||'משתתף'}: ${m.body.substring(0,300)}`).join('\n');
                const s = await sc(`סכם בקצרה "${ch.name}" (${rec.length} הודעות 24ש):\n${d}`, []);
                sum += `*📌 ${ch.name}* (${rec.length}):\n${s}\n\n`;
                allGroupContent.push(`📌 ${ch.name}:\n${s}`);
              }
              if (groupStats.length) {
                const totalM = groupStats.reduce((a,g)=>a+g.count,0);
                const hot = [...groupStats].sort((a,b)=>b.count-a.count)[0];
                const lvl = totalM>300?'🔴🔴🔴🔴🔴 סוער':totalM>150?'🔴🔴🔴🟡 פעיל מאוד':totalM>50?'🟡🟡🟡 בינוני':'🟢🟢 שקט';
                const meter = `🌡️ *מד פעילות:* ${lvl}\n🏆 הכי פעיל: *${hot.name}* (${hot.count} הודעות)\n📊 סה"כ: *${totalM}* הודעות מ-${groupStats.filter(g=>g.count>0).length} קבוצות\n\n`;
                sum = sum.replace('━━━━━━━━━━━━━━━━━━━━\n\n', '━━━━━━━━━━━━━━━━━━━━\n\n' + meter);
              }
              await botSend(oc, sum);
              if (allGroupContent.length > 0) {
                try {
                  const synthesisPrompt = `אתה עוזר מודיעין פוליטי לדובר ח"כ אריאל קלנר (ליכוד). קראת סיכומים מהקבוצות הבאות:\n\n${allGroupContent.join('\n\n')}\n\nכתוב ניתוח בפורמט זה בדיוק:\n\n🔁 *כפילויות — ידיעות שחוזרות ביותר מקבוצה אחת:*\n• [ידיעה מדויקת]: ([שם קבוצה א], [שם קבוצה ב])\n(אם אין כפילויות — כתוב: "אין ידיעות כפולות")\n\n🔥 *TOP 3 — הכי חם:*\n1. [נושא — מקור: שם הקבוצה]\n2. [נושא — מקור: שם הקבוצה]\n3. [נושא — מקור: שם הקבוצה]\n\n💡 *זווית קלנר:*\n[נושא שקלנר יכול להגיב עליו — ביטחון, שלטון חוק, כלכלה]\n\n📲 *פעולה מוצעת:*\n[פעולה ספציפית — פרסום, תגובה לתקשורת, פוסט, יוזמה]`;
                  const synthesis = await sc(synthesisPrompt, []);
                  await botSend(oc, `━━━━━━━━━━━━━━━━━━━━\n🧠 *ניתוח מודיעין פוליטי:*\n\n${synthesis}`);
                  // ── Post drafts ────────────────────────────────────────────
                  try {
                    const draftsPrompt = `בהתבסס על הניתוח הפוליטי הבא, כתוב שתי טיוטות פוסט עבור ח"כ אריאל קלנר (ליכוד) בגוף ראשון:\n\n${synthesis}\n\nכתוב בדיוק בפורמט הזה:\n\n🐦 *טיוטה ל-X (טוויטר):*\n[טקסט קצר, מקסימום 240 תווים, גוף ראשון, ישיר ואגרסיבי, ציוני, ללא האשטאגים]\n\n📘 *טיוטה לפייסבוק:*\n[2-3 משפטים, גוף ראשון, עם הקשר ורקע, אישי יותר]`;
                    const drafts = await sc(draftsPrompt, []);
                    await botSend(oc, `━━━━━━━━━━━━━━━━━━━━\n✍️ *טיוטות פוסטים:*\n\n${drafts}`);
                  } catch (draftsErr) { logger.warn('⚠️ drafts generation failed:', draftsErr.message); }
                } catch (synthErr) { logger.warn('⚠️ synthesis failed:', synthErr.message); }
              }
            } else if (daily_action === 'media_briefing') {
              // Morning media briefing
              let briefing = `📡 *סקירת תקשורת בוקר — ${new Date().toLocaleDateString('he-IL')}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
              const queries = getBriefingSearchQueries(params.topics || []);
              const {smartChat:sc} = require('./src/claude');

              // News search via Claude with web_search
              const newsPrompt = `חפש ותסכם חדשות רלוונטיות לח"כ אריאל קלנר (ליכוד) והנושאים שלו: ${queries.slice(0,3).join(', ')}. סכם ב-5 נקודות קצרות. ציין מקורות.`;
              const newsSummary = await sc(newsPrompt, []);
              briefing += `📰 *חדשות רלוונטיות:*\n${newsSummary}\n\n`;

              // Social media search
              const socialPrompt = `חפש אזכורים של "אריאל קלנר" ב-X (twitter) ובפייסבוק. סכם מה אומרים עליו. site:x.com אריאל קלנר, site:facebook.com אריאל קלנר`;
              const socialSummary = await sc(socialPrompt, []);
              briefing += `🐦 *רשתות חברתיות:*\n${socialSummary}\n\n`;

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
        text += '_נסח תגובה בסגנון: "ח"כ אריאל קלנר (ליכוד): [ציטוט]"_';
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
      case 'status': {
        const s = ka.getStatus();
        return `🚨 *התראות מילות מפתח:*\n${s.enabled ? '✅ פעיל' : '❌ כבוי'}\n\nמילות מפתח (${s.keywords.length}):\n${s.keywords.map(k => `• ${k}`).join('\n')}`;
      }
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
});

// ─── Express ─────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

let botStatus = 'disconnected';
let currentQR = null;
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

// ─── WhatsApp Client ─────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'ai-personal-bot', dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    // Increase CDP protocol timeout for cloud environments (Railway/Render are slower than local)
    protocolTimeout: 120000, // 2 minutes (default is 30s)
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
    ],
  },
});

client.on('qr', async (qr) => {
  qrcodeTerminal.generate(qr, { small: true });
  console.log('\n📱 סרוק QR בוואטסאפ, או פתח http://localhost:3000\n');
  currentQR = await qrcode.toDataURL(qr);
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
          let sum = `📋 *סקירה יומית — ${d.time}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
          const allGroupContent = [];
          const groupStats = [];
          const {smartChat:sc} = require('./src/claude');
          for (const gn of (d.params.groups||[])) {
            const cs = await client.getChats(); const ch = findChatByName(cs, gn);
            if (!ch) { groupStats.push({name:gn,count:0,lastTs:0}); sum += `❌ "${gn}" — לא נמצאה\n\n`; continue; }
            const msgs = await safeFetchMessages(ch, 150); const day = Date.now()/1000-86400;
            const rec = msgs.filter(m => m.body && m.timestamp > day);
            groupStats.push({name:ch.name, count:rec.length, lastTs: msgs.length ? msgs[msgs.length-1].timestamp : 0});
            if (!rec.length) { sum += `*${ch.name}:* אין חדש\n\n`; continue; }
            const dump = rec.map(m => `${m._data?.notifyName||'משתתף'}: ${m.body.substring(0,300)}`).join('\n');
            const s = await sc(`סכם בקצרה "${ch.name}" (${rec.length} הודעות 24ש):\n${dump}`, []);
            sum += `*📌 ${ch.name}* (${rec.length}):\n${s}\n\n`;
            allGroupContent.push(`📌 ${ch.name}:\n${s}`);
          }
          if (groupStats.length) {
            const totalM = groupStats.reduce((a,g)=>a+g.count,0);
            const hot = [...groupStats].sort((a,b)=>b.count-a.count)[0];
            const lvl = totalM>300?'🔴🔴🔴🔴🔴 סוער':totalM>150?'🔴🔴🔴🟡 פעיל מאוד':totalM>50?'🟡🟡🟡 בינוני':'🟢🟢 שקט';
            const meter = `🌡️ *מד פעילות:* ${lvl}\n🏆 הכי פעיל: *${hot.name}* (${hot.count} הודעות)\n📊 סה"כ: *${totalM}* הודעות מ-${groupStats.filter(g=>g.count>0).length} קבוצות\n\n`;
            sum = sum.replace('━━━━━━━━━━━━━━━━━━━━\n\n', '━━━━━━━━━━━━━━━━━━━━\n\n' + meter);
          }
          await botSend(oc, sum);
          if (allGroupContent.length > 0) {
            try {
              const synthesisPrompt = `אתה עוזר מודיעין פוליטי לדובר ח"כ אריאל קלנר (ליכוד). קראת סיכומים מהקבוצות הבאות:\n\n${allGroupContent.join('\n\n')}\n\nכתוב ניתוח בפורמט זה בדיוק:\n\n🔁 *כפילויות — ידיעות שחוזרות ביותר מקבוצה אחת:*\n• [ידיעה מדויקת]: ([שם קבוצה א], [שם קבוצה ב])\n(אם אין כפילויות — כתוב: "אין ידיעות כפולות")\n\n🔥 *TOP 3 — הכי חם:*\n1. [נושא — מקור: שם הקבוצה]\n2. [נושא — מקור: שם הקבוצה]\n3. [נושא — מקור: שם הקבוצה]\n\n💡 *זווית קלנר:*\n[נושא שקלנר יכול להגיב עליו — ביטחון, שלטון חוק, כלכלה]\n\n📲 *פעולה מוצעת:*\n[פעולה ספציפית — פרסום, תגובה לתקשורת, פוסט, יוזמה]`;
              const synthesis = await sc(synthesisPrompt, []);
              await botSend(oc, `━━━━━━━━━━━━━━━━━━━━\n🧠 *ניתוח מודיעין פוליטי:*\n\n${synthesis}`);
            } catch (synthErr) { logger.warn('⚠️ synthesis failed:', synthErr.message); }
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

client.on('disconnected', (reason) => { console.log('❌ נותק:', reason); botStatus = 'disconnected'; io.emit('status', 'disconnected'); });

// ─── Send helper (auto-split long messages) ────────────────────
const MAX_MSG_LEN = 3000;

async function botSend(chat, text) {
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
    const suffix = isLast ? BOT_SIG + BOT_MARKER : `\n\n_📄 חלק ${i + 1}/${chunks.length}_` + BOT_MARKER;
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

    const chatId = msg.from;
    const toId = msg.to;

    // ONLY self-chat (both from AND to must be owner)
    if (!chatId || !toId) return;
    if (!chatId.endsWith('@c.us') || !toId.endsWith('@c.us')) return;
    if (chatId !== OWNER_ID || toId !== OWNER_ID) return;

    const rawBody = msg.body || '';
    if (rawBody.includes(BOT_MARKER)) return;

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
    if (botSleeping) return;

    // ── Reply-based feedback on forwarded photos ──────────────────
    // Any reply to a bot photo message → smart feedback handler
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
    if (/^(סקירה עכשיו|הרץ סקירה|סקירת קבוצות עכשיו|run briefing|briefing now|תסרוק קבוצות|תעשה סקירה עכשיו)/i.test(text)) {
      const summaryTask = [...dailyTasks.values()].find(d => d.action === 'group_summary');
      if (!summaryTask) {
        await botSend(chat, `❌ לא נמצאה משימת סקירה מתוזמנת. הגדר אחת קודם.`);
        stats.sent++; return;
      }
      await botSend(chat, `⏳ *מריץ סקירת קבוצות עכשיו...*\n_${(summaryTask.params.groups||[]).length} קבוצות — זה ייקח כמה שניות_`);
      // Run the same logic as the cron job, in background
      setImmediate(async () => {
        try {
          const oc = await client.getChatById(OWNER_ID);
          // Smart time window: from midnight today (not 24h ago) so morning scans cover today only
          const nowHour = new Date().getHours();
          const todayStart = (() => { const _d = new Date(); _d.setHours(0,0,0,0); return _d.getTime() / 1000; })();
          const day = nowHour < 20 ? todayStart : Date.now() / 1000 - 86400;
          let sum = `📋 *סקירה ידנית — ${new Date().toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
          const allGroupContent = [];
          const groupStats = [];
          const { smartChat: sc } = require('./src/claude');
          for (const gn of (summaryTask.params.groups || [])) {
            try {
              const cs = await client.getChats();
              const ch = findChatByName(cs, gn);
              if (!ch) { groupStats.push({name:gn,count:0,lastTs:0}); sum += `❌ "${gn}" — לא נמצאה\n\n`; continue; }
              const msgs = await safeFetchMessages(ch, 150);
              const rec = msgs.filter(m => m.body && m.timestamp > day);
              groupStats.push({name:ch.name, count:rec.length, lastTs: msgs.length ? msgs[msgs.length-1].timestamp : 0});
              if (!rec.length) { sum += `*${ch.name}:* אין חדש מהיום\n\n`; continue; }
              const d = rec.map(m => `${m._data?.notifyName || 'משתתף'}: ${m.body.substring(0, 300)}`).join('\n');
              const s = await sc(`סכם בקצרה "${ch.name}" (${rec.length} הודעות):\n${d}`, []);
              sum += `*📌 ${ch.name}* (${rec.length}):\n${s}\n\n`;
              allGroupContent.push(`📌 ${ch.name}:\n${s}`);
            } catch (ge) { sum += `⚠️ "${gn}" — שגיאה: ${ge.message?.substring(0,40)}\n\n`; }
          }
          if (groupStats.length) {
            const totalM = groupStats.reduce((a,g)=>a+g.count,0);
            const hot = [...groupStats].sort((a,b)=>b.count-a.count)[0];
            const lvl = totalM>300?'🔴🔴🔴🔴🔴 סוער':totalM>150?'🔴🔴🔴🟡 פעיל מאוד':totalM>50?'🟡🟡🟡 בינוני':'🟢🟢 שקט';
            const meter = `🌡️ *מד פעילות:* ${lvl}\n🏆 הכי פעיל: *${hot.name}* (${hot.count} הודעות)\n📊 סה"כ: *${totalM}* הודעות מ-${groupStats.filter(g=>g.count>0).length} קבוצות\n\n`;
            sum = sum.replace('━━━━━━━━━━━━━━━━━━━━\n\n', '━━━━━━━━━━━━━━━━━━━━\n\n' + meter);
          }
          await botSend(oc, sum);
          if (allGroupContent.length > 0) {
            const synthPrompt = `אתה עוזר מודיעין פוליטי לדובר ח"כ אריאל קלנר (ליכוד). קראת סיכומים מהקבוצות הבאות:\n\n${allGroupContent.join('\n\n')}\n\nכתוב ניתוח בפורמט זה בדיוק:\n\n🔁 *כפילויות — ידיעות שחוזרות ביותר מקבוצה אחת:*\n• [ידיעה מדויקת]: ([שם קבוצה א], [שם קבוצה ב])\n(אם אין כפילויות — כתוב: "אין ידיעות כפולות")\n\n🔥 *TOP 3 — הכי חם:*\n1. [נושא — מקור: שם הקבוצה]\n2. [נושא — מקור: שם הקבוצה]\n3. [נושא — מקור: שם הקבוצה]\n\n💡 *זווית קלנר:*\n[נושא שקלנר יכול להגיב עליו — ביטחון, שלטון חוק, כלכלה]\n\n📲 *פעולה מוצעת:*\n[פעולה ספציפית — פרסום, תגובה לתקשורת, פוסט, יוזמה]`;
            const synthesis = await sc(synthPrompt, []);
            await botSend(oc, `━━━━━━━━━━━━━━━━━━━━\n🧠 *ניתוח מודיעין פוליטי:*\n\n${synthesis}`);
          }
        } catch (err) { logger.error('Manual briefing error:', err.message); }
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
    console.error('שגיאה:', err.message);
    // If it's a 400 API error, clear history for this chat to recover
    if (err.status === 400 || (err.message && err.message.includes('400'))) {
      console.error('🔴 400 error detected — clearing conversation history for', chatId);
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

    // If user provided caption, follow their intent; otherwise full analysis
    const prompt = caption
      ? `[🎙️ הקלטת שיחה — ${fileName} (${sizeMB}MB, ~${estMinutes} דק׳)]\n\nתמלול:\n${truncated}\n\n---\nבקשת המשתמש: ${caption}`
      : `[🎙️ הקלטת שיחת טלפון — ${fileName} (${sizeMB}MB, ~${estMinutes} דק׳)]\n\nתמלול השיחה:\n${truncated}\n\n---\nזו הקלטת שיחת טלפון. בבקשה:\n1. 📝 *סכם* את השיחה — מי דיבר, על מה, מה סוכם\n2. ✅ *חלץ משימות* — כל דבר שסוכם/הובטח/נדרש פעולה. ציין אחראי ודדליין\n3. 📅 אם נקבעו *פגישות/מועדים* — הוסף ליומן אוטומטית (calendar add)\n4. ⏰ אם יש *משימות עם דדליין* — הצע תזכורת (schedule once)\n5. 🧠 *שמור בזיכרון* פרטים חשובים (memory save)\nפורמט מסודר עם אימוג'ים.`;

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
          const _preview = msg.body.substring(0, 120);
          const _ownerC = await client.getChatById(OWNER_ID);
          await botSend(_ownerC,
            `🚨 *התראה — מילת מפתח: "${_matchedKw}"*\n` +
            `📍 *${_groupNameForAlert}*\n` +
            `👤 ${_sender}\n` +
            `💬 "${_preview}${msg.body.length > 120 ? '...' : ''}"`
          );
        } catch (_alertErr) { /* silent */ }
      }
    }
  }
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

    // Check if this group is in the monitored list (partial match)
    const isMonitored = status.monitoredGroups.some(g =>
      groupName.includes(g) || g.includes(groupName),
    );
    if (!isMonitored) return;

    // Owner's photos are handled exclusively by message_create (ownerGroups block).
    // Never process them here to avoid double-processing and infinite loops.
    if (msg.fromMe) return;

    console.log(`📷 Group photo from "${groupName}" — checking faces...`);

    const media = await msg.downloadMedia();
    if (!media || !media.data) return;

    const imageBuffer = Buffer.from(media.data, 'base64');
    const matches = await findMatches(imageBuffer);

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

      const photoData = { name: match.name, imageBuffer, confidence: match.confidence, groupName };
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
  // Any short message after a forwarded photo → route directly to Claude vision feedback handler.
  // No keyword gating — Claude inside handlePhotoFeedback understands ANY phrasing:
  //   "זאת לא שי", "זה מיה", "טעות", "נכון", "כן", "לא הוא" etc.
  const lastPhoto = lastForwardedPhoto.get(chatId);
  if (lastPhoto && text.length < 150 && !text.startsWith('/')) {
    const reply = await handlePhotoFeedback(text.trim(), lastPhoto, null);
    // Clear pending photo only after meaningful action (confirm / deny)
    if (reply.startsWith('✅') || reply.startsWith('📝 *')) {
      lastForwardedPhoto.delete(chatId);
    }
    return reply;
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
});

// ─── Health endpoint (for hosting keep-alive) ──────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', bot: botStatus, uptime: Math.round(process.uptime()), mem: Math.round(process.memoryUsage.rss?.() / 1048576 || process.memoryUsage().rss / 1048576) + 'MB' });
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
    logger.warn(`⚠️ Watchdog: connection dead (${e.message?.substring(0, 60)}) — restarting`);
    // Do NOT logout — that deletes the WhatsApp session (forces QR re-scan).
    // Just exit; Railway/pm2 restarts the process with the session intact.
    process.exit(1);
  }
}, 20 * 60 * 1000);

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
    const today = new Date().toLocaleDateString('he-IL');

    const twitterPrompt = `חפש אזכורים חדשים של ח"כ אריאל קלנר ב-X (טוויטר) ובחדשות מה-24 שעות האחרונות.
בצע את החיפושים הבאים:
1. site:x.com "ArielKallner" OR "קלנר"
2. "אריאל קלנר" חדשות site:ynet.co.il OR site:maariv.co.il OR site:walla.co.il OR site:nrg.co.il
3. @ArielKallner twitter

פרמט התשובה:
🐦 *אזכורי X/טוויטר:*
[רשימת ציוצים/תגובות עם שם המצייץ, תוכן, קישור]

📰 *אזכורים בחדשות:*
[כותרת, מקור, תאריך, קישור]

⚡ *פעולה מוצעת:*
[האם יש משהו שדורש תגובה מיידית? אם כן — מה?]

אם לא נמצא כלום — כתוב רק "אין אזכורים חדשים ל-${today}"`;

    const result = await _sc(twitterPrompt, []);
    await botSend(oc, `🔍 *מעקב מדיה יומי — ${today}*\n━━━━━━━━━━━━━━━━━━━━\n\n${result}`);
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

    // Calendar
    let calendarSection = '📅 *לוח שנה — היום:*\n';
    try {
      const events = await getTodaySchedule();
      calendarSection += events || '_אין אירועים_';
    } catch { calendarSection += '_לא זמין_'; }

    // Emails
    let emailSection = '\n\n📧 *מיילים חדשים:*\n';
    try {
      const emails = await getUnreadEmails();
      emailSection += emails ? emails.substring(0, 400) : '_אין מיילים_';
    } catch { emailSection += '_לא זמין_'; }

    // Pending media contacts
    let mediaSection = '\n\n📞 *ממתינים לתשובה:*\n';
    try {
      const contacts = listContacts();
      const pendingMatch = contacts.match(/⏳[^\n]+(\n[^\n]+)*/g);
      mediaSection += pendingMatch?.length ? pendingMatch.slice(0, 3).join('\n') : '_אין ממתינים_';
    } catch { mediaSection += '_לא זמין_'; }

    const greeting = `☀️ *בוקר טוב מושיקו!*\n━━━━━━━━━━━━━━━━━━━━\n`;
    await botSend(oc, greeting + calendarSection + emailSection + mediaSection);
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

client.initialize().catch((err) => {
  console.error('שגיאת אתחול:', err.message);
  process.exit(1);
});
