'use strict';
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Search the web and return a summary
 */
async function webSearch(query) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `אתה עוזר אישי בוואטסאפ. חפש באינטרנט ותן תשובה תמציתית בעברית.
השתמש ב-*bold* לדגש. היה אנושי וחם. תן את המידע החשוב בלבד.`,
      tools: [
        { type: 'web_search_20250305', name: 'web_search' },
      ],
      messages: [{ role: 'user', content: query }],
    });

    const texts = response.content.filter(b => b.type === 'text').map(b => b.text);
    if (texts.length) return '🌐 ' + texts.join('\n\n');

    if (response.stop_reason === 'tool_use') {
      const messages = [
        { role: 'user', content: query },
        { role: 'assistant', content: response.content },
      ];
      const followup = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: `אתה עוזר אישי בוואטסאפ. סכם את תוצאות החיפוש בעברית. תמציתי ואנושי.`,
        tools: [
          { type: 'web_search_20250305', name: 'web_search' },
        ],
        messages,
      });
      const ft = followup.content.filter(b => b.type === 'text').map(b => b.text);
      return '🌐 ' + (ft.join('\n\n') || 'לא מצאתי תוצאות');
    }

    return '🌐 לא מצאתי תוצאות, נסה לנסח אחרת';
  } catch (err) {
    console.error('Web search error:', err.message);
    return '❌ שגיאה בחיפוש: ' + err.message.substring(0, 100);
  }
}

/**
 * Fetch a URL — use web_search with site-specific query
 */
async function webFetch(url, question) {
  try {
    const query = question
      ? `site:${url} ${question}`
      : `תסכם את התוכן מ: ${url}`;

    return await webSearch(query);
  } catch (err) {
    return '❌ שגיאה: ' + err.message.substring(0, 100);
  }
}

module.exports = { webSearch, webFetch };
