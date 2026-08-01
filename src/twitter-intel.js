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

// Lean report — ONE X request (mentions search), ranked by engagement, links
// only. No his-tweets endpoint, no LLM → minimal twitterapi.io credit use.
async function buildXReport() {
  if (!_key()) return '🐦 *מודיעין X:* חסר מפתח twitterapi.io.';
  const mentions = await getMentions(25); // single advanced_search (with retry)
  if (!mentions || !mentions.length) {
    return '🐦 *מודיעין X:* twitterapi.io לא החזיר נתונים כרגע — נסה שוב בעוד רגע.';
  }
  const d = new Date().toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
  const ranked = [...mentions].sort((a, b) => (b.likes + b.rts * 2 + b.replies) - (a.likes + a.rts * 2 + a.replies)).slice(0, 7);
  let out = `🐦 *מודיעין X — אזכורים בולטים על קלנר* · ${d}\n`;
  out += `_(${mentions.length} אזכורים אחרונים · מדורגים לפי מעורבות)_\n\n`;
  out += ranked.map(m =>
    `• @${m.user} ❤️${m.likes} 🔁${m.rts} 💬${m.replies}\n  _"${m.text.substring(0, 90)}"_${m.url ? `\n  🔗 ${m.url}` : ''}`).join('\n\n');
  out += `\n\n_💡 לניסוח תגובה לאחד מהם: "תגובה על <נושא>"_`;
  return out.trim();
}

module.exports = { getMentions, getHisTweets, buildXReport };
