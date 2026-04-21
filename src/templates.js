'use strict';
const fs = require('fs');
const path = require('path');
const TEMPLATES_PATH = path.join(__dirname, '..', 'data', 'templates.json');

function load() {
  try {
    if (!fs.existsSync(TEMPLATES_PATH)) { fs.writeFileSync(TEMPLATES_PATH, '{}', 'utf8'); return {}; }
    return JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8'));
  } catch { return {}; }
}

function save(data) {
  fs.writeFileSync(TEMPLATES_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function saveTemplate(name, content) {
  const d = load();
  d[name] = { content, createdAt: new Date().toISOString(), usageCount: 0 };
  save(d);
  return `✅ תבנית "${name}" נשמרה`;
}

function getTemplate(name) {
  const d = load();
  if (!d[name]) return null;
  d[name].usageCount = (d[name].usageCount || 0) + 1;
  d[name].lastUsed = new Date().toISOString();
  save(d);
  return d[name].content;
}

function listTemplates() {
  const d = load();
  const keys = Object.keys(d);
  if (!keys.length) return '📭 אין תבניות שמורות עדיין.\n\nכדי לשמור: "שמור תבנית [שם]: [תוכן]"';
  let out = `📋 *תבניות שמורות (${keys.length}):*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const k of keys) {
    const t = d[k];
    out += `• *${k}*${t.usageCount ? ` (שימוש ${t.usageCount}×)` : ''}\n`;
    out += `  _"${t.content.substring(0, 80)}${t.content.length > 80 ? '...' : ''}"_\n\n`;
  }
  return out.trim();
}

function deleteTemplate(name) {
  const d = load();
  if (!d[name]) return `❌ תבנית "${name}" לא נמצאה`;
  delete d[name];
  save(d);
  return `🗑️ תבנית "${name}" נמחקה`;
}

module.exports = { saveTemplate, getTemplate, listTemplates, deleteTemplate };
