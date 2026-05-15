# Family Bot — מדריך בנייה והפצה

## מה זה?
גרסה ניידת של הבוט שלך — מאריזה כ-EXE התקנה ל-Windows. כל מי שתשלח לו את ה-EXE יוכל להתקין את הבוט אצלו ולחבר את הוואטסאפ שלו, בלי Node, בלי מפתחות, בלי אף מילת קוד.

הבוט רץ **אצלם** במחשב (לא על השרת שלך — אין לך כזה). כל משתמש = התקנה נפרדת.

---

## מה כלול בכל התקנה?

| | |
|---|---|
| 🤖 **שם בוט אישי** | המשתמש בוחר ("תומר", "ליה", "מקס"...) |
| 📅 **יומן Google** | OAuth אישי לכל משתמש — בהתקנה |
| 💬 **וואטסאפ** | קריאה, חיפוש, סיכום קבוצות וערוצים |
| 🎤 **הודעות קוליות** | תמלול עברית דרך Groq Whisper |
| 🌐 **חיפוש ברשת** | דרך כלי Claude |
| 🔔 **תזכורות** | מקומיות, נשמרות בקובץ |
| 🧠 **זיכרון אישי** | "תזכור ש-..." |
| 🟢 **טריי + auto-start** | רץ ברקע כשמדליקים את המחשב |

---

## איך לבנות (פעם אחת על המחשב שלך)

### דרישות מקדימות
- Node.js 18+ (יש לך)
- Windows 10/11
- ~3 GB מקום פנוי (Chromium מוכלל ב-Electron)

### שלב 1: התקנת תלויות
```powershell
cd "C:\Users\moshi\OneDrive\שולחן העבודה\whatsapp-ai-bot\family-bot"
npm install
```
(זה לוקח 3-5 דקות בפעם הראשונה)

### שלב 2: מילוי מפתחות API
ערוך `.env.dist` והוסף:

```ini
ANTHROPIC_API_KEY=sk-ant-…   ← מאותו .env שיש לבוט שלך
GROQ_API_KEY=gsk_…          ← מאותו .env
GOOGLE_CLIENT_ID=…           ← מאותו .env (חתיכת ה-installed.client_id)
GOOGLE_CLIENT_SECRET=…       ← מאותו .env (חתיכת ה-installed.client_secret)
```

#### חשוב על Google OAuth:
ב-Google Cloud Console, באותו פרוייקט שיש לך, הוסף ל-OAuth Client את ה-redirect URI הבא:
```
http://localhost
```
(בלי פורט ספציפי — ההתקנה בוחרת פורט פנוי דינמית. Google מקבל "כל פורט על localhost".)

> ⚠️ **בלי redirect URI זה** — חיבור Google אצל אמא ואחיך ייכשל.

### שלב 3: בדיקה מהירה ב-DEV
```powershell
npm run dev
```
זה יפעיל את האפליקציה ב-Electron כ-window. עבור על שלבי ההתקנה ובדוק שהכל עובד אצלך לפני שמייצרים EXE.

### שלב 4: בניית ה-EXE
```powershell
npm run build
```
זה לוקח 2-3 דקות. בסיום תמצא ב-`build/`:

```
build/
  BotInstaller-1.0.0.exe       ← זה מה ששולחים לאמא/אח
```

גודל: כ-150 MB (Electron + Chromium). זה הסטנדרט.

---

## איך מפיצים?

1. שלח את `BotInstaller-1.0.0.exe` באימייל / WhatsApp / Drive
2. הנמען מוריד ומפעיל
3. Windows יציג אזהרה ("SmartScreen" — לא חתום) → "מידע נוסף" → "הפעל בכל זאת"
4. אשף ההתקנה עולה
5. הם עוברים את 7 השלבים
6. ✅ הבוט מותקן, פעיל, ועונה להם בוואטסאפ

> 💡 אם תרצה להעלים את אזהרת SmartScreen — צריך **code signing certificate** (~$80/שנה). למשפחה, האזהרה לא דרמטית.

---

## איך בודקים שהכל עובד?

אחרי `npm run dev`:

| בדיקה | ציפייה |
|---|---|
| לוחץ "בוא נתחיל" → מסך שם בוט | ✅ |
| מקליד "תומר" → כפתור הבא נדלק | ✅ |
| בוחר זכר → כפתור הבא נדלק | ✅ |
| מסך WhatsApp QR | QR מופיע תוך ~20s |
| סורק QR | "✅ מחובר!" מופיע | 
| לוחץ "התחבר עם Google" | דפדפן נפתח |
| מאשר ב-Google | חוזר ל-Electron → "✅ מחובר!" |
| לוחץ "סיים" | חלון נסגר, אייקון tray מופיע |
| ב-WhatsApp שולח לעצמי "היי" | בוט עונה עם שם הבוט |
| שולח "תפריט" | תפריט 6 קטגוריות |
| שולח "מה יש לי היום?" | סקירת יומן |

אם משהו לא עובד — תיקח לוג מ:
```
%APPDATA%\Family Bot\logs\bot-YYYY-MM-DD.log
```

---

## מה לעשות אם יש בעיה אצל המשתמש?

הם לא יכולים לתקן בעצמם, אז כל הבעיות מגיעות אליך. מצבים אפשריים:

### "הבוט לא עונה"
1. בדוק שהאייקון בטריי 🟢 (סטטוס "מחובר ופועל")
2. בקש מהם תפריט יציאה ימני → "הצג סטטוס" → צילום מסך
3. אם הסטטוס 🔴 → בקש לוג: `%APPDATA%\Family Bot\logs\bot-*.log` → שלח לך
4. הפעלה מחדש: ימני על האייקון → "הפעל מחדש"

