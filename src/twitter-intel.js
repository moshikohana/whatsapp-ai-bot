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
async function _retry(path, isEmpty, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const j = await _once(path);
    if (j && !isEmpty(j)) return j;
    await new Promise(r => setTimeout(r, 1200));
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

// Classify the mentions (sentiment + notable + attacks) via Claude JSON.
async function _classifyMentions(mentions) {
  if (!mentions.length) return null;
  const { classifyJSON } = require('./claude');
  const list = mentions.map((m, i) => `${i + 1}. @${m.user} (❤️${m.likes}): ${m.text.substring(0, 200)}`).join('\n');
  const prompt =
`לפניך תגובות/אזכורים ב-X על ח"כ אריאל קלנר (הליכוד). נתח. החזר JSON בלבד:
{
  "pro": <n>, "anti": <n>, "neutral": <n>,
  "notable": [ { "idx": <מספר הפריט>, "stance": "<pro|anti|neutral>", "why": "<שורה קצרה: למה בולט/משפיע>" } ],
  "attacks": [ { "idx": <מספר>, "summary": "<מתקפה שדורשת תגובה — שורה>" } ]
}
- notable: עד 5 (בולטים/משפיעים/ויראליים).
- attacks: עד 4 מתקפות אמיתיות שדורשות שקילת תגובה. עברית.

התגובות:
${list}`;
  return await classifyJSON(prompt, { maxTokens: 1500 });
}

async function buildXReport() {
  if (!_key()) return '🐦 *מודיעין X:* חסר מפתח twitterapi.io.';
  const [mentions, tweets] = await Promise.all([getMentions(30), getHisTweets(10)]);
  if ((!mentions || !mentions.length) && (!tweets || !tweets.length)) {
    return '🐦 *מודיעין X:* twitterapi.io לא החזיר נתונים כרגע (נסה שוב בעוד רגע — הסקרייפינג שלהם לא יציב).';
  }
  const d = new Date().toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
  let out = `🐦 *מודיעין X — קלנר* · ${d}`;

  // His top-performing tweets
  if (tweets && tweets.length) {
    const top = [...tweets].sort((a, b) => (b.likes + b.rts * 2) - (a.likes + a.rts * 2)).slice(0, 3);
    out += `\n\n📢 *הציוצים שלך שהכי עובדים:*\n` + top.map(t =>
      `• ❤️${t.likes} 🔁${t.rts} 💬${t.replies} — "${t.text.substring(0, 70)}"`).join('\n');
  }

  // Mentions + sentiment
  if (mentions && mentions.length) {
    const cls = await _classifyMentions(mentions).catch(() => null);
    if (cls) {
      out += `\n\n💬 *תגובות/אזכורים (${mentions.length}):* 🟢 ${cls.pro || 0} · 🔴 ${cls.anti || 0} · ⚪ ${cls.neutral || 0}`;
      const notable = (cls.notable || []).slice(0, 5);
      if (notable.length) {
        out += `\n\n🔎 *בולטים:*\n` + notable.map(n => {
          const m = mentions[(n.idx || 0) - 1]; if (!m) return null;
          const icon = n.stance === 'pro' ? '🟢' : n.stance === 'anti' ? '🔴' : '⚪';
          return `${icon} @${m.user} (❤️${m.likes}) — ${n.why}\n   _"${m.text.substring(0, 80)}"_${m.url ? `\n   🔗 ${m.url}` : ''}`;
        }).filter(Boolean).join('\n');
      }
      const attacks = (cls.attacks || []).slice(0, 4);
      if (attacks.length) {
        out += `\n\n⚠️ *דורש שקילת תגובה:*\n` + attacks.map(a => {
          const m = mentions[(a.idx || 0) - 1];
          return `• ${a.summary}${m ? ` (@${m.user})` : ''}`;
        }).join('\n');
        out += `\n\n_💡 לניסוח תגובה: "תגובה על <נושא>"_`;
      }
    } else {
      out += `\n\n💬 *${mentions.length} אזכורים אחרונים:*\n` + mentions.slice(0, 6).map(m =>
        `• @${m.user} (❤️${m.likes}): "${m.text.substring(0, 70)}"`).join('\n');
    }
  }
  return out.trim();
}

module.exports = { getMentions, getHisTweets, buildXReport };
