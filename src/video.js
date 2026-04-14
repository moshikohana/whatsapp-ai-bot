'use strict';
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.join(__dirname, '..', 'output', 'videos');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let bundleLocation = null;

/**
 * Bundle Remotion project (cached — only runs once)
 */
async function getBundleLocation() {
  if (bundleLocation) return bundleLocation;

  const { bundle } = require('@remotion/bundler');
  console.log('📦 Bundling Remotion project (first time, may take a moment)...');
  bundleLocation = await bundle({
    entryPoint: path.resolve(__dirname, '..', 'remotion', 'index.jsx'),
    webpackOverride: (config) => config,
  });
  console.log('✅ Remotion bundle ready');
  return bundleLocation;
}

/**
 * Render a video from a template
 * @param {string} template - "text" | "quote" | "slideshow"
 * @param {object} props - Template-specific props
 * @param {object} options - { durationSec, fps, width, height }
 * @returns {string} Path to the rendered video file
 */
async function renderVideo(template, props, options = {}) {
  const { selectComposition, renderMedia } = require('@remotion/renderer');
  const serveUrl = await getBundleLocation();

  // Map template name to composition ID
  const compositionMap = {
    text: 'TextVideo',
    quote: 'QuoteVideo',
    slideshow: 'SlideshowVideo',
  };

  const compositionId = compositionMap[template];
  if (!compositionId) throw new Error(`תבנית לא ידועה: "${template}". אפשרויות: text, quote, slideshow`);

  const fps = options.fps || 30;
  const durationSec = options.durationSec || (template === 'slideshow' ? (props.slides?.length || 3) * 4 : 5);
  const durationInFrames = Math.round(durationSec * fps);

  console.log(`🎬 Rendering ${compositionId} (${durationSec}s, ${fps}fps)...`);

  const composition = await selectComposition({
    serveUrl,
    id: compositionId,
    inputProps: props,
  });

  // Override duration
  composition.durationInFrames = durationInFrames;
  if (options.width) composition.width = options.width;
  if (options.height) composition.height = options.height;

  const filename = `video_${Date.now()}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, filename);

  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps: props,
    onProgress: ({ progress }) => {
      if (Math.round(progress * 100) % 25 === 0) {
        process.stdout.write(`\r🎬 Rendering: ${Math.round(progress * 100)}%`);
      }
    },
  });

  console.log(`\n✅ Video saved: ${outputPath}`);
  return outputPath;
}

/**
 * Get list of available templates
 */
function getTemplates() {
  return `🎬 *תבניות סרטון — מדריך מלא*
━━━━━━━━━━━━━━━━━━━━

*1. 📝 text — סרטון כותרת/הודעה*
📐 פורמט: 1080x1920 (סטורי, מושלם לאינסטגרם/טיקטוק)
🎭 אנימציות: כותרת צצה מלמעלה עם spring, פס צבעוני מתרחב, תת-כותרת בצבע אקסנט, fade out בסוף
⚙️ פרמטרים:
   • *title* — כותרת ראשית (חובה)
   • *subtitle* — תת כותרת
   • *body* — טקסט גוף
   • *bgColor* — צבע רקע (ברירת מחדל: #1a1a2e כהה)
   • *textColor* — צבע טקסט (#ffffff)
   • *accentColor* — צבע הדגשה (#e94560 אדום)
⏱️ אורך ברירת מחדל: 5 שניות

📌 _דוגמאות:_
• _"תעשה סרטון: ח"כ קלנר בראיון בערוץ הכנסת"_
• _"סרטון עם כותרת חדשות היום ותת כותרת 12 באפריל"_
• _"תעשה סטורי עם רקע כחול וכותרת: הודעה דחופה"_

━━━━━━━━━━━━━━━━━━━━

*2. 💬 quote — ציטוט מעוצב*
📐 פורמט: 1080x1080 (ריבועי, מושלם לפוסט)
🎭 אנימציות: ציטוט עם zoom-in עדין, גרשיים ענקיות ברקע, קו מפריד דינמי + שם מחבר
⚙️ פרמטרים:
   • *quote* — הציטוט (חובה)
   • *author* — שם המחבר (חובה)
   • *bgColor* — צבע רקע (#0f0f23)
   • *accentColor* — צבע הדגשה (#ffdd57 זהב)
⏱️ אורך ברירת מחדל: 6 שניות

📌 _דוגמאות:_
• _"תעשה ציטוט של הרצל: אם תרצו אין זו אגדה"_
• _"סרטון ציטוט: הצלחה היא לא סופית — צ'רצ'יל"_

━━━━━━━━━━━━━━━━━━━━

*3. 📊 slideshow — מצגת שקפים*
📐 פורמט: 1080x1920 (סטורי)
🎭 אנימציות: כל שקף נכנס מלמטה עם fade, פס התקדמות בראש הסרטון, מונה שקפים בפינה
⚙️ פרמטרים:
   • *slides* — מערך שקפים, כל אחד {title, text} (חובה)
   • *bgColor* — צבע רקע (#16213e)
   • *accentColor* — צבע הדגשה (#00b4d8 תכלת)
⏱️ אורך ברירת מחדל: 4 שניות × מספר שקפים

📌 _דוגמאות:_
• _"תעשה מצגת עם 3 שקפים: 1. מבוא 2. תוכן 3. סיכום"_
• _"סרטון מצגת על הישגי ח"כ קלנר ב-5 נקודות"_

━━━━━━━━━━━━━━━━━━━━
🎨 *טיפים:*
• צבעים בפורמט הקס (#ff5500)
• אפשר לבקש כל אורך בשניות
• הסרטון נשלח אוטומטית כוידאו בוואטסאפ
• אני בוחר תבנית וצבעים אוטומטית אם לא מציינים`;
}

module.exports = { renderVideo, getTemplates };
