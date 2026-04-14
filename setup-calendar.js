'use strict';
/**
 * Run this once to authorize Google Calendar access.
 * Usage: node setup-calendar.js
 */
require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

async function main() {
  if (!process.env.GOOGLE_CREDENTIALS) {
    console.error('❌ הוסף GOOGLE_CREDENTIALS ל-.env תחילה');
    process.exit(1);
  }

  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const { client_secret, client_id, redirect_uris } =
    credentials.installed || credentials.web;

  const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const authUrl = auth.generateAuthUrl({ access_type: 'offline', scope: SCOPES });

  console.log('\n1. פתח את הקישור הבא בדפדפן:\n');
  console.log(authUrl);
  console.log('\n2. אשר גישה ליומן');
  console.log('3. העתק את הקוד שקיבלת\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('הדבק את הקוד כאן: ', async (code) => {
    rl.close();
    try {
      const { tokens } = await auth.getToken(code.trim());
      console.log('\n✅ הצלחה! הוסף שורה זו ל-.env שלך:\n');
      console.log(`GOOGLE_TOKEN=${JSON.stringify(tokens)}`);
      console.log('\nואז שנה ל: GOOGLE_CALENDAR_ENABLED=true\n');
    } catch (e) {
      console.error('❌ שגיאה:', e.message);
    }
  });
}

main();
