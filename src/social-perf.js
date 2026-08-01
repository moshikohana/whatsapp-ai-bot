'use strict';
/**
 * Cross-platform performance / virality dashboard for Kellner.
 * Pulls his recent posts + engagement from every platform we can read —
 * X (twitterapi.io), TikTok (yt-dlp), Telegram (views+reactions), YouTube
 * (Data API) — and answers: what's the most viral post, and which platform
 * performs best. Views are the common "virality" currency.
 */

const logger = require('./logger');

function _getJson(url) {
  return new Promise((resolve) => {
    require('https').get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null)).setTimeout(20000, function () { this.destroy(); resolve(null); });
  });
}

// ── X / Twitter ──
async function getXPosts(max = 8) {
  try {
    const t = await require('./twitter-intel').getHisTweets(max);
    return (t || []).map(x => ({ platform: '🐦 X', text: x.text, views: x.views || 0, likes: x.likes || 0, comments: x.replies || 0, rts: x.rts || 0, url: x.url || '', date: x.date }));
  } catch { return []; }
}

// ── TikTok (yt-dlp) ──
function getTikTokPosts(max = 5) {
  return new Promise((resolve) => {
    try {
      require('child_process').execFile('/usr/local/bin/yt-dlp',
        ['--playlist-end', String(max), '--dump-json', '--no-warnings', 'https://www.tiktok.com/@ariel.kallner'],
        { timeout: 90000, maxBuffer: 30 * 1024 * 1024 }, (err, stdout) => {
          if (!stdout) return resolve([]);
          const out = [];
          for (const line of stdout.split('\n')) {
            if (!line.trim()) continue;
            try {
              const d = JSON.parse(line);
              out.push({ platform: '⚫ TikTok', text: (d.title || '').replace(/\s+/g, ' '), views: d.view_count || 0, likes: d.like_count || 0, comments: d.comment_count || 0, url: d.webpage_url || '', date: d.timestamp ? new Date(d.timestamp * 1000).toISOString() : null });
            } catch {}
          }
          resolve(out);
        });
    } catch { resolve([]); }
  });
}

// ── Telegram (views + reactions) ──
async function getTelegramPosts(max = 8) {
  try {
    const tg = require('./telegram');
    if (!tg.isConfigured || !tg.isConfigured()) return [];
    const c = await tg.getClient();
    const ent = await c.getEntity('Kallner');
    const msgs = await c.getMessages(ent, { limit: max * 2 });
    return msgs.filter(m => m.message && m.message.trim()).slice(0, max).map(m => {
      let reactions = 0;
      try { for (const r of ((m.reactions && m.reactions.results) || [])) reactions += r.count || 0; } catch {}
      return { platform: '🔵 טלגרם', text: m.message.replace(/\s+/g, ' '), views: m.views || 0, likes: reactions, comments: 0, forwards: m.forwards || 0, url: `https://t.me/Kallner/${m.id}`, date: m.date ? new Date(m.date * 1000).toISOString() : null };
    });
  } catch (e) { logger.warn?.('getTelegramPosts: ' + e.message); return []; }
}

// ── YouTube (his channel videos + statistics) ──
async function getYouTubePosts(max = 5) {
  const key = process.env.YOUTUBE_API_KEY; if (!key) return [];
  try {
    const s = await _getJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent('אריאל קלנר')}&type=video&order=date&maxResults=20&key=${key}`);
    const mine = ((s && s.items) || []).filter(i => /ariel\s*kall?ner|אריאל\s*קלנר/i.test((i.snippet || {}).channelTitle || '') && i.id && i.id.videoId).slice(0, max);
    if (!mine.length) return [];
    const ids = mine.map(i => i.id.videoId).join(',');
    const v = await _getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids}&key=${key}`);
    return ((v && v.items) || []).map(it => ({
      platform: '▶️ יוטיוב', text: it.snippet.title || '', views: +(it.statistics.viewCount || 0), likes: +(it.statistics.likeCount || 0), comments: +(it.statistics.commentCount || 0),
      url: `https://youtube.com/watch?v=${it.id}`, date: it.snippet.publishedAt,
    }));
  } catch { return []; }
}

function _fmt(n) { n = n || 0; if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'; return String(n); }

async function buildPerformanceReport() {
  const [x, tt, tg, yt] = await Promise.all([
    getXPosts(8).catch(() => []), getTikTokPosts(5).catch(() => []),
    getTelegramPosts(8).catch(() => []), getYouTubePosts(5).catch(() => []),
  ]);
  const all = [...(x || []), ...(tt || []), ...(tg || []), ...(yt || [])].filter(p => p && (p.views || p.likes));
  if (!all.length) return '📊 *ביצועי רשתות:* לא הצלחתי למשוך נתונים כרגע — נסה שוב בעוד רגע.';

  const d = new Date().toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
  let out = `📊 *ביצועי רשתות — קלנר* · ${d}`;

  // Most viral overall (by views)
  const viral = [...all].filter(p => p.views).sort((a, b) => b.views - a.views)[0];
  if (viral) {
    out += `\n\n🔥 *הכי ויראלי (בכל הרשתות):*\n${viral.platform} — 👁${_fmt(viral.views)} ❤️${_fmt(viral.likes)}\n"${viral.text.substring(0, 75)}"${viral.url ? `\n🔗 ${viral.url}` : ''}`;
  }

  // Top post per platform + platform totals
  const byPlat = {};
  for (const p of all) (byPlat[p.platform] = byPlat[p.platform] || []).push(p);
  out += `\n\n📈 *הפוסט המוביל בכל פלטפורמה:*`;
  const platTotals = [];
  for (const [plat, posts] of Object.entries(byPlat)) {
    const top = [...posts].sort((a, b) => (b.views || b.likes) - (a.views || a.likes))[0];
    const totalViews = posts.reduce((a, p) => a + (p.views || 0), 0);
    const totalLikes = posts.reduce((a, p) => a + (p.likes || 0), 0);
    platTotals.push({ plat, totalViews, totalLikes, count: posts.length });
    out += `\n\n${plat} — 👁${_fmt(top.views)} ❤️${_fmt(top.likes)}${top.comments ? ` 💬${_fmt(top.comments)}` : ''}\n_"${top.text.substring(0, 65)}"_`;
  }

  // Platform comparison (by total views, then likes)
  platTotals.sort((a, b) => (b.totalViews - a.totalViews) || (b.totalLikes - a.totalLikes));
  out += `\n\n🏆 *השוואת פלטפורמות (סה״כ ${platTotals.reduce((a, p) => a + p.count, 0)} פוסטים אחרונים):*\n`;
  out += platTotals.map((p, i) => `${i + 1}. ${p.plat} — 👁${_fmt(p.totalViews)} · ❤️${_fmt(p.totalLikes)} (${p.count} פוסטים)`).join('\n');
  if (platTotals[0]) out += `\n\n💡 *הרשת החזקה שלך:* ${platTotals[0].plat.replace(/^[^ ]+ /, '')} — שם התוכן שלך מקבל הכי הרבה חשיפה.`;
  return out.trim();
}

module.exports = { buildPerformanceReport, getXPosts, getTikTokPosts, getTelegramPosts, getYouTubePosts };
