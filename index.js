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
} = require('./src/calendar');
const { getSystemInfo, listFiles, readFile, searchFiles, runCommand, getProcesses, getBattery, getWifi } = require('./src/computer');
const {
  getUnreadEmails, searchEmails, readEmail, sendEmail, replyToEmail,
  markAsRead, trashEmail, starEmail, getGmailStats,
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
  initFaceAPI, addReference, findMatches, blurNonMatchingFaces,
  isBlurEnabled, setBlurEnabled,
  getMonitoredGroups, addMonitoredGroup, removeMonitoredGroup,
  getReferenceCount, clearReferences, setThreshold, setEnabled, getStatus: getFaceStatus,
} = require('./src/face-recognition');

// ─── Helper: fetch messages with loadEarlierMsgs bug workaround ─
async function safeFetchMessages(chat, limit) {
  const chatId = chat.id._serialized || chat.id;
  try {
    // First try the normal way
    return await chat.fetchMessages({ limit });
  } catch {
    // Fallback: use pupPage.evaluate directly, wrapping loadEarlierMsgs in try/catch
    logger.warn(`fetchMessages failed for "${chat.name}", using fallback...`);
    const Message = require('whatsapp-web.js/src/structures/Message');
    const rawMsgs = await client.pupPage.evaluate(async (cid, lim) => {
      const chat = await window.WWebJS.getChat(cid, { getAsModel: false });
      let msgs = chat.msgs.getModelsArray().filter(m => !m.isNotification);
      // Try loading more messages, but don't crash if it fails
      if (lim > 0 && msgs.length < lim) {
        try {
          const loaded = await window.Store.ConversationMsgs.loadEarlierMsgs(chat, chat.msgs);
          if (loaded?.length) msgs = [...loaded.filter(m => !m.isNotification), ...msgs];
        } catch {}
      }
      if (msgs.length > lim) {
        msgs.sort((a, b) => (a.t > b.t) ? 1 : -1);
        msgs = msgs.splice(msgs.length - lim);
      }
      return msgs.map(m => window.WWebJS.getMessageModel(m));
    }, chatId, limit);
    return rawMsgs.map(m => new Message(client, m));
  }
}

