'use strict';
/**
 * Telegram client — MTProto user-mode access via GramJS.
 *
 * Why user-mode (not Bot API):
 *   The Bot API can only see messages in groups where the bot is added as
 *   admin AND privacy mode is off. It cannot read the user's existing groups.
 *   MTProto logs in AS the user (phone + SMS code), so we get full access to
 *   every chat/channel/group the user is already in — read-only.
 *
 * Auth flow:
 *   1. User obtains api_id + api_hash from https://my.telegram.org/auth/apps
 *      → saved as TELEGRAM_API_ID / TELEGRAM_API_HASH in .env
 *   2. Run `node setup-telegram.js` once → prompts for phone + SMS code
 *      → saves TELEGRAM_SESSION (StringSession) in .env
 *   3. Bot startup connects silently using the saved session — no SMS again.
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const logger = require('./logger');

let _client = null;
let _connecting = null;

function _envInt(name) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : null;
}

function isConfigured() {
  return Boolean(
    _envInt('TELEGRAM_API_ID') &&
    process.env.TELEGRAM_API_HASH &&
    process.env.TELEGRAM_SESSION
  );
}

function statusLabel() {
  if (!_envInt('TELEGRAM_API_ID') || !process.env.TELEGRAM_API_HASH) return 'לא מוגדר (אין API ID/HASH)';
  if (!process.env.TELEGRAM_SESSION) return 'מוגדר אבל לא מחובר — הרץ setup-telegram.js';
  if (_client && _client.connected) return 'מחובר';
  return 'מוגדר — לא מחובר עדיין';
}

/**
 * Connect (lazily, idempotently). Returns the singleton TelegramClient
 * or throws if Telegram is not configured.
 */
