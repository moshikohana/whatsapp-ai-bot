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
          '--disable-gpu', '--single-process',
        ],
      },
    });

    // ── Auth flow: when the QR is emitted, swap to pairing-code instead ──
    let pairingRequested = false;
    this.client.on('qr', async () => {
      // Only request a pairing code once per QR cycle (auto-refreshes every ~20s)
      if (pairingRequested) return;
      pairingRequested = true;
      try {
        // requestPairingCode wants the phone number WITHOUT '+' or formatting
        const cleanPhone = this.phone.replace(/[^\d]/g, '');
        const code = await this.client.requestPairingCode(cleanPhone);
        this.pairingCode = code;
        this._setStatus('pairing');
        this._log('info', `pairing code issued: ${code}`);
        try { this.onPairingCode(code); } catch {}
        // Reset flag after 30s so next QR cycle re-requests
        setTimeout(() => { pairingRequested = false; }, 25000);
      } catch (e) {
        this._log('warn', 'pairing code request failed:', e.message);
        pairingRequested = false;
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

    this.client.on('message_create', (msg) => this._onMessage(msg).catch(e => this._log('error', 'msg handler crashed:', e.message)));

    try {
      await this.client.initialize();
    } catch (e) {
      this._log('error', 'client.initialize failed:', e.message);
      this._setStatus('error', { error: e.message?.substring(0, 100) });
    }
  }

  async _onMessage(msg) {
    if (!msg.fromMe) return;
    if (!this.ownerWid) return;
    if (msg.from !== msg.to) return;
    if (msg.from !== this.ownerWid) return;
    if (typeof msg.body === 'string' && msg.body.includes(BOT_MARKER)) return;

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
