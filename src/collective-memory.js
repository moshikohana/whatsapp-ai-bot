'use strict';

/**
 * Collective Memory — searchable index across all bot data sources.
 *
 * Sources:
 *   • Scans   — data/scans/YYYY-MM-DD/HH-MM-<kind>.json (group scan outputs)
 *   • Chats   — logs/chat-YYYY-MM-DD.log (JSONL of every message in/out)
 *   • Calls   — extracted from chat log entries that contain "[🎙️ הקלטה:" markers
 *   • Memory  — bot-memory.json (persistent memories)
 *
 * Public API:
 *   gatherShards({ since, until, sources })
 *   searchMemory(query, { since, limit, useClaude })
 *
 * Design: keyword-based retrieval + Claude synthesis. No embeddings required.
 * For each query, we filter shards by keyword presence (with simple Hebrew-aware
 * matching), sort by recency, take top N, and ask Claude to synthesize.
 *
 * Performance: daily scan/chat directories are small (a few MB at most), so we
 * load on demand without indexing. If perf becomes an issue we can add a JSON
 * index file.
 */

const fs = require('fs');
const path = require('path');

const SCAN_DIR = path.join(__dirname, '..', 'data', 'scans');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const MEMORY_PATH = path.join(__dirname, '..', 'bot-memory.json');

// ─── Shard helpers ─────────────────────────────────────────────────

/**
 * Returns YYYY-MM-DD strings for every day from `since` (inclusive) to today.
 */
function dateRangeStrs(since) {
  const out = [];
  const start = new Date(since);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Read scan shards from data/scans/YYYY-MM-DD/*.json
 */
function loadScanShards(since) {
  const shards = [];
  if (!fs.existsSync(SCAN_DIR)) return shards;
  const days = dateRangeStrs(since);
  for (const day of days) {
    const dayDir = path.join(SCAN_DIR, day);
    if (!fs.existsSync(dayDir)) continue;
    let files;
    try { files = fs.readdirSync(dayDir).filter(f => f.endsWith('.json')); }
    catch { continue; }
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dayDir, file), 'utf8');
        const data = JSON.parse(raw);
        const time = file.replace('.json', '').split('-').slice(0, 2).join(':');
        // Use scanOutput as the searchable text body (it's the full report)
        const body = String(data.scanOutput || '').trim();
        if (!body) continue;
        shards.push({
          source: 'scan',
          date: day,
          time,
          kind: data.kind || 'unknown',
          text: body,
          preview: body.slice(0, 200),
          metadata: {
            totalMessages: data.totalMessages || 0,
            activeGroups: data.activeGroups || 0,
            hotGroup: data.hotGroup || null,
          },
        });
      } catch (e) { /* skip bad files */ }
    }
  }
  return shards;
}

/**
 * Read chat log shards from logs/chat-YYYY-MM-DD.log (JSONL)
 */
function loadChatShards(since) {
  const shards = [];
  if (!fs.existsSync(LOG_DIR)) return shards;
  const days = dateRangeStrs(since);
  for (const day of days) {
    const file = path.join(LOG_DIR, `chat-${day}.log`);
    if (!fs.existsSync(file)) continue;
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); }
    catch { continue; }
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (!obj.text) continue;
        const ts = obj.ts ? new Date(obj.ts) : null;
        const time = ts ? ts.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }) : '—';
        shards.push({
          source: 'chat',
          date: day,
          time,
          from: obj.from || '?',
          direction: obj.dir || '?',  // 'in' or 'out'
          chatId: obj.chatId || null,
          text: obj.text,
          preview: obj.text.slice(0, 200),
          isCall: typeof obj.text === 'string' && obj.text.includes('[🎙️ הקלטה:'),
        });
      } catch (e) { /* skip bad lines */ }
    }
  }
  return shards;
}

/**
 * Filter chat shards to call-related ones (transcripts).
 */
function loadCallShards(since) {
  return loadChatShards(since).filter(s => s.isCall).map(s => ({ ...s, source: 'call' }));
}

/**
 * Read persistent memory entries from bot-memory.json
 */
