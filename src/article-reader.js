'use strict';
/**
 * Article reader — fetches a URL via Jina Reader (https://r.jina.ai/...)
 * and returns clean Markdown.
 *
 * Why Jina Reader vs. raw fetch + parser?
 * - Handles JavaScript rendering (single-page apps work)
 * - Auto-removes ads, navigation, related-articles, comments
 * - Returns Markdown that Claude reads easily
 * - Free tier: ~20 req/min unauthenticated, generous for personal use
 * - Fallback: if Jina is down, we fetch raw HTML and strip tags as best-effort
 *
 * Returns: { ok, title, url, published, text, source, error? }
 */

const JINA_BASE = 'https://r.jina.ai/';
const FETCH_TIMEOUT_MS = 25000;
const MAX_TEXT_LENGTH = 30000; // cap to avoid huge payloads to Claude
const PUPPETEER_TIMEOUT_MS = 35000;

// Detect Cloudflare / anti-bot challenge pages.
// Jina sometimes returns these when the target site blocks bots.
const _CHALLENGE_PATTERNS = [
  /^Just a moment\.\.?\.?$/i,
  /Verifying you are human/i,
  /enable JavaScript and cookies/i,
  /Checking your browser/i,
  /Access denied/i,
  /attention required/i,
];

function _isAntibotChallenge(title, text) {
  if (title && _CHALLENGE_PATTERNS.some(re => re.test(title))) return true;
  if (text && text.length < 800 && _CHALLENGE_PATTERNS.some(re => re.test(text))) return true;
  return false;
}

function _isLikelyUrl(s) {
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function _extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s)\]"'<>]+/);
  return m ? m[0].replace(/[.,;]+$/, '') : null;
}

async function _fetchWithTimeout(url, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (whatsapp-ai-bot/1.0)',
        'Accept': 'text/markdown, text/plain, text/html;q=0.8',
      },
    });
    return r;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Parse Jina Reader's response. Format:
 *   Title: <title>
 *   URL Source: <url>
 *   Published Time: <date>
 *   Markdown Content:
 *   <body>
 */
function _parseJinaResponse(text) {
  const lines = text.split('\n');
  let title = null, urlSource = null, published = null, bodyStart = -1;

  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const line = lines[i];
    if (!title && line.startsWith('Title: ')) title = line.substring(7).trim();
    else if (!urlSource && line.startsWith('URL Source: ')) urlSource = line.substring(12).trim();
    else if (!published && line.startsWith('Published Time: ')) published = line.substring(16).trim();
    else if (line.startsWith('Markdown Content:')) { bodyStart = i + 1; break; }
  }

  let body = bodyStart >= 0 ? lines.slice(bodyStart).join('\n').trim() : text.trim();
  if (body.length > MAX_TEXT_LENGTH) {
    body = body.substring(0, MAX_TEXT_LENGTH) + '\n\n... (תוכן קוצר)';
  }

  return { title, urlSource, published, body };
}

/**
 * Strip HTML tags from raw HTML — fallback when Jina fails.
 * Heuristic: find <article>, <main>, or fall back to <body>.
 */
function _stripHtml(html) {
  if (!html) return '';
  // Try article > main > body
  const tryExtract = (tag) => {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const m = html.match(re);
    return m ? m[1] : null;
  };
  let content = tryExtract('article') || tryExtract('main') || tryExtract('body') || html;

  // Title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : null;

  // Strip scripts, styles, etc.
  content = content
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, body: content.substring(0, MAX_TEXT_LENGTH) };
}

/**
 * Puppeteer fallback — used when Jina returns a Cloudflare/anti-bot
 * challenge page. We spawn our own headless Chromium (separate from
 * the WhatsApp client's puppeteer) to fetch the article like a real
 * browser would, including JS execution.
 */
async function _puppeteerFetch(url) {
  let puppeteer;
  try { puppeteer = require('puppeteer'); }
  catch { return { ok: false, error: 'Puppeteer לא מותקן' }; }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      timeout: PUPPETEER_TIMEOUT_MS,
    });
    const page = await browser.newPage();
    // Realistic browser fingerprint to bypass simple bot checks
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: PUPPETEER_TIMEOUT_MS });
    // Wait a bit more for Cloudflare to clear / SPA rendering
    await new Promise(r => setTimeout(r, 3500));

    const data = await page.evaluate(() => {
      // Prefer <article>, then <main>, then [role=main], then body
      const candidates = [
        document.querySelector('article'),
        document.querySelector('main'),
        document.querySelector('[role="main"]'),
        document.querySelector('.article-body, .post-body, .entry-content'),
        document.body,
      ];
      const node = candidates.find(n => n && n.innerText && n.innerText.length > 200) || document.body;
      return {
        title: document.title || null,
        text: node.innerText || '',
      };
    });

    if (!data.text || data.text.length < 200) {
      return { ok: false, error: 'הדף נטען אבל התוכן קצר מדי — ייתכן שיש Paywall.' };
    }

    return {
      ok: true,
      source: 'puppeteer',
      url,
      title: data.title,
      published: null,
      text: data.text.substring(0, MAX_TEXT_LENGTH),
    };
  } catch (err) {
    return { ok: false, error: `Puppeteer fetch failed: ${err.message?.substring(0, 100)}` };
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
}

/**
 * Main entry: fetch a URL and return clean text/markdown.
 * Cascade: Jina Reader → raw fetch → headless Chromium.
 */
async function readArticle(url) {
  if (!_isLikelyUrl(url)) {
    const extracted = _extractFirstUrl(url);
    if (!extracted) return { ok: false, error: 'לא זוהה URL תקין. דוגמה: https://www.ynet.co.il/...' };
    url = extracted;
  }

  // ── Try 1: Jina Reader (fast, free) ──
  try {
    const jinaUrl = JINA_BASE + url;
    const r = await _fetchWithTimeout(jinaUrl);
    if (r.ok) {
      const text = await r.text();
      const parsed = _parseJinaResponse(text);
      const isChallenge = _isAntibotChallenge(parsed.title, parsed.body);
      if (parsed.body && parsed.body.length > 100 && !isChallenge) {
        return {
          ok: true,
          source: 'jina',
          url: parsed.urlSource || url,
          title: parsed.title || null,
          published: parsed.published || null,
          text: parsed.body,
        };
      }
      if (isChallenge) {
        console.warn(`[article-reader] Cloudflare/antibot challenge — falling back to Puppeteer for ${url}`);
      }
    } else {
      console.warn(`[article-reader] Jina returned ${r.status} for ${url}`);
    }
  } catch (err) {
    console.warn(`[article-reader] Jina failed: ${err.message?.substring(0, 80)}`);
  }

  // ── Try 2: Raw fetch + HTML strip (if site doesn't need JS) ──
  try {
    const r = await _fetchWithTimeout(url);
    if (r.ok) {
      const html = await r.text();
      const { title, body } = _stripHtml(html);
      const isChallenge = _isAntibotChallenge(title, body);
      if (body && body.length > 200 && !isChallenge) {
        return { ok: true, source: 'raw', url, title, published: null, text: body };
      }
    }
  } catch (err) {
    console.warn(`[article-reader] Raw fetch failed: ${err.message?.substring(0, 80)}`);
  }

  // ── Try 3: Puppeteer (slow but bypasses Cloudflare) ──
  console.log(`[article-reader] Falling back to Puppeteer for ${url}`);
  const pptrResult = await _puppeteerFetch(url);
  return pptrResult;
}

module.exports = { readArticle };