// ── Timeout wrapper: any Telegram operation that hangs >30s aborts ──
// GramJS occasionally hangs on a dead socket (especially after long idle).
// Without a timeout, this freezes the entire bot's Claude tool-loop for
// minutes until the user manually nudges it.
async function withTimeout(label, promise, ms = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Telegram timeout (${ms}ms): ${label}`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); })
           .catch(e => { clearTimeout(t); reject(e); });
  });
}

// Force a fresh connect — call when the current client is suspected dead
async function _reconnect() {
  if (_client) {
    try { await _client.disconnect(); } catch {}
    _client = null;
  }
  _connecting = null;
  return await getClient();
}

async function getClient() {
  if (_client && _client.connected) return _client;
  if (_connecting) return _connecting;

  if (!isConfigured()) {
    throw new Error('Telegram לא מוגדר. הרץ: node setup-telegram.js');
  }

  _connecting = (async () => {
    const apiId = _envInt('TELEGRAM_API_ID');
    const apiHash = process.env.TELEGRAM_API_HASH;
    const session = new StringSession(process.env.TELEGRAM_SESSION);
    const c = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      deviceModel: 'WhatsApp Bot',
      systemVersion: 'Win10',
      appVersion: '1.0',
      // Silence GramJS's chatty internal logger — only show errors.
      // GramJS calls .canSend(level) before every log; without it, crashes
      // with "client._log.canSend is not a function" deep in internals.
      baseLogger: {
        warn() {}, info() {}, debug() {},
        error: (...a) => logger.warn('[gramjs]', ...a),
        canSend() { return false; },  // suppress every level for GramJS internals
        log() {},
        setLevel() {},
      },
    });
    await c.connect();

    // ── Read-only safeguard: monkey-patch all write methods to throw ──
    // The Telegram API itself has no read-only token (user sessions = full
    // access). We enforce read-only at this layer so even buggy/future code
    // cannot send/edit/delete/forward.
    const WRITE_METHODS = [
      'sendMessage', 'sendFile', 'sendMedia', 'sendVoice', 'sendDocument',
      'editMessage', 'forwardMessages', 'deleteMessages', 'pinMessage', 'unpinMessage',
      'markAsRead', 'sendReaction', 'inviteToChannel', 'kickParticipant',
      'editAdmin', 'editPhoto', 'editTitle',
    ];
    for (const m of WRITE_METHODS) {
      if (typeof c[m] === 'function') {
        c[m] = () => {
          const err = new Error(`Telegram write blocked: '${m}' is forbidden — this bot is read-only.`);
          logger.warn(`🛡️  [tg readonly] blocked attempt to call ${m}`);
          throw err;
        };
      }
    }
    _client = c;
    logger.info('📡 Telegram client connected (read-only mode)');
    return c;
  })().catch(e => {
    _connecting = null;
    throw e;
  });

  return _connecting;
}

/**
 * List the user's dialogs (chats/channels/groups), most recent first.
 * Returns lightweight summaries — name, id, kind (channel/group/user), unread.
 */
async function listDialogs({ limit = 30, kind } = {}) {
  let c = await getClient();
  let dialogs;
  try {
    dialogs = await withTimeout('getDialogs', c.getDialogs({ limit: Math.min(Math.max(limit, 1), 100) }), 30000);
  } catch (e) {
    // If timed out / connection dead — reconnect and retry once
    logger.warn(`getDialogs failed (${e.message}); reconnecting`);
    c = await _reconnect();
    dialogs = await withTimeout('getDialogs[retry]', c.getDialogs({ limit: Math.min(Math.max(limit, 1), 100) }), 30000);
  }

  const summaries = dialogs.map(d => {
    const entity = d.entity;
    let kindLabel = 'private';
    let title = d.title || entity?.firstName || entity?.username || '(ללא שם)';
    if (entity?.className === 'Channel') {
      kindLabel = entity.broadcast ? 'channel' : 'group';
    } else if (entity?.className === 'Chat') {
      kindLabel = 'group';
    }
    return {
      id: String(d.id),
      title,
      kind: kindLabel,
      unread: d.unreadCount || 0,
      lastMessage: d.message?.message?.substring(0, 100) || '',
      lastDate: d.date ? new Date(d.date * 1000).toISOString() : null,
    };
  });

  return kind ? summaries.filter(s => s.kind === kind) : summaries;
}

/**
 * Find a dialog by fuzzy name match (case-insensitive substring, Hebrew-aware).
 * Returns the raw GramJS dialog or null.
 */
async function findDialogByName(name) {
  if (!name) return null;
  let c = await getClient();
  let dialogs;
  try {
    dialogs = await withTimeout('getDialogs(find)', c.getDialogs({ limit: 100 }), 30000);
  } catch (e) {
    logger.warn(`findDialogByName failed (${e.message}); reconnecting`);
    c = await _reconnect();
    dialogs = await withTimeout('getDialogs(find)[retry]', c.getDialogs({ limit: 100 }), 30000);
  }
  const norm = s => (s || '')
    .normalize('NFC')
    .replace(/[֑-ֽֿ-ׇ​-‏‪-‮︎️]/g, '')
    .replace(/[״׳"']/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
  const q = norm(name);
  if (!q) return null;
  const indexed = dialogs.map(d => ({
    dialog: d,
    title: d.title || d.entity?.firstName || d.entity?.username || '',
  })).filter(x => x.title);
  // Exact > prefix > includes
  const exact = indexed.find(x => norm(x.title) === q);
  if (exact) return exact.dialog;
  const prefix = indexed.filter(x => norm(x.title).startsWith(q)).sort((a,b)=>a.title.length-b.title.length)[0];
  if (prefix) return prefix.dialog;
  const incl = indexed.filter(x => norm(x.title).includes(q)).sort((a,b)=>a.title.length-b.title.length)[0];
  return incl ? incl.dialog : null;
}

/**
 * Read recent messages from a chat/channel/group by name.
 * Returns up to `limit` messages, newest first → flipped to oldest first for display.
 */
async function readMessages({ chatName, limit = 30, sinceMinutes } = {}) {
  let c = await getClient();
  const dialog = await findDialogByName(chatName);
  if (!dialog) return { error: `לא נמצא: "${chatName}"` };

  const reqLimit = Math.min(Math.max(limit, 1), 200);
  let messages;
  try {
    messages = await withTimeout('getMessages', c.getMessages(dialog.entity, { limit: reqLimit }), 30000);
  } catch (e) {
    logger.warn(`getMessages failed (${e.message}); reconnecting`);
    c = await _reconnect();
    messages = await withTimeout('getMessages[retry]', c.getMessages(dialog.entity, { limit: reqLimit }), 30000);
  }

  let msgs = messages
    .filter(m => m.message && m.message.trim().length > 0)
    .map(m => ({
      id: m.id,
      timestamp: m.date,
      body: m.message,
      sender: m.sender?.firstName || m.sender?.title || m.sender?.username || 'משתתף',
      fromMe: !!m.out,
    }));

  if (sinceMinutes && sinceMinutes > 0) {
    const sinceTs = Math.floor(Date.now() / 1000) - sinceMinutes * 60;
    msgs = msgs.filter(m => m.timestamp >= sinceTs);
  }

  msgs.sort((a, b) => a.timestamp - b.timestamp);

  return {
    chatTitle: dialog.title,
    kind: dialog.entity?.className === 'Channel' ? (dialog.entity.broadcast ? 'channel' : 'group') : 'group',
    messages: msgs,
  };
}

/**
 * Search messages by query string across one chat or all chats.
 */
async function searchMessages({ query, chatName, limit = 20 } = {}) {
  if (!query) return { error: 'חסר query' };
  const c = await getClient();
  if (chatName) {
    const dialog = await findDialogByName(chatName);
    if (!dialog) return { error: `לא נמצא: "${chatName}"` };
    const messages = await c.invoke(new Api.messages.Search({
      peer: dialog.entity,
      q: query,
      filter: new Api.InputMessagesFilterEmpty(),
      minDate: 0, maxDate: 0,
      offsetId: 0, addOffset: 0, limit: Math.min(limit, 50),
      maxId: 0, minId: 0, hash: 0n,
    }));
    return {
      chatTitle: dialog.title,
      results: (messages.messages || []).map(m => ({
        id: m.id,
        timestamp: m.date,
        body: m.message,
      })),
    };
  }
  // Global search across all dialogs (limited)
  const messages = await c.invoke(new Api.messages.SearchGlobal({
    q: query,
    filter: new Api.InputMessagesFilterEmpty(),
    minDate: 0, maxDate: 0,
    offsetRate: 0, offsetPeer: new Api.InputPeerEmpty(), offsetId: 0,
    limit: Math.min(limit, 50),
  }));
  return {
    results: (messages.messages || []).map(m => ({
      id: m.id,
      timestamp: m.date,
      body: m.message,
    })),
  };
}

async function disconnect() {
  if (_client) {
    try { await _client.disconnect(); } catch {}
    _client = null;
  }
}

module.exports = {
  isConfigured,
  statusLabel,
  getClient,
  listDialogs,
  findDialogByName,
  readMessages,
  searchMessages,
  disconnect,
};
