'use strict';
/**
 * X (Twitter) intelligence for Kellner's spokesperson — via twitterapi.io.
 *   • recent mentions/replies about Kellner (who's talking, what they say)
 *   • his own tweets ranked by engagement (what's resonating)
 *   • sentiment split + notable/hostile mentions + attacks to answer
 *
 * twitterapi.io's scrape endpoints intermittently return empty, so every
 * call retries until it gets data (or gives up).
 */

const https = require('https');
const logger = require('./logger');

function _key() { return process.env.TWITTERAPI_KEY; }

function _once(path) {
  return new Promise((resolve) => {
    const req = https.get('https://api.twitterapi.io' + path, { headers: { 'X-API-Key': _key() } }, (res) => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
// twitterapi.io returns empty ~2/3 of the time. It bills PER TWEET returned,
// so empty responses are FREE — only the one successful fetch costs (~$0.003).
// Retry generously so the report reliably has data; the charged call stops
// the loop immediately.
async function _retry(path, isEmpty, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const j = await _once(path);
    if (j && !isEmpty(j)) return j;
    await new Promise(r => setTimeout(r, 700));
  }
  return null;
}

// Recent mentions/replies about Kellner (excludes his own tweets + RTs).
async function getMentions(max = 30) {
  if (!_key()) return null;
  const q = encodeURIComponent('(@ArielKallner OR "אריאל קלנר") -is:retweet');
  const j = await _retry(`/twitter/tweet/advanced_search?queryType=Latest&query=${q}`, d => !(d.tweets || []).length);
  if (!j) return [];
  return (j.tweets || [])
    .map(t => ({
      user: (t.author || {}).userName || '?',
      name: (t.author || {}).name || '',
      text: (t.text || '').replace(/\s+/g, ' ').trim(),
      date: t.createdAt, url: t.url || t.twitterUrl || '',
      likes: t.likeCount || 0, replies: t.replyCount || 0, rts: t.retweetCount || 0, views: t.viewCount || 0,
    }))
    .filter(t => t.user.toLowerCase() !== 'arielkallner' && t.text.length > 3)
    .slice(0, max);
}

// His own tweets ranked by engagement (excludes RTs).
async function getHisTweets(max = 10) {
  if (!_key()) return null;
  const j = await _retry('/twitter/user/last_tweets?userName=ArielKallner', d => !((d.data || {}).tweets || []).length);
  if (!j) return [];
  return ((j.data || {}).tweets || [])
    .map(t => ({
      text: (t.text || '').replace(/\s+/g, ' ').trim(), date: t.createdAt, url: t.url || '',
      likes: t.likeCount || 0, rts: t.retweetCount || 0, replies: t.replyCount || 0, views: t.viewCount || 0,
      isRT: /^RT @/.test(t.text || ''),
    }))
    .filter(t => !t.isRT)
    .slice(0, max);
}

function _fmtNum(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
function _fmtDate(iso) {
  try { return new Date(iso).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

// Full report — his recent POSTS (with engagement) + top mentions/replies.
// Two X requests (his tweets + mentions search), retried; no LLM.
async function buildXReport() {
  if (!_key()) return '🐦 *מודיעין X:* חסר מפתח twitterapi.io.';
  const [tweets, mentions] = await Promise.all([getHisTweets(8), getMentions(25)]);
  if ((!tweets || !tweets.length) && (!mentions || !mentions.length)) {
    return '🐦 *מודיעין X:* twitterapi.io לא החזיר נתונים כרגע — נסה שוב בעוד רגע.';
  }
  const d = new Date().toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
  let out = `🐦 *מודיעין X — קלנר* · ${d}`;

  // ── His own posts + engagement ──
  if (tweets && tweets.length) {
    const totalLikes = tweets.reduce((a, t) => a + t.likes, 0);
    const totalReplies = tweets.reduce((a, t) => a + t.replies, 0);
    out += `\n\n📢 *הפוסטים האחרונים שלך* (${tweets.length}) — סה״כ ❤️${_fmtNum(totalLikes)} · 💬${_fmtNum(totalReplies)} תגובות:\n`;
    out += tweets.slice(0, 5).map(t =>
      `• ${_fmtDate(t.date)} — ❤️${_fmtNum(t.likes)} 🔁${_fmtNum(t.rts)} 💬${_fmtNum(t.replies)}${t.views ? ` 👁${_fmtNum(t.views)}` : ''}\n  "${t.text.substring(0, 70)}"${t.url ? `\n  🔗 ${t.url}` : ''}`
    ).join('\n');
  }

  // ── Mentions / replies about him (ranked by engagement) ──
  if (mentions && mentions.length) {
    const ranked = [...mentions].sort((a, b) => (b.likes + b.rts * 2 + b.replies) - (a.likes + a.rts * 2 + a.replies)).slice(0, 6);
    out += `\n\n💬 *אזכורים/תגובות עליך* (${mentions.length} אחרונים · לפי מעורבות):\n`;
    out += ranked.map(m =>
      `• @${m.user} ❤️${_fmtNum(m.likes)} 🔁${_fmtNum(m.rts)} 💬${_fmtNum(m.replies)}\n  _"${m.text.substring(0, 85)}"_${m.url ? `\n  🔗 ${m.url}` : ''}`).join('\n');
    out += `\n\n_💡 לניסוח תגובה: "תגובה על <נושא>"_`;
  }
  return out.trim();
}

module.exports = { getMentions, getHisTweets, buildXReport };
