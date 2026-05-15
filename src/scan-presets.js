'use strict';
/**
 * Scan presets — named collections of sources the user has chosen to scan
 * together. Lets the user save "ערוצי בוקר" once and pick it later instead
 * of re-selecting from 50+ items every time.
 *
 * File: data/scan-presets.json
 * Schema:
 *   { presets: [{ id, name, createdAt, sources: [...] }] }
 *
 * `sources` items are the same shape as flow.confirmedSources:
 *   { id, label, source: 'wa'|'tg', type: 'group'|'channel', raw }
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'scan-presets.json');

function _read() {
  try {
    if (!fs.existsSync(FILE)) return { presets: [] };
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!raw || !Array.isArray(raw.presets)) return { presets: [] };
    return raw;
  } catch { return { presets: [] }; }
}

function _write(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('scan-presets write failed:', e.message);
  }
}

function _slugify(name) {
  // ID = stripped Hebrew/Latin chars + timestamp suffix to ensure uniqueness
  const base = (name || 'preset').toLowerCase().replace(/[^\w֐-׿]/g, '').substring(0, 30);
  return `${base}_${Date.now().toString(36)}`;
}

// Special dynamic preset — always reflects the current daily.json contents.
// Resolved at scan-execute time (not stored as a fixed list).
const DAILY_DYNAMIC_PRESET = {
  id: '__daily_json__',
  name: '📋 רשימת המעקב היומי (daily.json)',
  isDynamic: true,
  createdAt: null,
  sources: [],  // resolved on demand
};

function list() {
  const stored = _read().presets;
  // Always include the dynamic daily.json preset at the TOP — only if there
  // are tracked sources to scan (avoids surfacing it when empty).
  try {
    const path = require('path');
    const _diskTasks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'daily.json'), 'utf8'));
    const gs = (Array.isArray(_diskTasks) ? _diskTasks : []).find(t => t.action === 'group_summary');
    const trackedCount = (gs?.params?.groups || []).filter(Boolean).length;
    if (trackedCount > 0) {
      return [{ ...DAILY_DYNAMIC_PRESET, sourceCount: trackedCount }, ...stored];
    }
  } catch {}
  return stored;
}

function getById(id) {
  // Special: dynamic daily.json preset
  if (id === '__daily_json__') {
    return list().find(p => p.id === '__daily_json__') || null;
  }
  return _read().presets.find(p => p.id === id) || null;
}

function getByName(name) {
  if (!name) return null;
  const norm = s => (s || '').trim().toLowerCase();
  return _read().presets.find(p => norm(p.name) === norm(name)) || null;
}

/**
 * Save a new preset. If `name` already exists — overwrite the sources
 * (keep the existing id so any in-memory references still work).
 */
function save(name, sources) {
  if (!name || !name.trim()) throw new Error('שם פריסט ריק');
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('אין מקורות לשמירה');
  const data = _read();
  const existing = data.presets.find(p => p.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (existing) {
    existing.sources = sources;
    existing.updatedAt = new Date().toISOString();
  } else {
    data.presets.push({
      id: _slugify(name),
      name: name.trim(),
      createdAt: new Date().toISOString(),
      sources,
    });
  }
  _write(data);
  return existing || data.presets[data.presets.length - 1];
}

function remove(idOrName) {
  if (!idOrName) return false;
  const data = _read();
  const norm = s => (s || '').trim().toLowerCase();
  const before = data.presets.length;
  data.presets = data.presets.filter(p => p.id !== idOrName && norm(p.name) !== norm(idOrName));
  if (data.presets.length === before) return false;
  _write(data);
  return true;
}

function rename(oldName, newName) {
  if (!oldName || !newName) throw new Error('שם ישן או חדש חסר');
  const data = _read();
  const norm = s => (s || '').trim().toLowerCase();
  const p = data.presets.find(p => norm(p.name) === norm(oldName));
  if (!p) return false;
  p.name = newName.trim();
  p.updatedAt = new Date().toISOString();
  _write(data);
  return true;
}

function summary(preset) {
  const groups = preset.sources.filter(s => s.type === 'group').length;
  const channels = preset.sources.filter(s => s.type === 'channel').length;
  const wa = preset.sources.filter(s => s.source === 'wa').length;
  const tg = preset.sources.filter(s => s.source === 'tg').length;
  const parts = [];
  if (groups) parts.push(`👥 ${groups}`);
  if (channels) parts.push(`📢 ${channels}`);
  const platform = [];
  if (wa) platform.push(`💬 ${wa}`);
  if (tg) platform.push(`📡 ${tg}`);
  return `${preset.sources.length} מקורות (${parts.join(' · ')}) — ${platform.join(' · ')}`;
}

module.exports = { list, getById, getByName, save, remove, rename, summary };
