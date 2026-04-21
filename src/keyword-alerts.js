'use strict';
const fs = require('fs');
const path = require('path');
const ALERTS_PATH = path.join(__dirname, '..', 'data', 'keyword-alerts.json');

const DEFAULT_KEYWORDS = [
  'קלנר', 'אריאל קלנר', 'ח"כ קלנר',
  'הצבעה', 'בגץ', 'דחוף', 'עכשיו', 'מיידי',
  'כינוס חירום', 'חדשות אחרונות'
];

function loadConfig() {
  try {
    if (!fs.existsSync(ALERTS_PATH)) {
      const def = { enabled: true, keywords: DEFAULT_KEYWORDS, alertedToday: {} };
      fs.writeFileSync(ALERTS_PATH, JSON.stringify(def, null, 2), 'utf8');
      return def;
    }
    return JSON.parse(fs.readFileSync(ALERTS_PATH, 'utf8'));
  } catch { return { enabled: true, keywords: DEFAULT_KEYWORDS, alertedToday: {} }; }
}

function saveConfig(cfg) {
  fs.writeFileSync(ALERTS_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function checkMessage(text, groupName) {
  const cfg = loadConfig();
  if (!cfg.enabled) return null;
  const lower = text.toLowerCase();
  for (const kw of cfg.keywords) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

function addKeyword(kw) {
  const cfg = loadConfig();
  if (!cfg.keywords.includes(kw)) { cfg.keywords.push(kw); saveConfig(cfg); }
  return cfg.keywords;
}

function removeKeyword(kw) {
  const cfg = loadConfig();
  cfg.keywords = cfg.keywords.filter(k => k !== kw);
  saveConfig(cfg);
  return cfg.keywords;
}

function setEnabled(v) {
  const cfg = loadConfig();
  cfg.enabled = v;
  saveConfig(cfg);
}

function getStatus() {
  const cfg = loadConfig();
  return cfg;
}

module.exports = { checkMessage, addKeyword, removeKeyword, setEnabled, getStatus };
