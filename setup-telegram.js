'use strict';
/**
 * Telegram MTProto setup — first-time login.
 *
 * STEP 1: Get API credentials (one-time):
 *   1. Open https://my.telegram.org/auth and log in with your phone
 *   2. Click "API development tools"
 *   3. Fill in: App title (e.g. "WhatsApp Bot"), Short name (e.g. "wabot"),
 *      Platform: Desktop, Description: anything
 *   4. Submit → you'll see `api_id` (number) and `api_hash` (32-char hex)
 *   5. Add to .env:
 *      TELEGRAM_API_ID=12345678
 *      TELEGRAM_API_HASH=abcdef0123456789abcdef0123456789
 *
 * STEP 2: Run this script:
 *   node setup-telegram.js
 *
 * It will prompt for:
 *   - Your phone number (with country code, e.g. +972524243250)
 *   - The SMS code Telegram sends you
 *   - Your 2FA password (if 2FA enabled)
 *
 * After success, TELEGRAM_SESSION is saved to .env. Bot can then connect
 * silently on every restart with no further prompts.
 */

require('dotenv').config({ override: true });
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      // Best-effort hidden input — works in most terminals.
      const stdin = process.stdin;
      const onData = (char) => {
        char = char + '';
        if (char === '\n' || char === '\r' || char === '') {
          stdin.removeListener('data', onData);
        } else {
          process.stdout.write('*');
        }
      };
      process.stdout.write(question);
      rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
      stdin.on('data', onData);
    } else {
      rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
    }
  });
}

function saveSession(sessionString) {
  const envPath = path.join(__dirname, '.env');
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const line = `TELEGRAM_SESSION=${sessionString}`;
  if (/^TELEGRAM_SESSION=/m.test(envContent)) {
    envContent = envContent.replace(/^TELEGRAM_SESSION=.*/m, line);
  } else {
    if (envContent && !envContent.endsWith('\n')) envContent += '\n';
    envContent += line + '\n';
  }
  fs.writeFileSync(envPath, envContent, 'utf-8');
}

async function main() {
  console.log('\n📡 *הגדרת Telegram — התחברות ראשונית*\n');

  if (!API_ID || !API_HASH) {
    console.log(`
╔══════════════════════════════════════════════════════╗
║  🔧 חסרים פרטי API לטלגרם                            ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  1. פתח: https://my.telegram.org/auth                ║
║  2. התחבר עם הטלפון שלך                              ║
║  3. לחץ "API development tools"                      ║
║  4. מלא: App title=WhatsApp Bot, Short name=wabot,   ║
║     Platform=Desktop, Description=any                ║
║  5. שלח → תראה api_id ו-api_hash                     ║
║  6. הוסף ל-.env:                                     ║
║     TELEGRAM_API_ID=12345678                         ║
║     TELEGRAM_API_HASH=abcdef0123456789...            ║
║  7. הרץ שוב: node setup-telegram.js                  ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
`);
    process.exit(0);
  }

  const session = new StringSession('');
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    deviceModel: 'WhatsApp Bot',
    systemVersion: 'Win10',
    appVersion: '1.0',
  });

  console.log('⏳ מתחבר ל-Telegram...\n');

  // ── Two input modes ─────────────────────────────────────────────
  //   (A) Interactive (default):       prompts via readline (terminal)
  //   (B) File-driven (--file-mode):   reads from .tg-code / .tg-2fa
  //       Phone provided via CLI arg.  Useful when driving from chat.
  const fileMode = process.argv.includes('--file-mode');
  const cliPhone = process.argv.find((a, i) => i > 1 && a.startsWith('+'));

  // Helpers for file-driven mode
  const tmpDir = __dirname;
  const codeFile = path.join(tmpDir, '.tg-code');
  const twoFaFile = path.join(tmpDir, '.tg-2fa');
  // Clean any stale files left from a previous aborted attempt
  for (const f of [codeFile, twoFaFile]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }

  const waitForFile = async (file, label) => {
    console.log(`⏳ ממתין ל-${label} בקובץ ${path.basename(file)}...`);
    const deadline = Date.now() + 5 * 60 * 1000; // 5 minutes
    while (Date.now() < deadline) {
      if (fs.existsSync(file)) {
        const v = fs.readFileSync(file, 'utf-8').trim();
        try { fs.unlinkSync(file); } catch {}
        if (v) return v;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error(`Timeout waiting for ${label}`);
  };

  await client.start({
    phoneNumber: async () => {
      if (cliPhone) { console.log(`📱 משתמש במספר מ-CLI: ${cliPhone}`); return cliPhone; }
      return await prompt('📱 מספר טלפון (עם קידומת בינ"ל, למשל +972524243250): ');
    },
    password: async () => {
      if (fileMode) return await waitForFile(twoFaFile, 'סיסמת 2FA');
      return await prompt('🔒 סיסמת 2FA (אם הוגדרה — אחרת Enter ריק): ', { hidden: true });
    },
    phoneCode: async () => {
      if (fileMode) { console.log('📨 הקוד נשלח לאפליקציית Telegram שלך — חכה שיגיע ושלח אותו דרך הצ׳אט.'); return await waitForFile(codeFile, 'קוד אימות'); }
      return await prompt('📨 קוד אימות (יישלח לאפליקציית Telegram שלך): ');
    },
    onError: (err) => {
      console.error('❌ שגיאה:', err.message || err);
    },
  });

  const sessionString = client.session.save();
  saveSession(sessionString);

  console.log('\n✅ הצלחה! נשמר TELEGRAM_SESSION ב-.env');
  console.log('הפעל מחדש את הבוט כדי שיתחבר אוטומטית.\n');

  await client.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error('\n❌ שגיאה כללית:', e.message || e);
  process.exit(1);
});