function loadMemoryShards() {
  try {
    const raw = fs.readFileSync(MEMORY_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.map(m => ({
      source: 'memory',
      date: (m.date || '').slice(0, 10),
      time: '—',
      category: m.category || 'כללי',
      text: m.text || '',
      preview: (m.text || '').slice(0, 200),
    })).filter(s => s.text);
  } catch (e) {
    return [];
  }
}

/**
 * Aggregate shards from all (or selected) sources within a time window.
 *
 * @param {object} options
 * @param {Date|string} [options.since]   Default: 30 days ago
 * @param {string[]} [options.sources]    e.g. ['scan','chat','call','memory']. Default: all
 */
function gatherShards({ since, sources = ['scan', 'chat', 'call', 'memory'] } = {}) {
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let all = [];
  if (sources.includes('scan')) all = all.concat(loadScanShards(sinceDate));
  if (sources.includes('chat')) all = all.concat(loadChatShards(sinceDate));
  if (sources.includes('call')) all = all.concat(loadCallShards(sinceDate));
  if (sources.includes('memory')) all = all.concat(loadMemoryShards());
  return all;
}

// ─── Hebrew-aware keyword matching ─────────────────────────────────

/**
 * Normalize Hebrew text: strip diacritics, lowercase, collapse common variants.
 */
function normalize(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, '')   // strip Hebrew diacritics (niqqud + cantillation)
    .replace(/["'״׳]/g, '')             // strip Hebrew quotation marks
    .replace(/\s+/g, ' ');
}

/**
 * Returns the count of distinct query tokens that appear in the text.
 * Higher = better match.
 */
function scoreShard(shard, queryTokens) {
  const txt = normalize(shard.text);
  let hits = 0;
  for (const tok of queryTokens) {
    if (!tok) continue;
    if (txt.includes(tok)) hits++;
  }
  // No token match → not a match. Recency only boosts real hits.
  if (hits === 0) return 0;
  let score = hits;
  const ageDays = (Date.now() - new Date(shard.date || 0).getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays < 7) score += 0.5;
  if (ageDays < 1) score += 0.5;
  return score;
}

/**
 * Tokenize a query into searchable Hebrew/English words.
 */
function tokenizeQuery(query) {
  return normalize(query)
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

// ─── Search ────────────────────────────────────────────────────────

/**
 * Search the collective memory for shards matching the query.
 * Returns { shards: [...], count, totalScanned }
 */
function searchShards(query, { since, limit = 30, sources } = {}) {
  const all = gatherShards({ since, sources });
  const tokens = tokenizeQuery(query);
  if (!tokens.length) {
    return { shards: [], count: 0, totalScanned: all.length };
  }
  const scored = [];
  for (const s of all) {
    const sc = scoreShard(s, tokens);
    if (sc > 0) scored.push({ ...s, _score: sc });
  }
  scored.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    // Tie: newer first
    return (b.date || '').localeCompare(a.date || '');
  });
  return {
    shards: scored.slice(0, limit),
    count: scored.length,
    totalScanned: all.length,
  };
}

/**
 * Format shards for inclusion in Claude prompt — compact, source-tagged.
 */
function formatShardsForPrompt(shards) {
  return shards.map((s, i) => {
    const head = `[${i + 1}] ${s.source.toUpperCase()} ${s.date}${s.time !== '—' ? ' ' + s.time : ''}`;
    const meta = s.from ? ` (${s.from})` : (s.category ? ` (${s.category})` : '');
    const body = s.text.length > 600 ? s.text.slice(0, 600) + '…' : s.text;
    return `${head}${meta}\n${body}`;
  }).join('\n\n---\n\n');
}

/**
 * Search + Claude synthesis. Asks Claude to answer the query using only the
 * retrieved shards. Returns a Hebrew-formatted answer with source attribution.
 */
async function searchMemory(query, { since, limit = 25, sources, useClaude = true } = {}) {
  const result = searchShards(query, { since, limit, sources });
  if (!result.shards.length) {
    return {
      answer: `📭 לא מצאתי שום אזכור של "${query}" במקורות (סריקות/שיחות/הקלטות/זיכרון).\n\n_מקורות נסרקו: ${result.totalScanned}_`,
      shards: [],
      count: 0,
    };
  }

  if (!useClaude) {
    // Return a plain list of matches without Claude synthesis
    const lines = [`🔍 *מצאתי ${result.count} אזכורים של "${query}"*`, ''];
    for (const s of result.shards.slice(0, 10)) {
      const tag = s.source === 'scan' ? '📊' : s.source === 'chat' ? '💬' : s.source === 'call' ? '📞' : '🧠';
      lines.push(`${tag} *${s.date}${s.time !== '—' ? ' ' + s.time : ''}*${s.from ? ' — ' + s.from : ''}`);
      lines.push(`   _${s.preview}${s.text.length > 200 ? '…' : ''}_`);
      lines.push('');
    }
    return { answer: lines.join('\n'), shards: result.shards, count: result.count };
  }

  // Claude synthesis
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch { return { answer: '❌ Anthropic SDK חסר', shards: [], count: 0 }; }
  if (!process.env.ANTHROPIC_API_KEY) return { answer: '❌ ANTHROPIC_API_KEY חסר', shards: [], count: 0 };

  const shardsText = formatShardsForPrompt(result.shards);
  const prompt = `שאלה: "${query}"

מקורות מהזיכרון של מושיקו (${result.shards.length} מתוך ${result.count} תוצאות):

${shardsText}

ענה על השאלה בעברית, אנושי ותמציתי. אם רלוונטי — ציין מתי ובאיזה מקור (לדוגמה "ב-22.4 בשיחה עם ליאור"). אם המקורות לא מספיקים לתשובה ברורה — אמור זאת. בלי לחזור על המקור המלא.`;

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: 'אתה עוזר אישי של מושיקו אוחנה — דובר ח"כ אריאל קלנר. תן תשובות מבוססות מקורות בעברית.',
      messages: [{ role: 'user', content: prompt }],
    });
    const textBlock = response.content.find(b => b.type === 'text');
    const synthesized = textBlock ? textBlock.text.trim() : 'לא הצלחתי לסכם';
    return {
      answer: `🧠 *זיכרון על "${query}"*\n━━━━━━━━━━━━━━━━━━━━\n\n${synthesized}\n\n_📚 ${result.count} מקורות נסרקו, ${result.shards.length} שולבו בתשובה_`,
      shards: result.shards,
      count: result.count,
    };
  } catch (e) {
    console.warn('⚠️ searchMemory Claude synthesis failed:', e.message);
    // Fall back to listing
    return await searchMemory(query, { since, limit, sources, useClaude: false });
  }
}

module.exports = {
  // Loaders
  loadScanShards,
  loadChatShards,
  loadCallShards,
  loadMemoryShards,
  gatherShards,

  // Helpers
  normalize,
  tokenizeQuery,
  searchShards,

  // Public
  searchMemory,
};
