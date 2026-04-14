'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const { getMemoriesForPrompt, getContextForPrompt, getFailedToolsNote, markToolFailed } = require('./memory');
const logger = require('./logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BASE_SYSTEM_PROMPT = `אתה "בוטי" — חבר טוב של מושיקו בוואטסאפ. חם, ישיר, סלנג ישראלי, אימוג'ים בטבעיות. תענה קצר. פורמט: *bold* _italic_ • רשימות.

כלים: כשמבקשים — פשוט תעשה, בלי לשאול. תציג תוצאות מלאות מכלים, לא סיכום. אם תשובה מעל 30 שורות — שאל לפני.
זיכרון: שמור (save_memory) כשמתקנים/מלמדים/מספרים על עצמם. קטגוריות: תיקון, העדפה, מידע_אישי, הנחיה, כללי.
אישור: לפני שליחת/מחיקת מייל, מחיקת אירוע, הרצת פקודה, שליחת וואטסאפ, תזמון שליחה — שאל "לבצע? ✅/❌". קריאה בלבד — בלי אישור.
כלים שנכשלו — אל תציע שוב.

🌐 חיפוש אינטרנט — כללים חשובים:
• כשמחפשים אדם (כמו ח"כ קלנר) — חפש גם ברשתות חברתיות: הוסף "twitter" או "X" או "אינסטגרם" או "פייסבוק" בשאילתה
• תמיד ציין תאריך מדויק מהמקור. אם אין תאריך — כתוב "ללא תאריך"
• אל תמציא תאריכים או עובדות שלא מופיעות בתוצאות החיפוש
• הצג קישורים מלאים למקורות
• אם לא מצאת מידע רלוונטי — אמור בכנות שלא מצאת, אל תמציא

🔍 *חיפוש ברשתות חברתיות (X / Facebook):*
• כשמבקשים לחפש ברשתות — בצע מספר חיפושים עם web_search:
  - "[נושא] site:x.com" — חיפוש בטוויטר/X
  - "[נושא] site:facebook.com" — חיפוש בפייסבוק
  - "[נושא] twitter" — חיפוש כללי על ציוצים
• הצג: שם מפרסם, תוכן הפוסט, תאריך, קישור מלא
• אם לא נמצאו תוצאות מ-site: — נסה חיפוש כללי עם שם הרשת

📡 *פנייה לתקשורת (media pitch):*
כשמושיקו אומר "פנייה לתקשורת" / "תפנה לתקשורת" / "תשלח לכתבים":
1. השתמש בכלי spokesperson (action: context) לשליפת עמדות, אנשי קשר ותבניות של ח"כ קלנר
2. חפש חדשות רלוונטיות (web_search) — נושאים חמים היום
3. נסח פנייה מותאמת לכל איש קשר — לפי סוג התוכנית שלו
4. הצג את כל הפניות למושיקו לאישור אחד
5. אחרי אישור — שלח כל פנייה בוואטסאפ (whatsapp send)

📢 *תגובה/דוברות (quick response):*
כשמושיקו אומר "תגובה על X" / "תנסח תגובה" / "הודעה לעיתונאים":
1. השתמש בכלי spokesperson (action: response, topic: X) לשליפת עמדות רלוונטיות
2. חפש רקע על הנושא (web_search) אם צריך
3. נסח תגובה בסגנון קלנר: ישיר, חד, לאומי, מבוסס על הישגי החקיקה האמיתיים שלו
4. פורמט: "ח"כ אריאל קלנר (ליכוד): [ציטוט]"
5. הצג למושיקו לאישור. אל תמציא עובדות — רק מהזיכרון ומחיפוש

📋 *היכולות המלאות שלך (יש לך גישה לכל אלה!):*
• 📅 יומן Google — צפייה, הוספה (כולל אירועים חוזרים!), חיפוש, מחיקת אירועים
• 📧 Gmail — קריאה, שליחה, תשובה, מחיקה, כוכב, חיפוש, סטטיסטיקות
• 📇 אנשי קשר Google — חיפוש, רשימה, פרטים מלאים (טלפון, מייל, כתובת, יום הולדת)
• 📲 שליחת וואטסאפ — שלח הודעה לכל מספר/איש קשר (עם אישור)
• 💬 קריאת שיחות וואטסאפ — רשימת שיחות, קריאת הודעות, חיפוש הודעות, סיכום קבוצות, העברת הודעות. קריאה — בלי אישור. שליחה/העברה — עם אישור!
• 📋 סקירה יומית — סכם הודעות מקבוצות וואטסאפ. אפשר לתזמן סקירה יומית אוטומטית כל בוקר
• 📡 סקירת תקשורת בוקר — חדשות על קלנר + רשתות חברתיות + קבוצות וואטסאפ + המלצות פעולה. תזמן עם schedule daily media_briefing
• 🔄 תזמון יומי חוזר — משימות שחוזרות כל יום (סקירת קבוצות, שליחת הודעות, סקירת תקשורת)
• ⏰ תזמון שליחה — תזמן הודעת וואטסאפ או מייל לשליחה אוטומטית בעוד X דקות (1 דקה עד 24 שעות). אפשר לראות/לבטל תזמונים
• 🌐 חיפוש אינטרנט — חפש כל מידע באינטרנט
• 🎬 יצירת סרטונים — צור סרטונים מקצועיים עם אנימציות! 3 תבניות:
  - text: כותרת+טקסט, פורמט סטורי 1080x1920, אנימציות spring+fade
  - quote: ציטוט מעוצב, ריבועי 1080x1080, אנימציות zoom+גרשיים
  - slideshow: מצגת שקפים, סטורי 1080x1920, פס התקדמות+מעברים
  צבעים, אורך, טקסט — הכל ניתן להתאמה. הסרטון נשלח כוידאו בוואטסאפ
• 💻 מחשב — מידע מערכת, קבצים, סוללה, רשת, תהליכים, הרצת פקודות
• 🖼️ תמונות — שלח תמונה ואנתח אותה
• 🎤 הודעות קוליות — תמלול עם Whisper (עברית מלא) + מגיב עם כל הכלים
• 🧠 זיכרון — שמור/מחק/הצג זיכרונות קבועים
• 📡 דוברות ח"כ קלנר — שליפת עמדות והישגים, יצירת פניות לתקשורת, ניסוח תגובות דוברות
• 📄 קבצים — שלח קובץ (PDF, Word, טקסט) ואעבד אותו
• 🎙️ הקלטות שיחות — שלח הקלטת שיחת טלפון (m4a, mp3, wav, ogg) ואתמלל + אחלץ משימות, אירועי יומן ותזכורות אוטומטית
• 📷 סינון תמונות מקבוצות — זיהוי פנים! שלח תמונות ייחוס (כיתוב "ייחוס [שם]") והבוט יזהה ויעביר תמונות מתאימות מקבוצות מנוטרות. ניהול: photo_filter tool

🎙️ *הקלטות שיחות טלפון:*
כשמקבלים הקלטת שיחה (קובץ אודיו):
1. סכם את השיחה — מי דיבר, על מה, מה סוכם
2. חלץ כל משימה/פעולה נדרשת עם אחראי ודדליין
3. אם נקבעו פגישות — הוסף ליומן (calendar add) אוטומטית
4. אם יש דדליינים — הצע תזכורת (schedule once)
5. שמור פרטים חשובים בזיכרון (memory save)
• אם המשתמש שלח כיתוב (caption) עם ההקלטה — עקוב אחרי הבקשה שלו
• פורמט: סיכום → משימות → פעולות שבוצעו (אירועי יומן/תזכורות)
• בהקשר של דוברות — שים לב לפרטי ראיונות, שמות עיתונאים, מועדים שסוכמו`;


function getSystemPrompt() {
  const now = new Date();
  const today = now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

  let prompt = BASE_SYSTEM_PROMPT;
  prompt += `\n\n📅 היום: ${today}, השעה: ${time}`;
  prompt += getMemoriesForPrompt();
  prompt += getContextForPrompt();
  prompt += getFailedToolsNote();
  return prompt;
}

const TOOLS = [
  // ─── Calendar (unified) ─────────────────────────────────────────
  {
    name: 'calendar',
    description: 'יומן Google. פעולות: today (מה יש היום), week (השבוע), events (אירועים לפי ימים), add (הוסף אירוע — תומך גם באירועים חוזרים!), search (חפש), delete (מחק).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['today', 'week', 'events', 'add', 'search', 'delete'] },
        days: { type: 'number', description: 'ימים קדימה (events)' },
        event_text: { type: 'string', description: 'תיאור אירוע (add)' },
        recurrence: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', 'weekdays', 'custom'], description: 'חזרה (add). weekdays=א-ה' },
        recurrence_days: { type: 'array', items: { type: 'string', enum: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] }, description: 'ימים ספציפיים (custom). SU=ראשון..SA=שבת' },
        recurrence_count: { type: 'number', description: 'כמה פעמים לחזור (ברירת: ללא הגבלה)' },
        recurrence_until: { type: 'string', description: 'תאריך סיום חזרה YYYY-MM-DD' },
        query: { type: 'string', description: 'חיפוש (search)' },
        index: { type: 'number', description: 'מספר אירוע (delete)' },
      },
      required: ['action'],
    },
  },
  // ─── Gmail (unified) ──────────────────────────────────────────
  {
    name: 'gmail',
    description: 'Gmail. פעולות: unread (שלא נקראו), search (חפש), read (קרא מייל), reply (השב), send (שלח), mark_read, trash, star, stats.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['unread', 'search', 'read', 'reply', 'send', 'mark_read', 'trash', 'star', 'stats'] },
        index: { type: 'number', description: 'מספר מייל' },
        query: { type: 'string', description: 'חיפוש' },
        to: { type: 'string', description: 'כתובת (send)' },
        subject: { type: 'string', description: 'נושא (send)' },
        body: { type: 'string', description: 'תוכן (send/reply)' },
      },
      required: ['action'],
    },
  },
  // ─── Web search ───────────────────────────────────────────────
  { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
  // ─── Computer (unified) ───────────────────────────────────────
  {
    name: 'computer',
    description: 'מחשב. פעולות: info (מידע מערכת), files (קבצים), read_file, search_files, run (פקודה), battery, wifi, processes.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['info', 'files', 'read_file', 'search_files', 'run', 'battery', 'wifi', 'processes'] },
        directory: { type: 'string', description: 'תיקייה (files)' },
        filename: { type: 'string', description: 'שם קובץ (read_file)' },
        query: { type: 'string', description: 'חיפוש (search_files)' },
        command: { type: 'string', description: 'פקודה (run)' },
      },
      required: ['action'],
    },
  },
  // ─── WhatsApp ─────────────────────────────────────────────────
  {
    name: 'whatsapp',
    description: 'וואטסאפ. פעולות: send (שלח הודעה — אישור!), chats (רשימת שיחות), read (קרא שיחה), search (חפש הודעות), summarize (סכם קבוצה), forward (העבר הודעה — אישור!).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['send', 'chats', 'read', 'search', 'summarize', 'forward'] },
        phone: { type: 'string', description: 'מספר טלפון (send)' },
        message: { type: 'string', description: 'תוכן (send)' },
        chatName: { type: 'string', description: 'שם שיחה (read/search/summarize/forward)' },
        query: { type: 'string', description: 'חיפוש (search)' },
        limit: { type: 'number', description: 'כמה להציג' },
        toPhone: { type: 'string', description: 'יעד (forward)' },
        messageIndex: { type: 'number', description: 'מספר הודעה (forward, 1=אחרונה)' },
      },
      required: ['action'],
    },
  },
  // ─── Contacts (unified) ───────────────────────────────────────
  {
    name: 'contacts',
    description: 'אנשי קשר Google. פעולות: search (חפש), list (רשימה), details (פרטים מלאים).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'list', 'details'] },
        query: { type: 'string', description: 'שם (search/details)' },
      },
      required: ['action'],
    },
  },
  // ─── Memory ───────────────────────────────────────────────────
  {
    name: 'memory',
    description: 'זיכרון. פעולות: save (שמור), delete (מחק), list (הצג). חובה: כשמתקנים/מלמדים/מספרים על עצמם.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'delete', 'list'] },
        text: { type: 'string', description: 'מה לזכור (save)' },
        category: { type: 'string', enum: ['תיקון', 'העדפה', 'מידע_אישי', 'הנחיה', 'כללי'], description: 'קטגוריה (save)' },
        index: { type: 'number', description: 'מספר זיכרון (delete)' },
      },
      required: ['action'],
    },
  },
  // ─── Scheduling (unified) ─────────────────────────────────────
  {
    name: 'schedule',
    description: 'תזמון. פעולות: once (חד-פעמי), daily (יומי חוזר), list (הצג), list_daily, cancel (בטל חד-פעמי), cancel_daily.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['once', 'daily', 'list', 'list_daily', 'cancel', 'cancel_daily'] },
        type: { type: 'string', enum: ['whatsapp', 'email'], description: 'סוג (once)' },
        delay_minutes: { type: 'number', description: 'דקות (once)' },
        target: { type: 'string', description: 'יעד' },
        message: { type: 'string', description: 'תוכן' },
        subject: { type: 'string', description: 'נושא מייל' },
        time: { type: 'string', description: 'שעה HH:MM (daily)' },
        daily_action: { type: 'string', enum: ['group_summary', 'send_message', 'media_briefing'], description: 'פעולה יומית. media_briefing=סקירת תקשורת בוקר' },
        params: { type: 'object', description: 'פרמטרים (daily). media_briefing: {topics:[...], groups:[...]}' },
        label: { type: 'string', description: 'תיאור' },
        id: { type: 'number', description: 'מספר לביטול' },
      },
      required: ['action'],
    },
  },
  // ─── Video ────────────────────────────────────────────────────
  {
    name: 'video',
    description: 'סרטונים. פעולות: create (צור), templates (הצג תבניות). תבניות: text (כותרת סטורי), quote (ציטוט ריבועי), slideshow (מצגת).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'templates'] },
        template: { type: 'string', enum: ['text', 'quote', 'slideshow'] },
        props: { type: 'object', description: 'text:{title,subtitle,body}. quote:{quote,author}. slideshow:{slides:[{title,text}]}. צבעים: bgColor,textColor,accentColor' },
        durationSec: { type: 'number', description: 'אורך בשניות' },
      },
      required: ['action'],
    },
  },
  // ─── Photo Filter / זיהוי פנים ───────────────────────────────
  {
    name: 'photo_filter',
    description: 'סינון תמונות מקבוצות לפי זיהוי פנים. פעולות: status (מצב), add_group (הוסף קבוצה למעקב), remove_group (הסר), set_threshold (רגישות), clear_references (מחק ייחוסים), toggle (הפעל/כבה סינון), toggle_blur (הפעל/כבה טשטוש פנים אחרות).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'add_group', 'remove_group', 'set_threshold', 'clear_references', 'toggle', 'toggle_blur'] },
        group_name: { type: 'string', description: 'שם קבוצה (add_group/remove_group)' },
        threshold: { type: 'number', description: 'סף 0.1-0.8 (set_threshold). נמוך=קפדן 0.3, גבוה=מתירני 0.6. ברירת: 0.45' },
        name: { type: 'string', description: 'שם (clear_references). ריק=מחק הכל' },
        enabled: { type: 'boolean', description: 'הפעל/כבה (toggle)' },
      },
      required: ['action'],
    },
  },
  // ─── Spokesperson / דוברות ───────────────────────────────────
  {
    name: 'spokesperson',
    description: 'דוברות ח"כ קלנר. פעולות: context (שלוף עמדות+הישגים+אנשי קשר תקשורת), response (עמדות רלוונטיות לנושא ספציפי לניסוח תגובה), pitch (הקשר+תבנית לפנייה לתקשורת).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['context', 'response', 'pitch'] },
        topic: { type: 'string', description: 'נושא (response/pitch)' },
        target_outlet: { type: 'string', description: 'שם ערוץ/תוכנית (pitch)' },
      },
      required: ['action'],
    },
  },
];

// ─── Tool executor ───────────────────────────────────────────────
let toolHandlers = null;

function registerToolHandlers(handlers) {
  toolHandlers = handlers;
}

async function executeTool(name, input) {
  if (!toolHandlers) throw new Error('Tool handlers not registered');
  const handler = toolHandlers[name];
  if (!handler) return `כלי "${name}" לא זמין`;
  const toolStart = Date.now();
  try {
    const result = await handler(input);
    const toolDuration = Date.now() - toolStart;
    logger.perfTool(name, toolDuration, true);
    console.log(`✅ Tool ${name} (${toolDuration}ms):`, typeof result === 'string' ? result.substring(0, 200) : JSON.stringify(result).substring(0, 200));
    return result;
  } catch (err) {
    const toolDuration = Date.now() - toolStart;
    logger.perfTool(name, toolDuration, false);
    const errMsg = err.message || err.toString?.() || JSON.stringify(err);
    logger.error(`❌ Tool error (${name}):`, errMsg);
    if (err.stack) logger.debug(`Stack (${name}):`, err.stack);
    markToolFailed(name);
    return `❌ שגיאה בכלי ${name}: ${errMsg}`;
  }
}

// ─── Unicode-safe string truncation ─────────────────────────────
function safeTruncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  // Use Array.from to split by code points (not code units) — avoids breaking emoji surrogate pairs
  const chars = Array.from(str);
  if (chars.length <= maxLen) return str;
  return chars.slice(0, maxLen).join('') + '...';
}

// ─── Trim history to reduce tokens ──────────────────────────────
function trimHistory(history) {
  if (!Array.isArray(history)) return [];

  // 1. Filter out invalid entries
  const cleaned = history.filter(msg => {
    if (!msg || typeof msg !== 'object') return false;
    if (!msg.role || !['user', 'assistant'].includes(msg.role)) return false;
    if (msg.content === null || msg.content === undefined) return false;
    // String content must not be empty
    if (typeof msg.content === 'string' && msg.content.trim() === '') return false;
    return true;
  });

  // 2. Ensure role alternation (user, assistant, user, assistant...)
  const alternated = [];
  for (const msg of cleaned) {
    const lastRole = alternated.length > 0 ? alternated[alternated.length - 1].role : null;
    if (msg.role === lastRole) {
      // Same role twice — replace the previous one (keep latest)
      alternated[alternated.length - 1] = msg;
    } else {
      alternated.push(msg);
    }
  }

  // 3. Must start with 'user' message
  while (alternated.length > 0 && alternated[0].role !== 'user') {
    alternated.shift();
  }

  // 4. Trim content safely
  return alternated.map(msg => {
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content
          .filter(block => block && typeof block === 'object')
          .map(block => {
            if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 400) {
              return { ...block, content: safeTruncate(block.content, 400) };
            }
            return block;
          }),
      };
    }
    // Trim long assistant text messages
    if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > 600) {
      return { ...msg, content: safeTruncate(msg.content, 600) };
    }
    return msg;
  });
}

// ─── Daily usage tracking ───────────────────────────────────────
const usageTracker = {
  date: new Date().toISOString().slice(0, 10),
  inputTokens: 0,
  outputTokens: 0,
  apiCalls: 0,
  dailyLimit: 500000, // ~$1.50/day safety net
  warned: false,
};

function trackUsage(inputTokens, outputTokens) {
  const today = new Date().toISOString().slice(0, 10);
  if (usageTracker.date !== today) {
    usageTracker.date = today;
    usageTracker.inputTokens = 0;
    usageTracker.outputTokens = 0;
    usageTracker.apiCalls = 0;
    usageTracker.warned = false;
  }
  usageTracker.inputTokens += (inputTokens || 0);
  usageTracker.outputTokens += (outputTokens || 0);
  usageTracker.apiCalls++;
}

function getUsageSummary() {
  const costEstimate = ((usageTracker.inputTokens * 3 + usageTracker.outputTokens * 15) / 1000000).toFixed(3);
  return {
    date: usageTracker.date,
    apiCalls: usageTracker.apiCalls,
    inputTokens: usageTracker.inputTokens,
    outputTokens: usageTracker.outputTokens,
    estimatedCost: `$${costEstimate}`,
    percentUsed: Math.round((usageTracker.inputTokens / usageTracker.dailyLimit) * 100),
  };
}

function isOverBudget() {
  return usageTracker.inputTokens >= usageTracker.dailyLimit;
}

// ─── API call with retry + cooldown ─────────────────────────────
let lastCallTime = 0;
const MIN_INTERVAL = 3000; // 3s between API calls

async function callClaude(params, retries = 2) {
  // Enforce minimum interval between calls
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_INTERVAL - elapsed));
  }

  const hasWebSearch = params.tools?.some(t => t.type === 'web_search_20250305');
  // Timeout: 90s for web search, 45s for regular
  const timeoutMs = hasWebSearch ? 90000 : 45000;
  // Don't retry web search timeouts — just fail fast
  const maxRetries = hasWebSearch ? 0 : retries;

  for (let i = 0; i <= maxRetries; i++) {
    try {
      lastCallTime = Date.now();
      const apiStart = Date.now();
      console.log(`📡 API call (timeout: ${timeoutMs / 1000}s, attempt ${i + 1}/${maxRetries + 1})...`);
      const result = await Promise.race([
        anthropic.messages.create(params),
        new Promise((_, reject) => setTimeout(() => reject(new Error('API timeout')), timeoutMs)),
      ]);
      const apiDuration = Date.now() - apiStart;
      logger.perf(apiDuration, params.model);
      trackUsage(result.usage?.input_tokens, result.usage?.output_tokens);
      const usage = getUsageSummary();
      console.log(`✅ API response (${apiDuration}ms, stop: ${result.stop_reason}, tokens: ${result.usage?.input_tokens}→${result.usage?.output_tokens}) [daily: ${usage.apiCalls} calls, ${usage.estimatedCost}, ${usage.percentUsed}%]`);
      return result;
    } catch (err) {
      if (err.message === 'API timeout') {
        console.error(`⏳ API timeout after ${timeoutMs / 1000}s (attempt ${i + 1}/${maxRetries + 1})`);
        if (i < maxRetries) continue;
        throw err;
      }
      if (err.status === 429 && i < maxRetries) {
        const wait = (i + 1) * 20000;
        console.log(`⏳ Rate limit, waiting ${wait / 1000}s... (retry ${i + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error(`❌ API error (${err.status || 'unknown'}): ${err.message}`);
      // Log request details on 400 errors for debugging
      if (err.status === 400) {
        const msgSummary = params.messages?.map(m => {
          const contentType = Array.isArray(m.content) ? `array[${m.content.length}]` : typeof m.content;
          const contentLen = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
          return `${m.role}(${contentType},${contentLen})`;
        }).join(' → ') || 'no messages';
        console.error(`🔍 400 debug — messages: ${msgSummary}`);
        console.error(`🔍 400 debug — error body: ${JSON.stringify(err.error || err.body || err.message).substring(0, 500)}`);
      }
      throw err;
    }
  }
}

// ─── Smart Claude (with tools) ───────────────────────────────────
async function smartChat(userMessage, history = []) {
  // Global timeout: 2 minutes max for the entire smartChat call
  const GLOBAL_TIMEOUT = 120000;
  const startTime = Date.now();

  try {
  // Budget warning
  if (isOverBudget()) {
    const usage = getUsageSummary();
    logger.warn(`⚠️ Daily budget exceeded: ${usage.estimatedCost}`);
    return `💳 אחי, עברנו את תקציב ה-API היומי (${usage.estimatedCost}, ${usage.apiCalls} קריאות). ממשיך לעבוד אבל שים לב לצריכה.`;
  }
  const trimmed = trimHistory(history);
  const messages = [...trimmed, { role: 'user', content: userMessage }];

  let response = await callClaude({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: getSystemPrompt(),
    tools: TOOLS,
    messages,
  });

  // Tool use loop — Claude might call multiple tools
  const allMessages = [...messages];
  let maxLoops = 8;

  while (response.stop_reason === 'tool_use' && maxLoops-- > 0) {
    // Check global timeout
    if (Date.now() - startTime > GLOBAL_TIMEOUT) {
      console.error('⚠️ smartChat global timeout exceeded');
      const partialText = response.content.find(b => b.type === 'text');
      return partialText ? partialText.text.trim() : '⏳ הבקשה לקחה יותר מדי זמן. נסה שוב.';
    }

    const toolBlocks = response.content.filter(b => b.type === 'tool_use');
    allMessages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const tool of toolBlocks) {
      console.log(`🔧 Tool: ${tool.name}`, JSON.stringify(tool.input));
      const result = await executeTool(tool.name, tool.input);
      // Ensure content is always a valid non-empty string
      let content = typeof result === 'string' ? result : JSON.stringify(result ?? null);
      if (!content || content === 'undefined' || content === 'null') {
        content = '(אין תוצאה)';
      }
      // Cap individual tool results to avoid oversized requests
      if (content.length > 8000) {
        content = safeTruncate(content, 8000) + '\n...(תוצאה קוצרה)';
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tool.id,
        content,
      });
    }

    allMessages.push({ role: 'user', content: toolResults });

    response = await callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: getSystemPrompt(),
      tools: TOOLS,
      messages: allMessages,
    });
  }

  // Log all content block types for debugging
  const blockTypes = response.content.map(b => b.type);
  console.log(`📦 Response blocks: [${blockTypes.join(', ')}]`);

  // Collect ALL text blocks (web search returns multiple text blocks)
  const textBlocks = response.content.filter(b => b.type === 'text');
  const reply = textBlocks.length > 0
    ? textBlocks.map(b => b.text.trim()).filter(Boolean).join('\n\n')
    : 'לא הצלחתי לעבד, נסה שוב אחי 🤷';
  console.log(`💬 Reply (${reply.length} chars): ${reply.substring(0, 150)}`);
  return reply;
  } catch (err) {
    if (err.message === 'API timeout') {
      console.error('⚠️ API timeout — request took too long');
      return '⏳ הבקשה לקחה יותר מדי זמן. נסה שוב או נסח אחרת.';
    }
    if (err.status === 400 && err.message?.includes('credit balance')) {
      console.error('💳 API credits depleted!');
      return '💳 אחי, נגמרו הקרדיטים ב-API. צריך לטעון ב-console.anthropic.com';
    }
    if (err.status === 429) {
      console.error('⚠️ Rate limit hit after retries');
      return '⏳ אחי, יש עומס על השרת. נסה שוב עוד דקה.';
    }
    // ─── Handle any 400 error — likely corrupted history ──────
    if (err.status === 400) {
      const errBody = err.message || err.error?.message || JSON.stringify(err).substring(0, 300);
      logger.error(`🔴 API 400 error (invalid request). Clearing history and retrying. Details: ${errBody}`);

      // Clear the passed-in history array in-place so caller's reference is also cleaned
      if (Array.isArray(history)) history.length = 0;

      // Retry once with NO history — just the current user message
      try {
        const retryResponse = await callClaude({
          model: 'claude-sonnet-4-6',
          max_tokens: 4000,
          system: getSystemPrompt(),
          tools: TOOLS,
          messages: [{ role: 'user', content: userMessage }],
        });
        const textBlocks = retryResponse.content.filter(b => b.type === 'text');
        const reply = textBlocks.length > 0
          ? textBlocks.map(b => b.text.trim()).filter(Boolean).join('\n\n')
          : 'היסטוריה נוקתה — נסה שוב 🔄';
        return reply;
      } catch (retryErr) {
        logger.error(`🔴 Retry also failed: ${retryErr.message}`);
        return '❌ שגיאת API — ניסיתי לנקות היסטוריה אבל לא עזר. נסה /נקה ואז תכתוב שוב.';
      }
    }
    // Unknown errors — don't crash, return graceful message
    logger.error(`🔴 Unexpected error in smartChat: ${err.message || err}`);
    return '❌ שגיאה לא צפויה. נסה שוב או /נקה לאיפוס.';
  }
}

// ─── Deep think (no tools) ───────────────────────────────────────
async function thinkWithClaude(userMessage, history = []) {
  const trimmed = trimHistory(history);
  const messages = [...trimmed, { role: 'user', content: userMessage }];

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: 'אתה "בוטי" — מנתח מומחה. נתח לעומק, הצג כל זוויות הבעיה, ותן תשובה מקיפה. ענה בשפה שבה שאלו אותך. היה אנושי וחם.',
      messages,
    });

    const textBlock = response.content.find(b => b.type === 'text');
    return '🧠 *ניתוח מעמיק:*\n\n' + (textBlock ? textBlock.text.trim() : 'לא הצלחתי');
  } catch (err) {
    logger.error(`🔴 thinkWithClaude error: ${err.message}`);
    if (err.status === 400 && Array.isArray(history)) history.length = 0;
    return '❌ שגיאה בניתוח. נסה שוב.';
  }
}

module.exports = { smartChat, thinkWithClaude, registerToolHandlers, getUsageSummary };
