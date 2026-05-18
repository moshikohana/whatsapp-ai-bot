'use strict';
/**
 * Article reader — fetch URL via Jina Reader (https://r.jina.ai) and
 * summarize with Claude. Handles most public news/blog pages.
 *
 * Limits:
 *   - Sites with strict anti-bot (Cloudflare challenge, paywalls) may return
 *     "blocked" — we surface the error honestly instead of hallucinating.
 *   - Social media links (X/Twitter, Facebook, Instagram) currently fall back
 *     to OG metadata — best-effort, not full content.
 */

const Anthropic = require('@anthropic-ai/sdk').default;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_CONTENT = 18000;

async function _fetchJina(url) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const res = await fetch(jinaUrl, {
    headers: { 'Accept': 'text/plain', 'X-Return-Format': 'markdown' },
  });
  if (!res.ok) throw new Error(`Jina ${res.status}: ${res.statusText}`);
  return await res.text();
}

function _looksAntiBotBlocked(text) {
  const lower = (text || '').toLowerCase();
  return lower.includes('attention required') ||
         lower.includes('checking your browser') ||
         lower.includes('cloudflare') ||
         lower.includes('access denied') ||
         lower.includes('captcha');
}

async function _summarize(text, url) {
  const trimmed = text.length > MAX_CONTENT ? text.substring(0, MAX_CONTENT) + '\n...(נחתך)' : text;
  const prompt = [
    `סכם את הכתבה הבאה בקצרה ב-עברית — 3-6 שורות שמכסות את העיקר. ציין את שם הכותב/הפרסום אם נמצא בכתבה.`,
    ``,
    `מקור: ${url}`,
    ``,
    trimmed,
  ].join('\n');
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });
  return r.content.filter(b => b.type === 'text').map(b => b.text.trim()).join('\n\n');
}

async function actionRead({ url }) {
  if (!url) return '❌ חסר URL';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const text = await _fetchJina(url);
    if (!text || text.trim().length < 50) {
      return `❌ לא הצלחתי לקרוא תוכן מהקישור.\n${url}`;
    }
    if (_looksAntiBotBlocked(text)) {
      return `🚫 *האתר חוסם קריאה אוטומטית* (Cloudflare/anti-bot).\nמקור: ${url}\nתוכל לפתוח ידנית ולשלוח את הטקסט להעתקה.`;
    }
    const summary = await _summarize(text, url);
    return `📰 *סיכום הכתבה:*\n\n${summary}\n\n🔗 ${url}`;
  } catch (e) {
    return `❌ שגיאה בקריאת הקישור: ${e.message?.substring(0, 120)}`;
  }
}

async function run(input, _context) {
  const { action } = input;
  switch (action) {
    case 'read': return actionRead(input);
    default: return `❌ פעולה לא מוכרת: ${action}`;
  }
}

module.exports = { run };
