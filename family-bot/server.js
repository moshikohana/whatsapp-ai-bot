'use strict';
/**
 * Family Bot — multi-tenant WhatsApp AI assistant server.
 *
 * Architecture: runs alongside the admin's personal bot (typically on a
 * different port). Each tenant is a separate WhatsApp Client with its own
 * session, config, history, and Google/Telegram tokens.
 *
 * What runs where (typical deployment on the admin's server):
 *   - Admin's personal bot: `node index.js` on port 3000 — UNTOUCHED.
 *   - This server:          `node server.js` on port 3001 — separate process.
 *
 * Endpoints:
 *   GET  /                       — admin dashboard (localhost only)
 *   POST /admin/tenants          — create a new tenant
 *   GET  /admin/tenants          — list all tenants (JSON)
 *   POST /admin/tenants/:id/restart
 *   DELETE /admin/tenants/:id
 *   GET  /admin/tenants/:id      — single tenant status
 *   GET  /admin/events           — Server-Sent Events stream (live updates)
 *
 *   GET  /onboard?phone=...      — public onboarding page (sent to family via link)
 *   GET  /oauth/start/:id        — start Google OAuth for tenant
 *   GET  /oauth/callback         — Google OAuth redirect target
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── Selective sharing from main bot's .env ──────────────────────
// Only pull APP-LEVEL secrets (API keys, OAuth client credentials).
// NEVER pull USER-LEVEL tokens — TELEGRAM_SESSION, GOOGLE_TOKEN are
// the admin's personal sessions; if family-bot loads them, it would
// hijack the admin's connected Telegram/Google accounts.
const SAFE_TO_SHARE = new Set([
  'ANTHROPIC_API_KEY',  // Claude — billed to admin, used by everyone
  'GROQ_API_KEY',        // Voice transcription — same
  'GOOGLE_CLIENT_ID',   // OAuth app — same app, each user authorizes their own
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CREDENTIALS',  // alternative source for client id/secret
  'TELEGRAM_API_ID',     // Telegram APP creds — same app, each user gets own session
  'TELEGRAM_API_HASH',
]);
const mainEnv = path.join(__dirname, '..', '.env');
if (require('fs').existsSync(mainEnv)) {
  // Parse without applying — we'll selectively pick safe keys only.
  const parsed = require('dotenv').parse(require('fs').readFileSync(mainEnv));
  for (const k of Object.keys(parsed)) {
    if (SAFE_TO_SHARE.has(k) && !process.env[k]) {
      process.env[k] = parsed[k];
    }
  }
}

const express = require('express');
const { TenantManager } = require('./src/tenant-manager');
const googleOAuth = require('./src/helpers/google-oauth');

const PORT = parseInt(process.env.FAMILY_BOT_PORT || '3001', 10);
const ADMIN_TOKEN = process.env.FAMILY_BOT_ADMIN_TOKEN || null;

// ── Resolve public host ─────────────────────────────────────
// Priority: explicit env > auto-detected public IP > localhost fallback
// (Public IP needed for OAuth callback URL — Google rejects localhost from
// users who aren't on the same machine.)
let PUBLIC_HOST = process.env.FAMILY_BOT_PUBLIC_HOST || '';
if (!PUBLIC_HOST) {
  try {
    const nets = require('os').networkInterfaces();
    let pubIp = null;
    let privIp = null;
    for (const ifname of Object.keys(nets)) {
      for (const net of nets[ifname]) {
        if (net.family !== 'IPv4' || net.internal) continue;
        const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(net.address);
        if (!isPrivate && !pubIp) pubIp = net.address;
        else if (isPrivate && !privIp) privIp = net.address;
      }
    }
    const ip = pubIp || privIp;
    PUBLIC_HOST = ip ? `http://${ip}:${PORT}` : `http://localhost:${PORT}`;
  } catch {
    PUBLIC_HOST = `http://localhost:${PORT}`;
  }
}
// Re-export so child modules (first-run, google-oauth) see the resolved host
process.env.FAMILY_BOT_PUBLIC_HOST = PUBLIC_HOST;

const manager = new TenantManager();
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'src', 'web')));

// ── Admin-only guard: allow only localhost (or a token if set) ─────
function requireAdmin(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.endsWith('127.0.0.1');
  if (isLocal) return next();
  // If admin token configured, allow with token (for Cloudflare-tunneled access)
  if (ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN) return next();
  if (ADMIN_TOKEN && req.query.token === ADMIN_TOKEN) return next();
  return res.status(403).send('Forbidden — admin only');
}

// ── Routes: Admin dashboard (localhost only) ────────────────────
app.get('/', requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'web', 'admin.html'));
});

app.get('/admin/tenants', requireAdmin, (_req, res) => {
  res.json({ tenants: manager.listTenants(), publicHost: PUBLIC_HOST });
});

app.get('/admin/tenants/:id', requireAdmin, (req, res) => {
  const t = manager.getTenant(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t.toJSON());
});

// Read this tenant's daily log file (last N lines) for live debugging.
app.get('/admin/tenants/:id/logs', requireAdmin, (req, res) => {
  const t = manager.getTenant(req.params.id);
  if (!t) return res.status(404).send('Tenant not found');
  try {
    const fs = require('fs');
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(__dirname, 'logs', `${t.id}-${today}.log`);
    if (!fs.existsSync(file)) return res.type('text/plain; charset=utf-8').send('(no log file yet for today)');
    const lines = parseInt(req.query.lines || '100', 10);
    const data = fs.readFileSync(file, 'utf8').split('\n');
    res.type('text/plain; charset=utf-8').send(data.slice(-lines).join('\n'));
  } catch (e) {
    res.status(500).send('Log read failed: ' + e.message);
  }
});

app.post('/admin/tenants', requireAdmin, async (req, res) => {
  try {
    const { phone, botName, firstName, userGender } = req.body || {};
    const t = await manager.addTenant({
      phone,
      config: { botName, firstName, userGender },
    });
    res.json({ ok: true, tenant: t.toJSON() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/admin/tenants/:id', requireAdmin, (req, res) => {
  const r = manager.updateConfig(req.params.id, req.body || {});
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

app.post('/admin/tenants/:id/restart', requireAdmin, async (req, res) => {
  const ok = await manager.restartTenant(req.params.id);
  res.json({ ok });
});

app.delete('/admin/tenants/:id', requireAdmin, async (req, res) => {
  const ok = await manager.deleteTenant(req.params.id);
  res.json({ ok });
});

// Server-Sent Events for live admin updates
app.get('/admin/events', requireAdmin, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  send({ type: 'snapshot', tenants: manager.listTenants() });
  const unsub = manager.onEvent(send);
  req.on('close', () => unsub());
});

// ── Routes: Public onboarding (for family) ───────────────────────
app.get('/onboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'web', 'onboard.html'));
});

app.get('/onboard/status/:id', (req, res) => {
  const t = manager.getTenant(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json({ status: t.status, pairingCode: t.pairingCode, error: t.lastError });
});

// /onboard/signup — public signup form posts here. Anyone can register
// their phone; the admin then sees the pairing code in the dashboard.
app.post('/onboard/signup', async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).send('חסר מספר טלפון');
    const t = await manager.addTenant({ phone, config: {} });
    res.json({ ok: true, id: t.id });
  } catch (e) {
    res.status(400).send(e.message);
  }
});

// ── Routes: Google OAuth ─────────────────────────────────────────
app.get('/oauth/start/:id', (req, res) => {
  const t = manager.getTenant(req.params.id);
  if (!t) return res.status(404).send('Tenant not found');
  try {
    const url = googleOAuth.startAuthUrl(req.params.id);
    res.redirect(url);
  } catch (e) {
    res.status(500).send('OAuth not configured: ' + e.message);
  }
});

app.get('/oauth/callback', async (req, res) => {
  try {
    const result = await googleOAuth.handleCallback(req.query, manager);
    res.set('Content-Type', 'text/html; charset=utf-8').send(googleOAuth.successPage(result.email));
  } catch (e) {
    res.status(500).set('Content-Type', 'text/html; charset=utf-8').send(googleOAuth.errorPage(e.message));
  }
});

// ── Boot ─────────────────────────────────────────────────────────
(async () => {
  console.log('🤖 Family Bot starting...');
  try {
    await manager.bootstrap();
  } catch (e) {
    console.error('bootstrap error:', e.message);
  }
  app.listen(PORT, () => {
    console.log(`✅ Family Bot listening on http://localhost:${PORT}`);
    console.log(`   Admin (localhost only): http://localhost:${PORT}/`);
    console.log(`   Public host (for OAuth): ${PUBLIC_HOST}`);
  });
})();

// ── Graceful shutdown ────────────────────────────────────────────
async function shutdown() {
  console.log('shutdown requested');
  await manager.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
