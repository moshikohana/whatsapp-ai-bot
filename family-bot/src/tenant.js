'use strict';
/**
 * Tenant — one family member's bot instance.
 *
 * Each tenant owns:
 *   - 1 whatsapp-web.js Client (linked to THEIR WhatsApp account)
 *   - Their own .wwebjs_auth/family-tenants/{phone}/ session dir
 *   - Their own data/tenants/{phone}/ for history, memory, reminders, google-token
 *   - Their own config (botName, userGender, firstName)
 *
 * No state is shared between tenants. They run as separate Client instances
 * in the SAME Node process (cheaper than separate Node processes — Puppeteer
 * pages share a single Chromium browser pool when possible).
 */

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');

const claude = require('./claude');
const firstRun = require('./first-run');
const remindersTool = require('./tools/reminders');
const scanFlow = require('./scan-flow');
const scanPresets = require('./scan-presets');
const waTool = require('./tools/whatsapp');  // for helpers

const ROOT = path.join(__dirname, '..');
const SESSIONS_ROOT = path.join(ROOT, '.wwebjs_auth', 'family-tenants');
const DATA_ROOT = path.join(ROOT, 'data', 'tenants');
const LOGS_DIR = path.join(ROOT, 'logs');

if (!fs.existsSync(SESSIONS_ROOT)) fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const BOT_MARKER = '​​​';  // zero-width chars — used to detect our own echoes

class Tenant {
  /**
   * @param {object} opts
   * @param {string} opts.id            - sanitized phone (e.g. "972524243250")
   * @param {string} opts.phone         - normalized phone in E.164 (e.g. "+972524243250")
   * @param {object} opts.config        - { botName, userGender, firstName, googleConnected? }
   * @param {Function} opts.onStatus    - (status, extra) => {} — for admin page
   * @param {Function} opts.onPairingCode - (code: string) => {} — when WA emits one
   */
  constructor({ id, phone, config = {}, onStatus = () => {}, onPairingCode = () => {} }) {
    this.id = id;
    this.phone = phone;
    this.config = config;
    this.onStatus = onStatus;
    this.onPairingCode = onPairingCode;

    this.status = 'idle';        // idle | starting | pairing | authenticated | ready | error
    this.lastError = null;
    this.ownerWid = null;
    this.client = null;
    this.history = [];
    this.pairingCode = null;     // last issued pairing code (8 chars)

    this.dataDir = path.join(DATA_ROOT, this.id);
    this.sessionDir = path.join(SESSIONS_ROOT, this.id);
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
    this.historyFile = path.join(this.dataDir, 'history.json');
    this.configFile = path.join(this.dataDir, 'config.json');

    this._loadHistory();
  }

  _setStatus(status, extra) {
    this.status = status;
    this.lastError = extra?.error || null;
    try { this.onStatus(status, extra); } catch {}
  }

