'use strict';
/**
 * Google OAuth setup — Calendar + Gmail + Contacts in one flow.
 *
 * STEP 1: Create credentials at https://console.cloud.google.com/
 *   1. Create project → Enable APIs: Calendar API, Gmail API, People API
 *   2. OAuth consent screen → External → Add scopes → Publish
 *   3. Credentials → Create OAuth Client ID → Desktop App
 *   4. Download JSON → paste contents into GOOGLE_CREDENTIALS in .env
 *
 * STEP 2: Run this script:
 *   node setup-google.js
 */
require('dotenv').config({ override: true });
const { google } = require('googleapis');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/contacts.readonly',
];

const PORT = 3333;

async function main() {
  if (!process.env.GOOGLE_CREDENTIALS) {
    console.log(`
╔══════════════════════════════════════════════════════╗
║  🔧 הגדרת Google API — שלב ראשון                    ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  1. פתח: https://console.cloud.google.com/           ║
║  2. צור פרוייקט חדש (או בחר קיים)                    ║
║  3. APIs & Services → Library:                       ║
║     - חפש "Google Calendar API" → Enable             ║
║     - חפש "Gmail API" → Enable                       ║
║     - חפש "People API" → Enable                      ║
║  4. APIs & Services → OAuth consent screen:          ║
║     - User Type: External → Create                   ║
║     - App name: "WhatsApp Bot" → Save                ║
║     - Add test user: your@gmail.com                  ║
║  5. APIs & Services → Credentials:                   ║
║     - Create Credentials → OAuth client ID           ║
║     - Application type: Desktop app                  ║
║     - Create → Download JSON                         ║
║  6. פתח את ה-JSON והדבק ב-.env:                      ║
║     GOOGLE_CREDENTIALS={"installed":{...}}           ║
║  7. הרץ שוב: node setup-google.js                    ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
`);
    process.exit(0);
  }

  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const { client_id, client_secret } = creds.installed || creds.web;
  // Use local redirect URI for automatic code capture
  const redirectUri = `http://localhost:${PORT}`;
  const auth = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const url = auth.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n📋 *הגדרת Google (Calendar + Gmail)*\n');
  console.log('⏳ מחכה לאישור בדפדפן...\n');

  // Start local server to catch the redirect
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const code = url.searchParams.get('code');

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>❌ לא התקבל קוד. נסה שוב.</h1>');
      return;
    }

    try {
      const { tokens } = await auth.getToken(code);
      const tokenStr = JSON.stringify(tokens);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1 style="color:green; font-family:sans-serif;">✅ הצלחה! אפשר לסגור את הדף הזה.</h1>');

      // Auto-save to .env
      const envPath = path.join(__dirname, '.env');
      let envContent = fs.readFileSync(envPath, 'utf-8');
      if (envContent.includes('GOOGLE_TOKEN=')) {
        envContent = envContent.replace(/GOOGLE_TOKEN=.*/g, `GOOGLE_TOKEN=${tokenStr}`);
      } else {
        envContent += `\nGOOGLE_TOKEN=${tokenStr}\n`;
      }
      if (!envContent.includes('GOOGLE_CALENDAR_ENABLED=')) {
        envContent += 'GOOGLE_CALENDAR_ENABLED=true\n';
      }
      if (!envContent.includes('GOOGLE_GMAIL_ENABLED=')) {
        envContent += 'GOOGLE_GMAIL_ENABLED=true\n';
      }
      fs.writeFileSync(envPath, envContent, 'utf-8');

      console.log('\n✅ הצלחה! הטוקן נשמר אוטומטית ב-.env\n');
      console.log('הפעל מחדש: npm start\n');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1 style="color:red; font-family:sans-serif;">❌ שגיאה: ${e.message}</h1>`);
      console.error('\n❌ שגיאה:', e.message);
    }

    server.close();
  });

  server.listen(PORT, () => {
    // Open browser
    const openCmd = process.platform === 'win32' ? 'start'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${openCmd} "${url}"`);

    console.log(`🌐 שרת מקומי רץ על פורט ${PORT}`);
    console.log('הדפדפן נפתח — אשר את ההרשאות והקוד ייתפס אוטומטית.\n');
    console.log('אם הדפדפן לא נפתח, פתח ידנית:');
    console.log(url);
  });
}

main();