### "QR לא מופיע"
- חיבור אינטרנט?
- אנטי-וירוס חוסם Chromium? (בעיקר Avast/Norton)

### "Google התחבר אבל אומר שאין יומן"
- בדוק שהפעלת את Google Calendar API ל-Client ID שלך
- בדוק שה-redirect URI הוא `http://localhost` (לא מספר פורט)

### "Reset מלא"
המשתמש מוחק את התיקייה `%APPDATA%\Family Bot\` → מפעיל מחדש את האפליקציה → האשף עולה מההתחלה.

---

## מבנה תיקיית הקוד

```
family-bot/
├── package.json              ← תלויות + electron-builder
├── .env.dist                 ← תבנית מפתחות (תמלא אותה!)
├── README.md                 ← הקובץ הזה
├── electron/
│   ├── main.js               ← תהליך ראשי של Electron
│   ├── preload.js            ← גשר UI ↔ Node
│   ├── wizard.html           ← אשף ההתקנה (7 שלבים)
│   ├── wizard.js
│   ├── status.html           ← חלון סטטוס אחרי התקנה
│   └── style.css             ← עיצוב RTL
├── bot/
│   ├── bot.js                ← הבוט עצמו (subprocess)
│   ├── claude.js             ← API wrapper + tool loop
│   ├── config.js             ← user-config.json
│   ├── first-run.js          ← תפריט הכרות בוואטסאפ
│   ├── system-prompt.js      ← System prompt עם שם+מגדר
│   ├── helpers/
│   │   ├── qr-helper.js      ← subprocess ל-QR (בזמן התקנה)
│   │   └── google-oauth-helper.js  ← subprocess ל-Google (בזמן התקנה)
│   └── tools/
│       ├── calendar.js
│       ├── whatsapp.js
│       ├── reminders.js
│       └── memory.js
└── assets/
    ├── icon.ico              ← אייקון EXE (תוכל להחליף)
    └── icon.png
```

---

## עדכון גרסה

כשתשנה משהו וטוחר/אמא ירצו את הגרסה החדשה:
1. עדכן `version` ב-`package.json` (למשל 1.0.0 → 1.0.1)
2. `npm run build`
3. שלח להם את ה-EXE החדש — Electron auto-updater לא מוגדר, אז זה ידני

(אם תרצה auto-updater בעתיד — `electron-updater` + הוסטינג GitHub Releases.)

---

## הבדלים מהבוט שלך

| יכולת | בוט שלך | Family Bot |
|---|---|---|
| Spokesperson / סקירת כתבים | ✅ | ❌ |
| מעקב מדיה | ✅ | ❌ |
| Scan history | ✅ | ❌ |
| War-Room / מצב חירום | ✅ | ❌ |
| Quote archive | ✅ | ❌ |
| Photo face-recognition | ✅ | ❌ |
| Crisis mode | ✅ | ❌ |
| חיבור Telegram | ✅ | ❌ |
| Calendar (יומן) | ✅ | ✅ |
| WhatsApp Channels | ✅ | ✅ |
| WhatsApp Groups | ✅ | ✅ |
| Voice transcription | ✅ | ✅ |
| Web search | ✅ | ✅ |
| Reminders | ⚠️ חלקי | ✅ |
| Memory | ✅ | ✅ |

זה ברירת המחדל. אם אמא תרצה גם Telegram או משהו — אפשר תמיד להוסיף בגרסה הבאה.

---

## איפה הקבצים אצל המשתמש?

`%APPDATA%\Family Bot\` (תיקיית AppData של Windows):
- `user-config.json` — הגדרות (שם בוט, מגדר, וכו')
- `wwebjs_auth/` — סשן WhatsApp (זה מה ששומר שלא יצטרכו לסרוק שוב)
- `data/google-token.json` — Token של Google
- `data/reminders.json` — תזכורות
- `data/memory.json` — זיכרון
- `data/history.json` — היסטוריית שיחה
- `logs/` — לוגים יומיים

כל הנתונים מקומיים. לא נשלח לאף שרת חוץ מ-Anthropic/Groq/Google (לפי הצורך).

---

## שאלות נפוצות

**Q: האם המפתחות שלי גלויים בתוך ה-EXE?**
A: הם בתוך `app.asar` שמתפרס בקלות (asar הוא tar בעצם). למשפחה זה בסדר. אם תרצה להפיץ ציבורית — תצטרך פרוקסי בשרת שמסתיר את המפתחות.

**Q: כמה זה יעלה לי בחודש?**
A: עלות Claude API לפי שימוש. 2-3 משתמשים פעילים בינוניים = ~$5-20/חודש. עלות Groq זניחה. Google חינם.

**Q: ה-EXE חתום דיגיטלית?**
A: לא. SmartScreen יציג אזהרה. בלחיצה אחת ("מידע נוסף" → "הפעל בכל זאת") ממשיכים. אם זה מציק — קח Code Signing Certificate.

**Q: עובד גם על Mac/Linux?**
A: לא כרגע — electron-builder מוגדר רק ל-Windows. תוספת של ~10 דקות עבודה לתמיכה ב-Mac/Linux.

**Q: מה אם המחשב של אמא יכבה?**
A: הבוט יפסיק לעבוד עד שהיא תדליק. תזכורות שהיו אמורות לקפוץ בזמן הזה — יקפצו ברגע שהבוט יעלה ("⏰ תזכורת איחור").