// ─── Register unified tool handlers for Claude ──────────────────
registerToolHandlers({
  // ─── Calendar (unified) ───────────────────────────────────────
  calendar: withCache('calendar', async ({ action, days, event_text, query, index, recurrence, recurrence_days, recurrence_count, recurrence_until }) => {
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
  }),
  // ─── Gmail (unified) ──────────────────────────────────────────
  gmail: withCache('gmail', async ({ action, index, query, to, subject, body }) => {
    switch (action) {
      case 'unread': return getUnreadEmails();
      case 'search': return searchEmails(query);
      case 'read': return readEmail(index);
      case 'reply': return replyToEmail(index, body);
      case 'send': return sendEmail(to, subject, body);
      case 'mark_read': return markAsRead(index);
      case 'trash': return trashEmail(index);
      case 'star': return starEmail(index);
      case 'stats': return getGmailStats();
      default: return `פעולה לא מוכרת: ${action}`;
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
        const ch = chats.find(c => (c.name || c.pushname || '').toLowerCase().includes(chatName.toLowerCase()));
        if (!ch) return `❌ לא נמצאה שיחה "${chatName}"`;
        const msgs = await safeFetchMessages(ch, Math.min(limit || 20, 50));
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
        let searchIn = chatName ? [chats.find(c => (c.name||c.pushname||'').toLowerCase().includes(chatName.toLowerCase()))].filter(Boolean) : chats.slice(0, 15);
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
          const ch = chats.find(c => (c.name||c.pushname||'').toLowerCase().includes(chatName.toLowerCase()));
          if (!ch) return `❌ לא נמצאה "${chatName}"`;
          const msgs = (await safeFetchMessages(ch, Math.min(limit||50, 100))).filter(m => m.body?.trim().length > 2);
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
        const src = chats.find(c => (c.name||c.pushname||'').toLowerCase().includes(chatName.toLowerCase()));
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
              for (const gn of (params.groups||[])) {
                const cs = await client.getChats(); const ch = cs.find(c => (c.name||'').toLowerCase().includes(gn.toLowerCase()));
                if (!ch) { sum += `❌ "${gn}" — לא נמצאה\n\n`; continue; }
                const msgs = await safeFetchMessages(ch, 50); const day = Date.now()/1000-86400;
                const rec = msgs.filter(m => m.body && m.timestamp > day);
                if (!rec.length) { sum += `*${ch.name}:* אין חדש\n\n`; continue; }
                const d = rec.map(m => `${m._data?.notifyName||'משתתף'}: ${m.body.substring(0,150)}`).join('\n');
                const {smartChat:sc} = require('./src/claude');
                const s = await sc(`סכם בקצרה "${ch.name}" (${rec.length} הודעות 24ש):\n${d}`, []);
                sum += `*📌 ${ch.name}* (${rec.length}):\n${s}\n\n`;
              }
              await botSend(oc, sum);
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
                  const cs = await client.getChats(); const ch = cs.find(c => (c.name||'').toLowerCase().includes(gn.toLowerCase()));
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
        let text = `📷 *סינון תמונות: ${s.enabled ? '✅ פעיל' : '❌ כבוי'}*\n`;
        text += `🔒 טשטוש פנים: ${s.blurEnabled ? '✅ פעיל' : '❌ כבוי'}\n`;
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
      case 'set_threshold':
        if (threshold === undefined) return '❌ ציין סף (0.1-0.8)';
        return `✅ סף רגישות עודכן ל-${setThreshold(threshold)}\n_נמוך=קפדן, גבוה=מתירני_`;
      case 'clear_references':
        clearReferences(name);
        return name ? `✅ תמונות הייחוס של "${name}" נמחקו` : '✅ כל תמונות הייחוס נמחקו';
      case 'toggle':
        setEnabled(enabled !== false);
        return `📷 סינון תמונות: ${enabled !== false ? '✅ פעיל' : '❌ כבוי'}`;
      case 'toggle_blur':
        setBlurEnabled(enabled !== false);
        return `🔒 טשטוש פנים: ${enabled !== false ? '✅ פעיל — פנים אחרות יטושטשו' : '❌ כבוי — תמונות מקוריות'}`;
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

const OWNER_ID = '972524243250@c.us';
const BOT_MARKER = '\u200B\u200C\u200B';
const BOT_SIG = '\n\n— *🤖 בוטי*';
let lastVideoPath = null;

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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
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
          for (const gn of (d.params.groups||[])) {
            const cs = await client.getChats(); const ch = cs.find(c => (c.name||'').toLowerCase().includes(gn.toLowerCase()));
            if (!ch) { sum += `❌ "${gn}" — לא נמצאה\n\n`; continue; }
            const msgs = await safeFetchMessages(ch, 50); const day = Date.now()/1000-86400;
            const rec = msgs.filter(m => m.body && m.timestamp > day);
            if (!rec.length) { sum += `*${ch.name}:* אין חדש\n\n`; continue; }
            const dump = rec.map(m => `${m._data?.notifyName||'משתתף'}: ${m.body.substring(0,150)}`).join('\n');
            const {smartChat:sc} = require('./src/claude');
            const s = await sc(`סכם בקצרה "${ch.name}" (${rec.length} הודעות 24ש):\n${dump}`, []);
            sum += `*📌 ${ch.name}* (${rec.length}):\n${s}\n\n`;
          }
          await botSend(oc, sum);
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

// ─── Message Handler ─────────────────────────────────────────────
const ALLOWED_TYPES = new Set(['chat', 'image', 'sticker', 'ptt', 'audio', 'document']);

client.on('message_create', async (msg) => {
  try {
    // Only handle text and images
    if (!ALLOWED_TYPES.has(msg.type)) return;

    const chatId = msg.from;
    const toId = msg.to;

    // ONLY self-chat (both from AND to must be owner)
    if (!chatId || !toId) return;
    if (!chatId.endsWith('@c.us') || !toId.endsWith('@c.us')) return;
    if (chatId !== OWNER_ID || toId !== OWNER_ID) return;

    const rawBody = msg.body || '';
    if (rawBody.includes(BOT_MARKER)) return;

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
      const refMatch = caption.match(/ייחוס\s+(?:של\s+)?(.+)/);
      if (refMatch) {
        const refName = refMatch[1].trim();
        console.log(`📨 [${ts()}] 📸 תמונת ייחוס: ${refName}`);
        stats.received++;
        log({ time: ts(), from: 'מושיקו', text: `📸 ייחוס ${refName}`, direction: 'in' });
        const chat = await msg.getChat();
        await chat.sendStateTyping();
        const response = await handleReferencePhoto(msg, refName);
        await botSend(chat, response);
        stats.sent++;
        log({ time: ts(), from: 'בוטי', text: response.substring(0, 120), direction: 'out' });
        return;
      }

      // ── Test mode: "בדיקה" = match only, "בדיקת טשטוש" = match + blur ──
      const isBlurTest = /^(בדיקת טשטוש|טשטוש|blur)/i.test(caption.trim());
      const isMatchTest = /^(בדיקה|בדוק|test|טסט|זיהוי)$/i.test(caption.trim());
      if (isBlurTest || isMatchTest) {
        const testType = isBlurTest ? '🔒 בדיקת טשטוש' : '🔍 בדיקת זיהוי';
        console.log(`📨 [${ts()}] ${testType}`);
        stats.received++;
        log({ time: ts(), from: 'מושיקו', text: testType, direction: 'in' });
        const chat = await msg.getChat();
        await chat.sendStateTyping();
        const response = await handleFaceTest(msg, isBlurTest);
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
      ? `\n\n💡 _לדיוק טוב יותר — שלח עוד ${3 - result.totalReferences} תמונות לפחות מזוויות שונות._\n_כתוב "ייחוס ${name}" בכיתוב של כל תמונה._`
      : result.totalReferences < 8
        ? `\n\n💡 _יש ${result.totalReferences} תמונות ייחוס — טוב! עוד כמה ישפרו את הדיוק._`
        : `\n\n✨ _${result.totalReferences} תמונות ייחוס — מעולה! דיוק מקסימלי._`;

    return `✅ *תמונת ייחוס נוספה ל-${name}!*\n` +
      `👤 פנים שזוהו בתמונה: ${result.facesAdded}\n` +
      `📊 סה"כ תמונות ייחוס: ${result.totalReferences}` + tips;
  } catch (err) {
    console.error('Reference photo error:', err.message);
    return '❌ שגיאה בעיבוד תמונת ייחוס: ' + err.message.substring(0, 80);
  }
}

// ─── Face Test Handler (test matching + optional blur preview) ──
async function handleFaceTest(msg, withBlur = false) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return '❌ לא הצלחתי להוריד את התמונה';

    const imageBuffer = Buffer.from(media.data, 'base64');
    console.log(`🔍 Face test (${(imageBuffer.length / 1024).toFixed(0)}KB)`);

    const { detectFaces } = require('./src/face-recognition');
    const detections = await detectFaces(imageBuffer);
    const matches = await findMatches(imageBuffer);

    let response = `🔍 *בדיקת זיהוי פנים:*\n\n`;
    response += `👤 פנים שזוהו בתמונה: *${detections.length}*\n`;

    if (detections.length === 0) {
      response += '\n❌ לא זוהו פנים. נסה תמונה שרואים בה פנים בבירור.';
      return response;
    }

    if (matches.length > 0) {
      response += '\n✅ *התאמות:*\n';
      for (const m of matches) {
        const emoji = m.confidence >= 70 ? '🟢' : m.confidence >= 50 ? '🟡' : '🔴';
        response += `  ${emoji} *${m.name}* — ${m.confidence}% (מרחק: ${m.distance})\n`;
      }
      response += '\n_🟢 70%+ = בטוח, 🟡 50-70% = סביר, 🔴 <50% = לא בטוח_';

      // Send blurred preview only if requested
      if (withBlur && detections.length > matches.length) {
        try {
          const { buffer: blurredBuf, blurred } = await blurNonMatchingFaces(imageBuffer);
          if (blurred > 0) {
            const { MessageMedia } = require('whatsapp-web.js');
            const blurredMedia = new MessageMedia('image/jpeg', blurredBuf.toString('base64'), 'blurred.jpg');
            const chat = await msg.getChat();
            await chat.sendMessage(blurredMedia, {
              caption: `🔒 תצוגה מקדימה: ${blurred} פנים טושטשו, ${matches.length} נשארו חדים` + BOT_MARKER,
            });
          }
        } catch (blurErr) {
          response += `\n\n⚠️ טשטוש נכשל: ${blurErr.message?.substring(0, 50)}`;
        }
      }
    } else {
      response += '\n❌ אין התאמה לאף תמונת ייחוס.';
      const status = getFaceStatus();
      if (status.totalReferences === 0) {
        response += '\n\n💡 שלח תמונת ייחוס קודם (כיתוב "ייחוס שי")';
      } else {
        response += `\n\n📊 יש ${status.totalReferences} תמונות ייחוס. סף נוכחי: ${status.threshold}`;
        response += '\n💡 אפשר להוריד את הסף (אמור "תוריד רגישות") אם יש יותר מדי פספוסים';
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
  try {
    if (msg.type !== 'image') return;
    if (!msg.from?.endsWith('@g.us')) return;
    if (msg.fromMe) return;

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

    console.log(`📷 Group photo from "${groupName}" — checking faces...`);

    const media = await msg.downloadMedia();
    if (!media || !media.data) return;

    const imageBuffer = Buffer.from(media.data, 'base64');
    const matches = await findMatches(imageBuffer);

    if (matches.length > 0) {
      const match = matches[0];
      console.log(`🎀 Match: ${match.name} (${match.confidence}%) from "${groupName}"`);

      const ownerChat = await client.getChatById(OWNER_ID);
      const sender = msg._data?.notifyName || 'מישהו';
      const time = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

      // Send with blur (if enabled) or forward original
      if (isBlurEnabled()) {
        try {
          const { buffer: blurredBuf, blurred } = await blurNonMatchingFaces(imageBuffer);
          const { MessageMedia } = require('whatsapp-web.js');
          const blurredMedia = new MessageMedia('image/jpeg', blurredBuf.toString('base64'), 'photo.jpg');
          const caption = `🎀 *תמונה של ${match.name}!*\n` +
            `📍 ${groupName} · 👤 ${sender}\n` +
            `📊 ${match.confidence}%` +
            (blurred > 0 ? ` · 🔒 ${blurred} פנים טושטשו` : '') +
            `\n⏰ ${time}`;
          await ownerChat.sendMessage(blurredMedia, { caption: caption + BOT_MARKER });
        } catch (blurErr) {
          console.error('Blur failed, forwarding original:', blurErr.message?.substring(0, 60));
          await msg.forward(OWNER_ID);
          await ownerChat.sendMessage(
            `🎀 *תמונה של ${match.name}!*\n📍 ${groupName} · 📊 ${match.confidence}%\n⏰ ${time}` + BOT_MARKER,
          );
        }
      } else {
        await msg.forward(OWNER_ID);
        await ownerChat.sendMessage(
          `🎀 *תמונה של ${match.name}!*\n📍 ${groupName} · 👤 ${sender}\n📊 ${match.confidence}%\n⏰ ${time}` + BOT_MARKER,
        );
      }
      stats.sent++;
    } else {
      console.log(`📷 No match in "${groupName}" photo`);
    }
  } catch (err) {
    // Silent — don't spam logs for every group photo error
    if (err.message?.includes('not initialized')) return; // models still loading
    console.error('Photo filter error:', (err.message || '').substring(0, 80));
  }
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
      system: 'אתה "בוטי" — העוזר האישי של מושיקו בוואטסאפ. ענה קצר וטבעי בעברית. תשתמש בסלנג ישראלי.',
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

  // Quick commands (still work for power users)
  if (/^\/(תפריט|menu|help|עזרה|start)/i.test(text)) return helpMenu();
  if (/^\/(חדש|חדשות|עדכון|changelog|whatsnew|מה חדש)/i.test(text)) return whatsNew();
  if (/^\/(נקה|clear)/i.test(text)) { conversations.delete(chatId); saveConversations(conversations); clearFailedTools(); return '🗑️ היסטוריה נוקתה!'; }
  if (/^\/think\s+/i.test(text)) return thinkWithClaude(text.replace(/^\/think\s+/i, ''), getHistory(chatId));
  if (/^\/(code|קוד)\s+/i.test(text)) return runClaudeCode(text.replace(/^\/(code|קוד)\s+/i, ''));

  // Reminder (keep as special — needs setTimeout)
  if (/^\/(תזכורת|remind)\s+/i.test(text)) return handleReminder(chatId, text.replace(/^\/(תזכורת|remind)\s+/i, ''));

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
function whatsNew() {
  return `╭──── *🆕 מה חדש בבוטי?* ────╮
╰────────────────────────╯

*📌 עדכון אחרון: 13/4/2026*

━━ *חדש!* ━━━━━━━━━━━━━━━

*💬 קריאת שיחות וואטסאפ*
• _"תראה שיחות"_ — רשימת כל השיחות
• _"תקרא את השיחה עם יובל"_ — הודעות אחרונות
• _"תחפש בוואטסאפ ראיון"_ — חיפוש בכל השיחות
• קריאה בלבד — בלי אישור

*📋 סיכום קבוצות*
• _"תסכם את הקבוצה של..."_ — סיכום תמציתי
• מתמקד בנושאים עיקריים, החלטות, ופעולות

*↗️ העברת הודעות*
• _"תעביר את ההודעה מהקבוצה לקלנר"_
• העברה אמיתית (forward) — עם אישור

*🔄 משימות יומיות חוזרות*
• _"כל יום ב-8:00 תשלח סקירה מהקבוצות"_
• _"כל בוקר תשלח בוקר טוב ליובל"_
• אפשר לראות ולבטל: _"מה יש יומי?"_

*⏰ תזמון שליחה*
• _"תשלח הודעה לדני בעוד 30 דקות"_
• _"תזמן מייל מחר בבוקר"_
• וואטסאפ + מייל · אישור כשנשלח

*🎬 יצירת סרטונים (Remotion)*
• *text* — כותרת לסטורי (1080x1920)
• *quote* — ציטוט מעוצב (1080x1080)
• *slideshow* — מצגת שקפים (1080x1920)
• אנימציות מקצועיות, צבעים מותאמים, RTL
• _"איזה סרטונים יש?"_ למדריך מלא

*🎤 הודעות קוליות*
• תמלול Whisper (עברית מלא)
• אחרי תמלול — גישה לכל הכלים

━━ *בסיס* ━━━━━━━━━━━━━━━

*📅 יומן* — צפייה, הוספה, חיפוש, מחיקה
*📧 Gmail* — קריאה, שליחה, תשובה, מחיקה, כוכב (RTL)
*📇 אנשי קשר* — חיפוש, רשימה, פרטים מלאים
*📲 שליחת וואטסאפ* — עם אישור
*🌐 חיפוש אינטרנט* — כל שאלה
*🖼️ תמונות* — ניתוח תמונות
*💻 מחשב* — סוללה, קבצים, תהליכים, פקודות
*🧠 זיכרון* — שומר מה שלימדת, לא שוכח
*⚠️ אישור* — לפני שליחה/מחיקה. קריאה — חופשי

━━━━━━━━━━━━━━━━━━━━
💡 _פשוט תכתוב לי בשפה רגילה ואני אבין!_`;
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

// ─── Keep-alive self-ping (prevents free-tier hosting from sleeping) ─
if (process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL) {
  const keepAliveUrl = (process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL) + '/health';
  setInterval(() => {
    require('https').get(keepAliveUrl, () => {}).on('error', () => {});
    console.log('💓 Keep-alive ping');
  }, 13 * 60 * 1000); // every 13 minutes
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
