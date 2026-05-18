'use strict';
/**
 * Google OAuth helper — handles the per-tenant auth flow integrated with Express.
 *
 * The flow:
 *   1. Family member clicks https://<tunnel>/oauth/start/:tenantId
 *   2. We generate state, redirect to Google with state in URL
 *   3. Google redirects back to /oauth/callback?code=...&state=...
 *   4. We exchange the code for tokens, save them under the tenant's data dir
 *   5. Show a success page
 *
 * The redirect URI must be PRE-REGISTERED in Google Cloud Console.
 * Use FAMILY_BOT_PUBLIC_HOST + '/oauth/callback' (e.g. via Cloudflare Tunnel).
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   FAMILY_BOT_PUBLIC_HOST  (e.g. https://abc.trycloudflare.com)
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Pending state → tenantId map (TTL 10 min). In-memory; rebooting clears it.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function _publicHost() {
  return process.env.FAMILY_BOT_PUBLIC_HOST || `http://localhost:${process.env.FAMILY_BOT_PORT || 3001}`;
}
function _redirectUri() {
  return _publicHost().replace(/\/+$/, '') + '/oauth/callback';
}

function _clientCreds() {
  // Prefer dedicated family-bot creds; fall back to main bot's GOOGLE_CREDENTIALS
  let id = process.env.GOOGLE_CLIENT_ID || '';
  let secret = process.env.GOOGLE_CLIENT_SECRET || '';
  if (!id || !secret) {
    try {
      const main = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
      id = id || main.installed?.client_id || main.web?.client_id || '';
      secret = secret || main.installed?.client_secret || main.web?.client_secret || '';
    } catch {}
  }
  return { id, secret };
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
];

function isConfigured() {
  const { id, secret } = _clientCreds();
  return Boolean(id && secret);
}

// Periodic cleanup of expired states
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingStates.entries()) {
    if (v.expiresAt < now) pendingStates.delete(k);
  }
}, 60 * 1000).unref?.();

/** Returns a Google auth URL for `tenantId`. Mounted at GET /oauth/start/:id */
function startAuthUrl(tenantId) {
  if (!isConfigured()) throw new Error('Google OAuth credentials missing (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET)');
  const { id, secret } = _clientCreds();
  const oauth = new google.auth.OAuth2(id, secret, _redirectUri());
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { tenantId, expiresAt: Date.now() + STATE_TTL_MS });
  return oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

/**
 * Process the OAuth callback. Returns `{ tenantId, email }` on success.
 * Throws on error. Caller is responsible for redirecting / rendering.
 */
async function handleCallback(query, manager) {
  const code = query.code;
  const state = query.state;
  if (query.error) throw new Error('Google auth declined: ' + query.error);
  if (!code) throw new Error('Missing code in callback');
  if (!state) throw new Error('Missing state in callback');

  const entry = pendingStates.get(state);
  if (!entry) throw new Error('State expired or invalid — try again');
  pendingStates.delete(state);

  const tenant = manager.getTenant(entry.tenantId);
  if (!tenant) throw new Error('Tenant not found: ' + entry.tenantId);

  const { id, secret } = _clientCreds();
  const oauth = new google.auth.OAuth2(id, secret, _redirectUri());
  const { tokens } = await oauth.getToken(code);
  oauth.setCredentials(tokens);

  // Fetch user email for confirmation display
  let email = null;
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth });
    const info = await oauth2.userinfo.get();
    email = info?.data?.email || null;
  } catch {}

  // Save token under the tenant's data dir
  const tokenFile = path.join(tenant.dataDir, 'google-token.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ ...tokens, email }, null, 2), 'utf8');

  // Mark tenant as Google-connected and persist
  tenant.saveConfig({ googleConnected: true, googleEmail: email });

  return { tenantId: tenant.id, email };
}

/**
 * Reusable HTML page for the success/error result.
 */
function successPage(email) {
  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><title>חיבור Google</title>
<style>
  body { font-family:'Segoe UI','Heebo',sans-serif; background:#f6f7f9; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px; }
  .card { background:white; padding:40px 50px; border-radius:14px; box-shadow:0 4px 18px rgba(0,0,0,0.08); text-align:center; max-width:480px; }
  .ok { font-size:64px; color:#2bb673; }
  h1 { color:#1a1d20; margin:16px 0 8px; }
  p { color:#5a6470; line-height:1.6; }
</style></head>
<body><div class="card">
  <div class="ok">✅</div>
  <h1>Google מחובר!</h1>
  <p>${email ? `החשבון <strong>${email}</strong> חובר בהצלחה.` : 'החשבון חובר בהצלחה.'}</p>
  <p>תוכל לסגור את הדף הזה ולחזור ל-WhatsApp. הבוט יזכור את החיבור — לא תצטרך לעשות זאת שוב.</p>
</div></body></html>`;
}

function errorPage(message) {
  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><title>שגיאה</title>
<style>
  body { font-family:'Segoe UI','Heebo',sans-serif; background:#f6f7f9; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px; }
  .card { background:white; padding:40px 50px; border-radius:14px; box-shadow:0 4px 18px rgba(0,0,0,0.08); text-align:center; max-width:480px; }
  .err { font-size:64px; color:#e74c3c; }
  h1 { color:#1a1d20; margin:16px 0 8px; }
  p { color:#5a6470; line-height:1.6; }
</style></head>
<body><div class="card">
  <div class="err">❌</div>
  <h1>שגיאה</h1>
  <p>${String(message || '').substring(0, 200)}</p>
  <p>פנה לבעל המערכת ובקש לחבר שוב.</p>
</div></body></html>`;
}

module.exports = {
  isConfigured,
  startAuthUrl,
  handleCallback,
  successPage,
  errorPage,
};
