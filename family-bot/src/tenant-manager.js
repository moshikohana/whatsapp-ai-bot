'use strict';
/**
 * TenantManager — orchestrates all family bots in one place.
 *
 * Persists the tenant registry to data/tenants.json so we can resume
 * sessions on restart. On boot, every tenant whose session dir exists is
 * auto-started (no pairing needed — wwebjs picks up the saved session).
 */

const fs = require('fs');
const path = require('path');

const Tenant = require('./tenant');

const REGISTRY_FILE = path.join(__dirname, '..', 'data', 'tenants.json');

function sanitizePhone(input) {
  // E.164: '+' + digits. We accept "+972...", "972...", "0524243250"
  let p = (input || '').replace(/[\s\-\(\)]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) p = p.substring(1);
  if (p.startsWith('00')) p = p.substring(2);
  if (p.startsWith('0')) p = '972' + p.substring(1); // assume Israel for leading 0
  if (!/^\d{9,15}$/.test(p)) return null;
  return p;
}

class TenantManager {
  constructor() {
    /** @type {Map<string, Tenant>} keyed by tenant id (sanitized phone) */
    this.tenants = new Map();
    /** lifecycle event subscribers (for SSE/polling on admin page) */
    this.listeners = new Set();
  }

  _emit(event) {
    for (const cb of this.listeners) {
      try { cb(event); } catch {}
    }
  }

  /** Read the persistent registry from disk. */
  _readRegistry() {
    try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); }
    catch { return { tenants: [] }; }
  }
  /** Save the current tenants to disk. */
  _saveRegistry() {
    const out = {
      tenants: [...this.tenants.values()].map(t => ({
        id: t.id, phone: t.phone, config: t.config,
      })),
    };
    try {
      const dir = path.dirname(REGISTRY_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(out, null, 2), 'utf8');
    } catch (e) { console.error('registry save failed:', e.message); }
  }

  /** Bootstrap: load registry and start every tenant that has a saved session. */
  async bootstrap() {
    const reg = this._readRegistry();
    for (const entry of reg.tenants || []) {
      try {
        const t = this._createTenant(entry);
        this.tenants.set(t.id, t);
        await t.start();
      } catch (e) {
        console.error(`bootstrap failed for ${entry.phone}:`, e.message);
      }
    }
  }

  _createTenant(entry) {
    return new Tenant({
      id: entry.id,
      phone: entry.phone,
      config: entry.config || {},
      onStatus: (status, extra) => {
        this._emit({ type: 'status', id: entry.id, status, ...(extra || {}) });
      },
      onPairingCode: (code) => {
        this._emit({ type: 'pairing-code', id: entry.id, code });
      },
    });
  }

  /**
   * Add a new tenant.
   * If they already exist — returns existing (idempotent).
   * Starts their WhatsApp client; admin/UI will poll for the pairing code.
   */
  async addTenant({ phone, config = {} }) {
    const id = sanitizePhone(phone);
    if (!id) throw new Error('Invalid phone number');
    const normalizedPhone = '+' + id;

    let t = this.tenants.get(id);
    if (t) {
      // If existing tenant — just (re)start the auth flow
      if (t.status !== 'ready' && t.status !== 'starting' && t.status !== 'pairing') {
        await t.start();
      }
      return t;
    }
    t = this._createTenant({ id, phone: normalizedPhone, config });
    this.tenants.set(id, t);
    this._saveRegistry();
    await t.start();
    return t;
  }

  /** Get tenant by id (sanitized phone) */
  getTenant(id) {
    return this.tenants.get(id);
  }

  /** List all tenants — admin view */
  listTenants() {
    return [...this.tenants.values()].map(t => t.toJSON());
  }

  /** Update tenant config (botName, gender, etc.) and persist */
  updateConfig(id, patch) {
    const t = this.tenants.get(id);
    if (!t) return null;
    t.saveConfig(patch);
    this._saveRegistry();
    return t.toJSON();
  }

  /** Stop + remove tenant. Deletes session dir + data dir. */
  async deleteTenant(id) {
    const t = this.tenants.get(id);
    if (!t) return false;
    try { await t.stop(); } catch {}
    // Delete session + data dirs
    const fs = require('fs');
    try { fs.rmSync(t.sessionDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(t.dataDir, { recursive: true, force: true }); } catch {}
    this.tenants.delete(id);
    this._saveRegistry();
    return true;
  }

  /** Restart a tenant (e.g. if its session glitched) */
  async restartTenant(id) {
    const t = this.tenants.get(id);
    if (!t) return false;
    await t.stop();
    await t.start();
    return true;
  }

  /** Stop everything (called on graceful shutdown) */
  async shutdown() {
    for (const t of this.tenants.values()) {
      try { await t.stop(); } catch {}
    }
  }

  /** Subscribe to lifecycle events (status changes, pairing codes) */
  onEvent(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

module.exports = { TenantManager, sanitizePhone };
