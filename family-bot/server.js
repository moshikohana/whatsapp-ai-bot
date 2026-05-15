'use strict';
/**
 * Family Bot — multi-tenant server running on Moshiko's PC.
 *
 * What runs where:
 *   - Moshiko's existing bot: `node index.js` on port 3000 — UNTOUCHED.
 *   - This server:           `node server.js` on port 3001 — separate process.
 *
 * Endpoints:
 *   GET  /                       — Moshiko admin dashboard (localhost only)
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
// Also load from the main bot's .env if it exists — so API keys are shared
// without duplicating them.
const mainEnv = path.join(__dirname, '..', '.env');
if (require('fs').existsSync(mainEnv)) {
  require('dotenv').config({ path: mainEnv, override: false });
}

const express = require('express');
const { TenantManager } = require('./src/tenant-manager');
const googleOAuth = require('./src/helpers/google-oauth');

const PORT = parseInt(process.env.FAMILY_BOT_PORT || '3001', 10);
const ADMIN_TOKEN = process.env.FAMILY_BOT_ADMIN_TOKEN || null;
const PUBLIC_HOST = process.env.FAMILY_BOT_PUBLIC_HOST || `http://localhost:${PORT}`;

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

// ── Routes: Admin (Moshiko) ──────────────────────────────────────
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

app.post('/onboard/start', async (req, res) => {
  try {
    const { phone } = req.body || {};
    const t = await manager.addTenant({ phone, config: {} });
    res.json({ ok: true, id: t.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Routes: Google OAuth ─────────────────────────────────────────
app.get('/oauth/start/:id', (req, res) => {
  const t = manager.getTenant(req.params.id);
  if (!t) return res.status(404).send('Tenant not found');
  const url = googleOAuth.buildAuthUrl({
    tenantId: req.params.id,
    redirectUri: `${PUBLIC_HOST}/oauth/callback`,
  });
  res.redirect(url);
});

app.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code/state');
    const result = await googleOAuth.exchangeAndSave({
      code, state, redirectUri: `${PUBLIC_HOST}/oauth/callback`,
    });
    // Update tenant config
    const tenant = manager.getTenant(result.tenantId);
    if (tenant) tenant.saveConfig({ googleConnected: true, googleEmail: result.email });
    res.set('Content-Type', 'text/html; charset=utf-8').send(`
<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><title>חיבור Google הושלם</title>
<style>body{font-family:'Segoe UI',sans-serif;background:#f6f7f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;padding:40px 60px;border-radius:14px;box-shadow:0 4px 18px rgba(0,0,0,0.08);text-align:center}
.ok{font-size:64px;color:#2bb673}h1{margin:16px 0 8px}p{color:#5a6470}
</style></head>
<body><div class="card"><div class="ok">✅</div><h1>הצלחה!</h1>
<p>חיבור Google הושלם.</p><p>תוכל לסגור את הדף ולחזור ל-WhatsApp.</p></div></body></html>`);
  } catch (e) {
    res.status(500).send('שגיאה: ' + e.message);
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
