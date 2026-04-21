'use strict';
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'media-outreach.json');

const DEFAULT_CONTACTS = [
  { id: 'eran14',   name: 'ליאור עודד מנשה',    outlet: 'ערוץ 14',              phone: '972537263501', status: 'idle', lastOutreach: null, lastTopic: null, history: [] },
  { id: 'daniel14', name: 'דניאל (בועז גולן)',   outlet: 'ערוץ 14',              phone: '972503626668', status: 'idle', lastOutreach: null, lastTopic: null, history: [] },
  { id: 'kneset',   name: 'רונאל מורן אזולאי',   outlet: 'ערוץ הכנסת',           phone: '972546609156', status: 'idle', lastOutreach: null, lastTopic: null, history: [] },
  { id: 'kolrama',  name: 'אבי מפיק',             outlet: 'קול ברמה (נתן משי)',   phone: '972532471100', status: 'idle', lastOutreach: null, lastTopic: null, history: [] },
  { id: 'barda',    name: 'מאיר שמצוב',           outlet: 'ברדוגו',               phone: '972507106390', status: 'idle', lastOutreach: null, lastTopic: null, history: [] },
  { id: 'keshet',   name: 'דניאל בשך',            outlet: 'קשת 12 (רפי רשף)',    phone: '972546172126', status: 'idle', lastOutreach: null, lastTopic: null, history: [] },
];

// ─── Load / Save ───────────────────────────────────────────────────────────

function loadContacts() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('⚠️ Failed to read media-outreach.json:', err.message);
  }
  // Seed defaults on first run
  saveContacts(DEFAULT_CONTACTS);
  return DEFAULT_CONTACTS.map(c => ({ ...c }));
}

function saveContacts(contacts) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(contacts, null, 2), 'utf-8');
  } catch (err) {
    console.error('⚠️ Failed to write media-outreach.json:', err.message);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

// Returns "14/4 (7 ימים)" style label from an ISO date string
function formatOutreachDate(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  const now = new Date();
  const daysDiff = Math.round((now - d) / (1000 * 60 * 60 * 24));
  const day = d.getDate();
  const month = d.getMonth() + 1;
  return `${day}/${month} (${daysDiff} ימים)`;
}

function statusEmoji(status) {
  if (status === 'replied')  return '✅';
  if (status === 'pending')  return '⏳';
  return '⬜';
}

function findContact(contacts, id) {
  return contacts.find(c => c.id === id);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Returns a formatted Hebrew string with the full outreach status list.
 */
function listContacts() {
  const contacts = loadContacts();
  let out = '📞 *מעקב פניות תקשורת*\n━━━━━━━━━━━━━━━━━━━━\n\n';

  for (const c of contacts) {
    const emoji = statusEmoji(c.status);
    out += `${emoji} ${c.name} | ${c.outlet}\n`;
    if (c.lastOutreach) {
      const dateLabel = formatOutreachDate(c.lastOutreach);
      out += `   📅 פנייה אחרונה: ${dateLabel} | נושא: ${c.lastTopic || '—'}\n`;
    } else {
      out += `   📅 לא פנינו עדיין\n`;
    }
    out += '\n';
  }

  return out.trim();
}

/**
 * Marks a contact as "pending", records today's date and the given topic.
 * Appends to history as well.
 */
function logOutreach(contactId, topic) {
  const contacts = loadContacts();
  const c = findContact(contacts, contactId);
  if (!c) return `❌ איש קשר "${contactId}" לא נמצא`;

  const now = new Date().toISOString();
  c.status = 'pending';
  c.lastOutreach = now;
  c.lastTopic = topic || null;
  c.history.push({ date: now, topic: topic || null, status: 'pending' });

  saveContacts(contacts);
  return `✅ נרשמה פנייה ל${c.name} (${c.outlet}) — נושא: ${topic || '—'}`;
}

/**
 * Marks a contact as "replied".
 */
function markReplied(contactId) {
  const contacts = loadContacts();
  const c = findContact(contacts, contactId);
  if (!c) return `❌ איש קשר "${contactId}" לא נמצא`;

  c.status = 'replied';
  if (c.history.length) c.history[c.history.length - 1].status = 'replied';

  saveContacts(contacts);
  return `✅ ${c.name} (${c.outlet}) סומן כ"הגיב"`;
}

/**
 * Resets a contact back to idle (clears lastOutreach, lastTopic, status).
 */
function resetContact(contactId) {
  const contacts = loadContacts();
  const c = findContact(contacts, contactId);
  if (!c) return `❌ איש קשר "${contactId}" לא נמצא`;

  c.status = 'idle';
  c.lastOutreach = null;
  c.lastTopic = null;

  saveContacts(contacts);
  return `✅ ${c.name} (${c.outlet}) אופס למצב "לא פנינו"`;
}

/**
 * Returns array of {name, outlet, phone} for all contacts.
 * Used by Claude to build bulk draft WhatsApp messages.
 */
function getBulkDraftContext() {
  const contacts = loadContacts();
  return contacts.map(c => ({ name: c.name, outlet: c.outlet, phone: c.phone }));
}

/**
 * Returns contacts with status 'pending' where lastOutreach was more than
 * hoursThreshold hours ago. Used by the auto follow-up cron.
 */
function getPendingContacts(hoursThreshold = 6) {
  const contacts = loadContacts();
  const cutoff = Date.now() - hoursThreshold * 60 * 60 * 1000;
  return contacts.filter(c =>
    c.status === 'pending' &&
    c.lastOutreach &&
    new Date(c.lastOutreach).getTime() < cutoff
  );
}

module.exports = {
  loadContacts,
  saveContacts,
  listContacts,
  logOutreach,
  markReplied,
  resetContact,
  getBulkDraftContext,
  getPendingContacts,
};