  _loadHistory() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      this.history = Array.isArray(raw) ? raw : [];
    } catch { this.history = []; }
  }
  _saveHistory() {
    try {
      if (this.history.length > 40) this.history = this.history.slice(-40);
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2), 'utf8');
    } catch (e) { this._log('warn', 'history save failed:', e.message); }
  }

  /** Persist tenant config (botName, gender, etc.). */
  saveConfig(patch) {
    this.config = { ...this.config, ...patch };
    try {
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (e) { this._log('warn', 'config save failed:', e.message); }
    return this.config;
  }
  loadConfig() {
    try {
      const c = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      this.config = { ...this.config, ...c };
    } catch {}
    return this.config;
  }

  _log(level, ...args) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] [${this.id}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
    process.stdout.write(line);
    try {
      const f = path.join(LOGS_DIR, `${this.id}-${ts.slice(0, 10)}.log`);
      fs.appendFileSync(f, line);
    } catch {}
  }

  /**
   * Start the WhatsApp client. If no session exists yet, the user must enter
   * a pairing code in their WhatsApp app — we return that code via onPairingCode.
   */
  async start() {
    if (this.client) return;
    this._setStatus('starting');
    this._log('info', `starting tenant for ${this.phone}`);

    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'family',
        dataPath: this.sessionDir,
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-gpu',
          // NOTE: removed `--single-process` — it caused Chromium to crash
          // mid-pairing on memory-constrained servers (auth timeout / "t" error).
        ],
      },
    });

    // ── Auth flow: when the QR is emitted, swap to pairing-code instead ──
    let pairingRequested = false;
    let pairingFailures = 0;
    this.client.on('qr', async () => {
      // Only request a pairing code once per QR cycle (auto-refreshes every ~20s)
      if (pairingRequested) return;
      pairingRequested = true;

      // ── Wait 3s for the WA Web page to settle after QR appears ──
      // Without this, requestPairingCode races with the page still
      // rendering, causing "Target closed" / Execution context destroyed.
      await new Promise(r => setTimeout(r, 3000));

      // Bail if client died during the wait
      if (!this.client || this.status === 'idle') {
        this._log('warn', 'pairing aborted — client closed during wait');
        return;
      }

      try {
        // requestPairingCode wants the phone number WITHOUT '+' or formatting
        const cleanPhone = this.phone.replace(/[^\d]/g, '');
        const code = await this.client.requestPairingCode(cleanPhone);
        this.pairingCode = code;
        this._setStatus('pairing');
        this._log('info', `pairing code issued: ${code}`);
        try { this.onPairingCode(code); } catch {}
        pairingFailures = 0;
        // Reset flag after 60s so next QR cycle re-requests
        setTimeout(() => { pairingRequested = false; }, 55000);
      } catch (e) {
        pairingFailures++;
        const errInfo = [
          e.message, e.name, e.code, e.stack?.split('\n')[0],
        ].filter(Boolean).join(' | ');
        this._log('warn', `pairing code request failed (attempt ${pairingFailures}):`, errInfo);

        // After 5 consecutive failures, STOP retrying — the number is
        // likely rate-limited by WhatsApp. Tell admin to wait + try later.
        if (pairingFailures >= 5) {
          this._log('error', 'too many pairing failures — stopping retries (likely WA rate-limit on phone)');
          this._setStatus('error', { error: 'WhatsApp חוסם ניסיונות (rate-limit). חכה 30-60 דק׳ ונסה שוב.' });
          try { await this.client.destroy(); } catch {}
          this.client = null;
          return;
        }
        // Otherwise, allow next QR cycle to try
        setTimeout(() => { pairingRequested = false; }, 5000);
      }
    });

    this.client.on('authenticated', () => {
      this._setStatus('authenticated');
      this._log('info', 'authenticated');
    });

    this.client.on('ready', async () => {
      this.ownerWid = this.client.info?.wid?._serialized || null;
      this._setStatus('ready');
      this._log('info', `ready! owner: ${this.ownerWid}`);

      // First-time welcome (only once per tenant)
      const cfg = this.loadConfig();
      if (cfg && !cfg.firstWelcomeSent && this.ownerWid) {
        try {
          const chat = await this.client.getChatById(this.ownerWid);
          await this.send(chat, firstRun.welcomeMessage(cfg));
          this.saveConfig({ firstWelcomeSent: true });
        } catch (e) { this._log('warn', 'welcome send failed:', e.message); }
      }
    });

    this.client.on('auth_failure', (m) => {
      this._log('error', 'auth_failure:', m);
      this._setStatus('error', { error: 'אימות נכשל. צריך לקשר מחדש (קוד חדש).' });
    });

    this.client.on('disconnected', (reason) => {
      this._log('warn', 'disconnected:', reason);
      this._setStatus('error', { error: 'נותק: ' + reason });
    });

    // ── Message-id dedup — prevents wwebjs reconnect replay loops ──
    this._processedMsgIds = new Set();
    this._processedOrder = [];
    this.client.on('message_create', (msg) => this._onMessage(msg).catch(e => this._log('error', 'msg handler crashed:', e.message)));
    this.client.on('vote_update', (vote) => this._onVote(vote).catch(e => this._log('error', 'vote handler crashed:', e.message)));

    try {
      await this.client.initialize();
    } catch (e) {
      this._log('error', 'client.initialize failed:', e.message);
      this._setStatus('error', { error: e.message?.substring(0, 100) });
    }
  }

  // ── Dedup helper: stop wwebjs reconnect replay loops ───────────
  _seenAndMark(msgIdSerialized) {
    if (!msgIdSerialized) return false;
    if (this._processedMsgIds.has(msgIdSerialized)) return true;
    this._processedMsgIds.add(msgIdSerialized);
    this._processedOrder.push(msgIdSerialized);
    if (this._processedOrder.length > 2000) {
      const evicted = this._processedOrder.shift();
      this._processedMsgIds.delete(evicted);
    }
    return false;
  }

  async _onMessage(msg) {
    // Self-DM filter: only messages this tenant sent to themselves.
    // We accept ANY `fromMe===true && from===to` — this catches both legacy
    // (@c.us=@c.us) and modern (@lid=@lid) WhatsApp ID formats without
    // needing strict ownerWid match (some sessions never populate client.info).
    if (!msg.fromMe) return;
    if (!msg.from || msg.from !== msg.to) return;
    if (typeof msg.body === 'string' && msg.body.includes(BOT_MARKER)) return;

    // Capture ownerWid lazily if we haven't seen it yet — useful for reminders
    // module and Google OAuth flow which need to message the user.
    if (!this.ownerWid) {
      this.ownerWid = msg.from;
      this._log('info', `lazy ownerWid captured: ${this.ownerWid}`);
    }

    // Dedup
    const _msgId = msg.id?._serialized || '';
    if (this._seenAndMark(_msgId)) return;

    // ── Voice / audio ──
    if (msg.type === 'ptt' || msg.type === 'audio') {
      const chat = await msg.getChat();
      await chat.sendStateTyping().catch(() => {});
      try {
        const media = await msg.downloadMedia();
        if (!media) { await this.send(chat, '❌ לא הצלחתי להוריד את ההקלטה.'); return; }
        const transcript = await transcribeAudio(media);
        if (!transcript) { await this.send(chat, '⚠️ התמלול ריק.'); return; }
        await this.send(chat, `🎤 *תמלול:*\n_${transcript}_`);
        const reply = await claude.chat(`[הקלטה]: ${transcript}`, this.history, {
          client: this.client, chat, ownerChat: chat, tenant: this,
        });
        if (reply) {
          this.history.push({ role: 'user', content: `[הקלטה]: ${transcript}` });
          this.history.push({ role: 'assistant', content: reply });
          this._saveHistory();
          await this.send(chat, reply);
        }
      } catch (e) {
        this._log('error', 'voice handler:', e.message);
        const chat = await msg.getChat();
        await this.send(chat, '❌ שגיאה בתמלול: ' + e.message?.substring(0, 80));
      }
      return;
    }

    const text = (msg.body || '').trim();
    if (!text) return;
    if (text.length > 2000) {
      const chat = await msg.getChat();
      await this.send(chat, '⚠️ ההודעה ארוכה מדי.');
      return;
    }

    this._log('info', `received: ${text.substring(0, 80)}`);
    const chat = await msg.getChat();
    await chat.sendStateTyping().catch(() => {});

    // Progressive "still working" ticks
    const slowTicks = [
      { at: 5000, msg: '⏳ שנייה, עובד על זה...' },
      { at: 30000, msg: '🔧 עדיין כאן — אוסף מידע' },
      { at: 60000, msg: '⚙️ עוד עובד — סיכום ארוך לוקח זמן' },
    ];
    const timers = slowTicks.map(({ at, msg: m }) =>
      setTimeout(() => { this.send(chat, m).catch(() => {}); }, at)
    );
    const keepalive = setInterval(() => chat.sendStateTyping().catch(() => {}), 20000);

    // ── Pending preset-save text reply (after a scan finished) ──
    if (this._pendingPresetSave && this._pendingPresetSave.expiresAt > Date.now()) {
      const handled = await this._handlePendingPresetSave(text, chat);
      if (handled) { timers.forEach(clearTimeout); clearInterval(keepalive); return; }
    }

    // ── Scan disambiguation menu — open on bare "סריקה" / "סקירה" / ambiguous ──
    if (scanFlow.shouldShowMenu(text) && !scanFlow.getFlow(this.ownerWid)) {
      const flow = scanFlow.startFlow(this.ownerWid);
      timers.forEach(clearTimeout);
      clearInterval(keepalive);
      await this._advanceScanFlow(flow, chat);
      return;
    }

    let reply;
    try {
      // First-run wizard intercept (in-WhatsApp setup)
      const ctx = { client: this.client, chat, ownerChat: chat, tenant: this };
      const firstRunReply = await firstRun.maybeHandle(text, ctx);
      if (firstRunReply) {
        reply = firstRunReply;
      } else {
        reply = await claude.chat(text, this.history, ctx);
      }
    } catch (e) {
      this._log('error', 'chat failed:', e.message);
      reply = '❌ אופס, משהו השתבש. נסה שוב.';
    } finally {
      timers.forEach(clearTimeout);
      clearInterval(keepalive);
    }

    if (reply) {
      this.history.push({ role: 'user', content: text });
      this.history.push({ role: 'assistant', content: reply });
      this._saveHistory();
      await this.send(chat, reply);
    }
  }

  async send(chat, text) {
    if (!text) return;
    try { await chat.sendMessage(text + BOT_MARKER); }
    catch (e) { this._log('warn', 'send failed:', e.message); }
  }

  // ══════════════════════════════════════════════════════════════════
  //   Scan-flow methods (interactive 5-step menu + execution)
  // ══════════════════════════════════════════════════════════════════

  /** Send the next poll in a flow, populating availableItems if entering 'items'. */
  async _advanceScanFlow(flow, chat) {
    const { Poll } = require('whatsapp-web.js');

    // If entering 'items' — fetch available items lazily
    if (flow.step === 'items' && (!flow.availableItems || flow.availableItems.length === 0)) {
      await this.send(chat, '⏳ אוסף רשימת מקורות זמינים...');
      flow.availableItems = await this._fetchAvailableScanItems(flow.selections.source, flow.selections.type);
      flow.itemsPage = 0;
      if (flow.availableItems.length === 0) {
        await this.send(chat, '❌ לא נמצאו מקורות מתאימים. נסה "כל המקורות" במקום.');
        scanFlow.endFlow(flow.chatId);
        return;
      }
    }

    const presetsList = scanPresets.list(this.dataDir);
    const poll = scanFlow.buildPoll(flow, { presetsList });
    if (!poll) return;
    await this.send(chat, poll.question);
    const wPoll = new Poll('בחר:', poll.options.map(o => o.label),
      { allowMultipleAnswers: !!poll.multiple });
    const sentMsg = await chat.sendMessage(wPoll);
    scanFlow.updateFlow(flow.chatId, {
      activePollId: sentMsg?.id?._serialized || null,
      lastPollOptions: poll.options,
    });
  }

  /** Handle a vote event — dispatch to scan-flow if matching active flow. */
  async _onVote(vote) {
    try {
      const parentId = vote.parentMessage?.id?._serialized;
      if (!parentId) return;
      // Only own votes
      if (vote.voter && vote.voter !== this.ownerWid && !vote.voter.includes(this.id)) return;
      const f = [...scanFlow.flows.values()].find(fl => fl.activePollId === parentId);
      if (!f) return;

      // Resolve label/localId → option ID (handles multi-select navigation)
      const allSelected = vote.selectedOptions || [];
      const resolveOne = (so) => {
        if (!so) return null;
        const localId = so.localId;
        if (f.lastPollOptions && typeof localId === 'number' && f.lastPollOptions[localId]) {
          return f.lastPollOptions[localId].id;
        }
        const stripCheck = (s) => String(s || '').replace(/^✔️\s+/, '').replace(/^⭐\s+/, '');
        const found = (f.lastPollOptions || []).find(o => stripCheck(o.label) === stripCheck(so.name));
        if (found) return found.id;
        return so.name || so.localId;
      };
      const resolvedAll = allSelected.map(resolveOne).filter(Boolean);
      const NAV_IDS = ['__next_page__', '__finish__', 'cancel', '__back__'];
      const nav = resolvedAll.find(id => NAV_IDS.includes(id));
      const resolvedSelected = nav || resolvedAll[resolvedAll.length - 1] || vote.selectedOptions?.[0]?.name;

      const presetsList = scanPresets.list(this.dataDir);
      const result = scanFlow.applyVote(f, resolvedSelected, { presetsList });
      const chat = await this.client.getChatById(this.ownerWid);

      if (result.error) {
        await this.send(chat, `⚠️ ${result.error}`);
        await this._advanceScanFlow(f, chat);
        return;
      }
      if (result.cancel) {
        scanFlow.endFlow(f.chatId);
        await this.send(chat, '❌ סריקה בוטלה.');
        return;
      }
      if (result.restart) {
        scanFlow.endFlow(f.chatId);
        const fresh = scanFlow.startFlow(f.chatId);
        await this._advanceScanFlow(fresh, chat);
        return;
      }
      if (result.execute) {
        const params = result.params;
        if (f.confirmedSources) params.confirmedSources = f.confirmedSources;
        if (f.usedPresetName) params.usedPresetName = f.usedPresetName;
        scanFlow.endFlow(f.chatId);
        await this._executeScan(params, chat);
        return;
      }
      if (result.ok) { await this._advanceScanFlow(f, chat); return; }
    } catch (e) {
      this._log('error', '_onVote crashed:', e.message);
    }
  }

  /** Build the list of selectable items (WA chats/channels + TG dialogs, sorted: tracked first). */
  async _fetchAvailableScanItems(source, type) {
    const items = [];
    const wantWaGroups = (source === 'whatsapp' || source === 'both') && (type === 'groups' || type === 'both');
    const wantWaChannels = (source === 'whatsapp' || source === 'both') && (type === 'channels' || type === 'both');
    const wantTgGroups = (source === 'telegram' || source === 'both') && (type === 'groups' || type === 'both');
    const wantTgChannels = (source === 'telegram' || source === 'both') && (type === 'channels' || type === 'both');

    // Load tracked names from per-tenant daily.json
    let trackedSet = new Set();
    try {
      const dailyFile = path.join(this.dataDir, 'daily.json');
      if (fs.existsSync(dailyFile)) {
        const arr = JSON.parse(fs.readFileSync(dailyFile, 'utf8'));
        const gs = Array.isArray(arr) ? arr.find(t => t.action === 'group_summary') : null;
        for (const n of (gs?.params?.groups || [])) {
          if (n) trackedSet.add(waTool.normalizeHe(n));
        }
      }
    } catch {}
    const isTracked = (raw) => trackedSet.has(waTool.normalizeHe(raw || ''));

    // WhatsApp side
    try {
      if (wantWaGroups || wantWaChannels) {
        const chats = await this.client.getChats();
        const ACTIVITY_CUTOFF_SEC = Date.now() / 1000 - 7 * 24 * 3600;
        if (wantWaGroups) {
          for (const c of chats) {
            if (!c.isGroup) continue;
            const recent = (c.timestamp || c.lastMessage?.timestamp || 0) > ACTIVITY_CUTOFF_SEC;
            if (!isTracked(c.name) && !recent) continue;
            items.push({ id: `wa:${c.id._serialized}`, label: `💬 ${c.name || '(ללא שם)'}`, source: 'wa', type: 'group', raw: c.name });
          }
        }
        if (wantWaChannels) {
          const channels = await waTool.safeGetChannels(this.client);
          for (const c of channels) {
            items.push({ id: `wa:${c.id._serialized}`, label: `💬📢 ${c.name || '(ללא שם)'}`, source: 'wa', type: 'channel', raw: c.name });
          }
        }
      }
    } catch (e) { this._log('warn', '_fetchAvailableScanItems WA:', e.message); }

    // Telegram side (per-tenant — only if this tenant has Telegram configured)
    try {
      if ((wantTgGroups || wantTgChannels) && this.config?.telegramConnected) {
        const tgTool = require('./tools/telegram');
        const tg = await tgTool.getClient(this);
        if (tg) {
          const dialogs = await tg.getDialogs({ limit: 100 });
          for (const d of dialogs) {
            const entity = d.entity;
            let kind = 'private';
            const title = d.title || entity?.firstName || entity?.username || '';
            if (entity?.className === 'Channel') kind = entity.broadcast ? 'channel' : 'group';
            else if (entity?.className === 'Chat') kind = 'group';
            if (kind === 'group' && wantTgGroups) {
              items.push({ id: `tg:${String(d.id)}`, label: `📡 ${title}`, source: 'tg', type: 'group', raw: title });
            }
            if (kind === 'channel' && wantTgChannels) {
              items.push({ id: `tg:${String(d.id)}`, label: `📡📢 ${title}`, source: 'tg', type: 'channel', raw: title });
            }
          }
        }
      }
    } catch (e) { this._log('warn', '_fetchAvailableScanItems TG:', e.message); }

    // Mark tracked, sort: tracked first, then groups before channels, then alphabetical
    for (const it of items) it._tracked = trackedSet.has(waTool.normalizeHe(it.raw || ''));
    items.sort((a, b) => {
      if (a._tracked !== b._tracked) return a._tracked ? -1 : 1;
      if (a.type !== b.type) return a.type === 'group' ? -1 : 1;
      return (a.raw || '').localeCompare(b.raw || '', 'he');
    });
    for (const it of items) {
      if (it._tracked && !it.label.startsWith('⭐')) it.label = '⭐ ' + it.label;
    }
    return items;
  }

  /** Resolve daily.json entries (by name) to actual items, for scope=all scans. */
  async _resolveDailyScanSources(source, type) {
    let names = [];
    try {
      const f = path.join(this.dataDir, 'daily.json');
      if (fs.existsSync(f)) {
        const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
        const gs = Array.isArray(arr) ? arr.find(t => t.action === 'group_summary') : null;
        names = (gs?.params?.groups || []).filter(Boolean);
      }
    } catch {}
    if (!names.length) return [];

    const wantWa = source === 'whatsapp' || source === 'both';
    const wantTg = source === 'telegram' || source === 'both';
    const wantGroups = type === 'groups' || type === 'both';
    const wantChannels = type === 'channels' || type === 'both';
    const resolved = [];

    if (wantWa) {
      try {
        const chats = await this.client.getChats();
        const channels = await waTool.safeGetChannels(this.client);
        const all = [...chats, ...channels];
        for (const n of names) {
          const ch = waTool.findChatByName(all, n);
          if (!ch) continue;
          const isCh = ch.isChannel === true;
          const isGr = ch.isGroup === true;
          if (isCh && wantChannels) resolved.push({ id: `wa:${ch.id._serialized}`, label: `💬📢 ${ch.name}`, source: 'wa', type: 'channel', raw: ch.name });
          else if (isGr && wantGroups) resolved.push({ id: `wa:${ch.id._serialized}`, label: `💬 ${ch.name}`, source: 'wa', type: 'group', raw: ch.name });
        }
      } catch (e) { this._log('warn', '_resolveDailyScanSources WA:', e.message); }
    }
    return resolved;
  }

  /** Run the actual scan based on confirmed params. */
  async _executeScan(params, chat) {
    const since = params.sinceMinutes || 1440;
    const windowLabel = params.timeLabel || `${since} דקות אחרונות`;
    let sources;
    if (params.scope === 'select') sources = params.selectedItems;
    else sources = await this._resolveDailyScanSources(params.source, params.type);
    if (!sources || sources.length === 0) {
      const hint = params.scope === 'select' ? '❌ לא בחרת מקורות.' : '❌ אין מקורות ברשימת המעקב היומי שלך. הוסף קבוצות לרשימה או בחר "מקורות ספציפיים".';
      await this.send(chat, hint);
      return;
    }

    await this.send(chat, `⏳ *מריץ סריקה...*\n🌐 ${sources.length} מקורות · ⏱ ${windowLabel}`);
    const allMessages = [];
    const stats = [];

    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      try {
        if (src.source === 'wa') {
          const chatId = src.id.replace(/^wa:/, '');
          let ch;
          if (src.type === 'channel' || chatId.endsWith('@newsletter')) {
            ch = { id: { _serialized: chatId }, name: src.raw, isChannel: true };
          } else {
            ch = await this.client.getChatById(chatId).catch(() => null);
            if (!ch) { stats.push({ name: src.raw, count: 0, status: 'not_found', isChannel: false, source: 'wa' }); continue; }
          }
          const msgs = await waTool.fetchMessages(ch, 150);
          const cutoff = Date.now() / 1000 - since * 60;
          const rec = msgs.filter(m => m.body && m.timestamp > cutoff);
          stats.push({ name: ch.name || src.raw, count: rec.length, status: 'ok', isChannel: src.type === 'channel', source: 'wa' });
          for (const m of rec.filter(m => m.body && m.body.trim().length > 15)) {
            allMessages.push({
              group: ch.name || src.raw,
              time: new Date(m.timestamp * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
              sender: (m._data?.notifyName || 'משתתף').substring(0, 15),
              body: (m.body || '').substring(0, 250),
              ts: m.timestamp, isChannel: src.type === 'channel', platform: 'wa',
            });
          }
        }
        // TG support — only if tenant has Telegram configured
        else if (src.source === 'tg' && this.config?.telegramConnected) {
          // TODO: per-tenant Telegram read; implementation in tools/telegram.js
        }
      } catch (e) {
        stats.push({ name: src.raw, count: 0, status: 'error', error: e.message?.substring(0, 60), isChannel: src.type === 'channel', source: src.source });
      }
      if (sources.length >= 6 && i === Math.ceil(sources.length / 2)) {
        try { await this.send(chat, `⏳ ${i + 1}/${sources.length} מקורות נסרקו...`); } catch {}
      }
    }

    allMessages.sort((a, b) => a.ts - b.ts);
    const totalM = stats.reduce((a, g) => a + g.count, 0);
    const active = stats.filter(g => g.count > 0);
    const activeGroups = active.filter(s => !s.isChannel);
    const activeChannels = active.filter(s => s.isChannel);
    const silentChannels = stats.filter(s => s.isChannel && s.count === 0 && s.status === 'ok');
    const lvl = totalM > 300 ? '🔴🔴🔴🔴 סוער' : totalM > 100 ? '🔴🔴🔴 פעיל' : totalM > 30 ? '🟡🟡 בינוני' : '🟢 שקט';
    const breakdownLines = [];
    if (activeGroups.length) breakdownLines.push(`👥 ${activeGroups.length} קבוצות פעילות`);
    if (activeChannels.length) breakdownLines.push(`📢 ${activeChannels.length} ערוצים פעילים: ${activeChannels.slice(0, 6).map(s => s.name).join(', ')}`);
    if (silentChannels.length) breakdownLines.push(`🔇 ${silentChannels.length} ערוצים שקטים`);
    const breakdown = breakdownLines.length ? '\n' + breakdownLines.join('\n') : '';
    const header = `📋 *סריקה — ${new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}*\n⏱ ${windowLabel}\n━━━━━━━━━━━━━━━━━━━━\n🌡️ ${lvl}  |  📊 ${totalM} הודעות · ${active.length}/${stats.length} מקורות${breakdown}\n━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (!allMessages.length) {
      await this.send(chat, header + `_אין הודעות בטווח (${windowLabel})_`);
      return;
    }

    const { default: Anthropic } = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const pool = allMessages.map(m => {
      const icon = m.isChannel ? '📢' : '👥';
      return `⏰${m.time} ${icon}[${m.group}] ${m.sender}: "${m.body}"`;
    }).join('\n');
    const prompt = `סכם את ההודעות הבאות בפורמט נושאים חמים (3-7 נושאים מהחם לשקט). לכל נושא — שורת כותרת ושורת מקורות+ציטוט. בלי הקדמות.\n\n${pool}`;
    try {
      const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] });
      const text = r.content.filter(b => b.type === 'text').map(b => b.text.trim()).join('\n\n');
      await this.send(chat, header + (text || '(לא נוצר סיכום)'));
    } catch (e) {
      await this.send(chat, header + '❌ הסיכום נכשל: ' + e.message?.substring(0, 80));
    }

    // Offer to save as preset (if not invoked via existing preset)
    if (!params.usedPresetName && Array.isArray(sources) && sources.length > 0) {
      this._pendingPresetSave = { sources, expiresAt: Date.now() + 5 * 60 * 1000 };
      await this.send(chat, `💾 *לשמור את הבחירה כפריסט?*\n${sources.length} מקורות נסרקו. שלח שם (לדוגמה: "ערוצי בוקר") לשמירה, או "לא".`);
    }
  }

  /** Handle a text reply during pending preset-save window. Returns true if consumed. */
  async _handlePendingPresetSave(text, chat) {
    const t = text.trim();
    const isNegative = /^(לא|לא תודה|אל תשמור|skip|no)/i.test(t);
    const looksLikeOtherCommand = /^(?:סריקה|סקירה|תפריט|בוקר טוב|מה|תעשה|תקבע|תזכיר|תחפש|סכם|שלח|תשלח)/i.test(t);
    if (isNegative) {
      this._pendingPresetSave = null;
      await this.send(chat, '👌 לא שמרתי.');
      return true;
    }
    if (!looksLikeOtherCommand && t.length >= 2 && t.length <= 200) {
      // Extract clean name from natural phrasing
      let cleanName = t;
      const quoted = t.match(/["״׳'`]([^"״׳'`]{2,40})["״׳'`]/);
      if (quoted) cleanName = quoted[1].trim();
      else {
        cleanName = cleanName
          .replace(/^(כן\s+)?(שמור|תשמור|תקרא\s+לו|בשם|שם|שמור\s+בשם|כן\s+שמור\s+כפריסט)\s*[.,:]?\s*/i, '')
          .replace(/^(תקרא\s+לו|קרא\s+לו)\s*/i, '')
          .trim();
        if (cleanName.length > 40) cleanName = cleanName.substring(0, 40);
      }
      if (!cleanName || cleanName.length < 2) cleanName = t.substring(0, 40);
      try {
        const saved = scanPresets.save(this.dataDir, cleanName, this._pendingPresetSave.sources);
        this._pendingPresetSave = null;
        await this.send(chat, `✅ *פריסט נשמר: "${saved.name}"*\n${scanPresets.summary(saved)}\n\n_בסריקה הבאה תקבל אופציה "📁 השתמש בפריסט שמור" בשלב 1._`);
        return true;
      } catch (e) {
        await this.send(chat, `❌ שמירת פריסט נכשלה: ${e.message}`);
        this._pendingPresetSave = null;
        return true;
      }
    }
    // Looks like another command — clear pending state and fall through
    this._pendingPresetSave = null;
    return false;
  }

  /** Wire up the reminders module's owner-chat (for fire callbacks). */
  async wireReminders() {
    try {
      if (!this.ownerWid) return;
      const chat = await this.client.getChatById(this.ownerWid);
      remindersTool.attachContext(this.id, { ownerChat: chat });
    } catch {}
  }

  async stop() {
    this._log('info', 'stopping');
    this._setStatus('idle');
    try { if (this.client) await this.client.destroy(); } catch {}
    this.client = null;
    this.pairingCode = null;
  }

  /** Returns a JSON-safe summary for the admin page. */
  toJSON() {
    return {
      id: this.id,
      phone: this.phone,
      status: this.status,
      error: this.lastError,
      config: this.config,
      pairingCode: this.pairingCode,
      ownerWid: this.ownerWid,
    };
  }
}

// ── Groq voice transcription (per-tenant, but uses shared API key) ──
async function transcribeAudio(media) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY חסר ב-.env');
  const audioBuffer = Buffer.from(media.data, 'base64');
  const mimetype = media.mimetype || 'audio/ogg';
  const ext = mimetype.includes('mp4') ? 'm4a' : mimetype.includes('mpeg') ? 'mp3' : mimetype.includes('wav') ? 'wav' : 'ogg';
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimetype });
  form.append('file', blob, `voice.${ext}`);
  form.append('model', 'whisper-large-v3');
  form.append('language', 'he');
  form.append('response_format', 'text');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).substring(0, 100)}`);
  return (await res.text()).trim();
}

module.exports = Tenant;
