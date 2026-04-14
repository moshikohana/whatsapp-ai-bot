'use strict';
const { google } = require('googleapis');

function getAuth() {
  if (!process.env.GOOGLE_CREDENTIALS) throw new Error('GOOGLE_CREDENTIALS לא מוגדר ב-.env');
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  if (!process.env.GOOGLE_TOKEN) throw new Error('GOOGLE_TOKEN לא מוגדר — הרץ: node setup-google.js');
  auth.setCredentials(JSON.parse(process.env.GOOGLE_TOKEN));
  return auth;
}

function getPeople() {
  return google.people({ version: 'v1', auth: getAuth() });
}

// ─── Search Contacts ────────────────────────────────────────────
async function searchContacts(query) {
  const people = getPeople();

  // Search in saved contacts
  const res = await people.people.searchContacts({
    query,
    readMask: 'names,emailAddresses,phoneNumbers',
    pageSize: 10,
  });

  const results = res.data.results || [];
  if (!results.length) return `📇 לא נמצאו אנשי קשר עבור "${query}"`;

  let text = `📇 *אנשי קשר — "${query}"*\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  results.forEach((r, i) => {
    const person = r.person;
    const name = person.names?.[0]?.displayName || '(ללא שם)';
    const phones = (person.phoneNumbers || []).map(p => p.value).join(', ');
    const emails = (person.emailAddresses || []).map(e => e.value).join(', ');

    text += `*${i + 1}.* *${name}*\n`;
    if (phones) text += `   📱 ${phones}\n`;
    if (emails) text += `   📧 ${emails}\n`;
    text += '\n';
  });

  return text.trim();
}

// ─── List Contacts ──────────────────────────────────────────────
async function listContacts() {
  const people = getPeople();

  // Fetch all contacts with pagination
  let allContacts = [];
  let nextPageToken = null;

  do {
    const res = await people.people.connections.list({
      resourceName: 'people/me',
      pageSize: 1000,
      sortOrder: 'LAST_NAME_ASCENDING',
      personFields: 'names,emailAddresses,phoneNumbers',
      pageToken: nextPageToken || undefined,
    });

    const contacts = res.data.connections || [];
    allContacts.push(...contacts);
    nextPageToken = res.data.nextPageToken;
  } while (nextPageToken);

  // Filter out contacts without names
  const named = allContacts.filter(c => c.names?.[0]?.displayName);

  if (!named.length) return `📇 נמצאו ${allContacts.length} אנשי קשר אבל אף אחד עם שם.`;

  // Show summary + first 30
  const shown = named.slice(0, 30);
  let text = `📇 *אנשי הקשר שלך* (${named.length} עם שם, ${allContacts.length} סה"כ)\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  shown.forEach((person, i) => {
    const name = person.names[0].displayName;
    const phone = person.phoneNumbers?.[0]?.value || '';
    const email = person.emailAddresses?.[0]?.value || '';

    text += `*${i + 1}.* ${name}`;
    if (phone) text += ` · 📱 ${phone}`;
    if (email) text += ` · 📧 ${email}`;
    text += '\n';
  });

  if (named.length > 30) {
    text += `\n_...ועוד ${named.length - 30} אנשי קשר. חפש לפי שם כדי למצוא מישהו ספציפי._`;
  }

  return text.trim();
}

// ─── Get Contact Details ────────────────────────────────────────
async function getContactByName(name) {
  const people = getPeople();
  const res = await people.people.searchContacts({
    query: name,
    readMask: 'names,emailAddresses,phoneNumbers,addresses,birthdays,organizations',
    pageSize: 1,
  });

  const results = res.data.results || [];
  if (!results.length) return `📇 לא נמצא איש קשר בשם "${name}"`;

  const person = results[0].person;
  const displayName = person.names?.[0]?.displayName || '(ללא שם)';
  const phones = (person.phoneNumbers || []).map(p => `📱 ${p.value}`).join('\n');
  const emails = (person.emailAddresses || []).map(e => `📧 ${e.value}`).join('\n');
  const addresses = (person.addresses || []).map(a => `📍 ${a.formattedValue || a.streetAddress}`).join('\n');
  const orgs = (person.organizations || []).map(o => `🏢 ${o.name || ''}${o.title ? ' — ' + o.title : ''}`).join('\n');
  const birthday = person.birthdays?.[0]?.date;
  const bday = birthday ? `🎂 ${birthday.day}/${birthday.month}${birthday.year ? '/' + birthday.year : ''}` : '';

  let text = `📇 *${displayName}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  if (phones) text += `${phones}\n`;
  if (emails) text += `${emails}\n`;
  if (addresses) text += `${addresses}\n`;
  if (orgs) text += `${orgs}\n`;
  if (bday) text += `${bday}\n`;

  return text.trim();
}

module.exports = { searchContacts, listContacts, getContactByName };
