'use strict';
const { query } = require('@anthropic-ai/claude-agent-sdk');
const path = require('path');
const os = require('os');

const CWD = path.join(os.homedir(), 'OneDrive', 'שולחן העבודה');

/**
 * Run a Claude Code agent task via WhatsApp.
 * Has access to Read, Glob, Grep, Bash — can explore files, run commands, etc.
 * @param {string} prompt - what the user asked
 * @returns {Promise<string>}
 */
async function runClaudeCode(prompt) {
  let result = '';

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: CWD,
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 15,
        systemPrompt: `אתה עוזר אישי שמגיע דרך וואטסאפ.
ענה בעברית אלא אם ביקשו ממך אחרת.
היה תמציתי — זו הודעת וואטסאפ. שמור על תשובות קצרות.
אתה יכול לקרוא קבצים, לחפש בקוד, להריץ פקודות, לכתוב קבצים.
התיקייה הנוכחית היא שולחן העבודה של המשתמש.`,
      },
    })) {
      if ('result' in message) {
        result = message.result;
      }
    }
  } catch (err) {
    console.error('Claude Code error:', err.message);
    return '❌ שגיאה בהרצת Claude Code: ' + err.message;
  }

  if (!result) return '❌ לא התקבלה תשובה מ-Claude Code';

  // Trim for WhatsApp (max ~4000 chars)
  if (result.length > 4000) {
    result = result.substring(0, 3900) + '\n\n...(חתוך)';
  }

  return result;
}

module.exports = { runClaudeCode };
