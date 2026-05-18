'use strict';
/**
 * Scan presets — named collections of sources the user has chosen to scan
 * together. Per-tenant: each user has their own scan-presets.json under
 * their data dir.
 *
 * File: data/tenants/{phone}/scan-presets.json
 * Schema:
 *   { presets: [{ id, name, createdAt, sources: [...] }] }
 *
 * `sources` items shape:
 *   { id, label, source: 'wa'|'tg', type: 'group'|'channel', raw }
 */

const fs = require('fs');
const path = require('path');

function _file(dataDir) {
  return path.join(dataDir, 'scan-presets.json');
}

function _read(dataDir) {
  try {
    const f = _file(dataDir);
    if (!fs.existsSync(f)) return { presets: [] };
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!raw || !Array.isArray(raw.presets)) return { presets: [] };
    return raw;
  } catch { return { presets: [] }; }
}

function _write(dataDir, data) {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(_file(dataDir), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('scan-presets write failed:', e.message);
  }
}

function _slugify(name) {
  const base = (name || 'preset').toLowerCase().replace(/[^\w֐-׿]/g, '').substring(0, 30);
  return `${base}_${Date.now().toString(36)}`;
}

// Dynamic preset reflecting current tracked-groups file (per-tenant).
function _dynamicDailyPreset(dataDir) {
  try {
    const f = path.join(dataDir, 'daily.json');
    if (!fs.existsSync(f)) return null;
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    const gs = Array.isArray(arr) ? arr.find(t => t.action === 'group_summary') : null;
    const count = (gs?.params?.groups || []).filter(Boolean).length;
    if (count === 0) return null;
    return {
      id: '__daily_json__',
      name: '📋 רשימת המעקב היומי שלי',
      isDynamic: true,
      sourceCount: count,
      createdAt: null,
      sources: [],
    };
  } catch { return null; }
}

function list(dataDir) {
  const stored = _read(dataDir).presets;
  const dyn = _dynamicDailyPreset(dataDir);
  return dyn ? [dyn, ...stored] : stored;
}

function getById(dataDir, id) {
  if (id === '__daily_json__') return _dynamicDailyPreset(dataDir);
  return _read(dataDir).presets.find(p => p.id === id) || null;
}

function getByName(dataDir, name) {
  if (!name) return null;
  const norm = s => (s || '').trim().toLowerCase();
  return _read(dataDir).presets.find(p => norm(p.name) === norm(name)) || null;
}

function save(dataDir, name, sources) {
  if (!name || !name.trim()) throw new Error('שם פריסט ריק');
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('אין מקורות לשמירה');
  const data = _read(dataDir);
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
  _write(dataDir, data);
  return existing || data.presets[data.presets.length - 1];
}

function remove(dataDir, idOrName) {
  if (!idOrName) return false;
  const data = _read(dataDir);
  const norm = s => (s || '').trim().toLowerCase();
  const before = data.presets.length;
  data.presets = data.presets.filter(p => p.id !== idOrName && norm(p.name) !== norm(idOrName));
  if (data.presets.length === before) return false;
  _write(dataDir, data);
  return true;
}

function rename(dataDir, oldName, newName) {
  if (!oldName || !newName) throw new Error('שם ישן או חדש חסר');
  const data = _read(dataDir);
  const norm = s => (s || '').trim().toLowerCase();
  const p = data.presets.find(p => norm(p.name) === norm(oldName));
  if (!p) return false;
  p.name = newName.trim();
  p.updatedAt = new Date().toISOString();
  _write(dataDir, data);
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
