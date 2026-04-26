'use strict';

/**
 * Navigation module — Waze links + driving ETA via OpenStreetMap.
 *
 * No API keys required:
 *   • Geocoding: Nominatim (https://nominatim.openstreetmap.org)
 *   • Routing:   OSRM public demo (https://router.project-osrm.org)
 *
 * ETA is free-flow (no real-time traffic). For live traffic, user taps
 * the Waze link in WhatsApp on their phone → Waze app opens with the
 * destination pre-filled and starts navigating automatically (navigate=yes).
 *
 * Design note: the bot never opens anything on its own machine. It only
 * sends links through WhatsApp to the user's phone. When the user taps
 * the link on mobile, iOS/Android resolves the waze.com universal link
 * into the Waze app (or Google Maps deep link into the Maps app).
 */

const fs = require('fs');
const path = require('path');

const LOCATION_FILE = path.join(__dirname, '..', 'data', 'user-location.json');
const DEFAULT_HOME = 'תל אביב';
const USER_AGENT = 'WhatsAppBot-Moshiko/1.0 (personal assistant)';

// ── Home / default-from location helpers ────────────────────────────────
function loadUserLocation() {
  try {
    return JSON.parse(fs.readFileSync(LOCATION_FILE, 'utf8'));
  } catch {
    return { home: DEFAULT_HOME, updatedAt: null };
  }
}

function saveUserLocation(obj) {
  try {
    fs.writeFileSync(LOCATION_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    // swallow — non-critical
  }
}

function getHome() {
  return loadUserLocation().home || DEFAULT_HOME;
}

function setHome(addr) {
  const trimmed = String(addr || '').trim();
  if (!trimmed) throw new Error('כתובת ריקה');
  const state = loadUserLocation();
  state.home = trimmed;
  state.updatedAt = new Date().toISOString();
  saveUserLocation(state);
  return `✅ כתובת הבית עודכנה ל: *${trimmed}*`;
}

// ── Waze deep link ──────────────────────────────────────────────────────
function buildWazeLink(destination, { navigate = true } = {}) {
  const q = encodeURIComponent(String(destination).trim());
  const nav = navigate ? '&navigate=yes' : '';
  // Universal link — works on iOS, Android, desktop (opens app if installed, else web).
  return `https://waze.com/ul?q=${q}${nav}`;
}

function buildGoogleMapsLink(destination, origin = null) {
  const base = 'https://www.google.com/maps/dir/?api=1';
  const dest = `destination=${encodeURIComponent(destination)}`;
  const org = origin ? `&origin=${encodeURIComponent(origin)}` : '';
  return `${base}&${dest}${org}&travelmode=driving`;
}

// ── HTTP with timeout ───────────────────────────────────────────────────
async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'he,en;q=0.7' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ── Geocode via Nominatim ───────────────────────────────────────────────
// Israel bias: `countrycodes=il` restricts to Israel unless user writes full country.
async function geocode(place) {
  const q = String(place).trim();
  if (!q) throw new Error('כתובת ריקה');
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=il&accept-language=he`;
  const arr = await fetchJson(url);
  if (!Array.isArray(arr) || arr.length === 0) {
    // Retry without country restriction (for international destinations)
    const arr2 = await fetchJson(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&accept-language=he`);
    if (!Array.isArray(arr2) || arr2.length === 0) {
      throw new Error(`לא נמצאה כתובת: ${q}`);
    }
    const h = arr2[0];
    return { lat: parseFloat(h.lat), lon: parseFloat(h.lon), displayName: h.display_name };
  }
  const h = arr[0];
  return { lat: parseFloat(h.lat), lon: parseFloat(h.lon), displayName: h.display_name };
}

// ── Route (driving) via OSRM public demo ────────────────────────────────
async function route(fromCoords, toCoords) {
  const { lon: lon1, lat: lat1 } = fromCoords;
  const { lon: lon2, lat: lat2 } = toCoords;
  const url = `https://router.project-osrm.org/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=false&alternatives=false`;
  const data = await fetchJson(url, 10000);
  const r = data?.routes?.[0];
  if (!r) throw new Error('לא נמצא מסלול');
  return {
    seconds: Math.round(r.duration),    // free-flow driving seconds
    meters: Math.round(r.distance),     // distance in meters
  };
}

// ── Format helpers ──────────────────────────────────────────────────────
function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m} דקות`;
  if (m === 0) return `${h} שעות`;
  return `${h}:${String(m).padStart(2, '0')} שעות`;
}

function fmtDistance(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return '—';
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} ק"מ` : `${Math.round(km)} ק"מ`;
}

// ── Main actions ────────────────────────────────────────────────────────

/**
 * Waze link to destination — fast, no API calls. The bot sends this to the
 * user's WhatsApp chat; tapping the link on mobile opens the Waze app with
 * the destination loaded and `navigate=yes` (auto-start navigation).
 * Good for "בוא נסע ל...".
 */
function wazeLinkOnly(destination) {
  const dest = String(destination || '').trim();
  if (!dest) throw new Error('יעד ריק');
  const wazeUrl = buildWazeLink(dest);
  return [
    `🚗 *Waze — ${dest}*`,
    ``,
    `📍 ${wazeUrl}`,
    ``,
    `_הקש על הקישור — Waze נפתח ומתחיל ניווט מיד_`,
  ].join('\n');
}

/**
 * ETA + distance + Waze link. Uses OSRM (free-flow, no live traffic).
 * Good for "כמה זמן לוקח לי עד X".
 */
async function eta(destination, { from = null } = {}) {
  const origin = (from || getHome()).trim();
  const dest = String(destination).trim();
  if (!dest) throw new Error('יעד לא הוגדר');

  // Geocode both in parallel, then route
  const [o, d] = await Promise.all([geocode(origin), geocode(dest)]);
  const r = await route(o, d);

  const wazeUrl = buildWazeLink(destination);
  const gmapsUrl = buildGoogleMapsLink(destination, origin);

  const lines = [
    `🚗 *${origin} → ${dest}*`,
    ``,
    `⏱ *~${fmtDuration(r.seconds)}*`,
    `🛣 ${fmtDistance(r.meters)}`,
    ``,
    `💡 _זמן בתנועה חופשית. לעדכון עם פקקים — פתח Waze:_`,
    `📍 ${wazeUrl}`,
  ];
  if (!from) {
    lines.push('');
    lines.push(`_יוצא מ: "${origin}". לשנות: "קבע את הבית שלי ב-[כתובת]"_`);
  }
  return lines.join('\n');
}

/**
 * Google Maps link for the user's phone. When tapped on mobile, the OS
 * resolves it to the Google Maps app with directions pre-loaded from
 * origin → destination (or just destination if origin omitted).
 */
function mapsLinkOnly(destination, origin = null) {
  const dest = String(destination || '').trim();
  if (!dest) throw new Error('יעד ריק');
  const url = buildGoogleMapsLink(dest, origin);
  const lines = [
    `🗺️ *Google Maps — ${dest}*`,
    ``,
    `📍 ${url}`,
    ``,
    `_הקש על הקישור — נפתח ישר ב-Google Maps עם הניווט_`,
  ];
  if (origin) lines.splice(1, 0, `📍 יציאה: ${origin}`);
  return lines.join('\n');
}

module.exports = {
  // High-level actions (used by the tool handler)
  wazeLinkOnly,
  mapsLinkOnly,
  eta,
  setHome,
  getHome,

  // Lower-level (exposed for testing)
  buildWazeLink,
  buildGoogleMapsLink,
  geocode,
  route,
  fmtDuration,
  fmtDistance,
};
