'use strict';
/**
 * 💰 מה רץ אוטומטית ומה רק כשהוא מבקש — במקום אחד.
 *
 * 17.9: המדידה הראתה כ-10 דולר ביום, והוא בחר לוותר על ארבעה דברים כדי
 * לרדת לכ-2. כל אחד מהם עדיין עובד כשמבקשים אותו; כאן רק כבוי ההרצה
 * האוטומטית. להחזיר — true בקובץ data/ai-features.json, בלי לגעת בקוד.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'ai-features.json');
const DEFAULTS = {
  race: false,          // 🏆 מי הקדים — אפליקציות מול רדיו, מד היתרון
  hourlyDigest: false,  // 📻 "מה נאמר בשידור" כל שעה (ניתוח לפי בקשה נשאר)
  hub: false,           // 🎯 מוקד אוטומטי (הפקודה "מוקד" נשארת)
  priorAuto: false,     // ⏪✅ כבר ידוע / אומת על החמות — עכשיו רק בידיעה שנפתחה
  topicsAuto: false,    // 🧵 קיבוץ נושאים כל שעה — עכשיו כשפותחים את הטאב
  mediaMonitor: false,  // 🔍 מעקב מדיה יומי ב-08:00 — הוא ביקש לבטל (20.9)
};
let _c = null, _at = 0;
function on(name) {
  if (!_c || Date.now() - _at > 60000) {
    let f = {};
    try { f = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) {}
    _c = { ...DEFAULTS, ...f }; _at = Date.now();
  }
  return !!_c[name];
}
module.exports = { on, DEFAULTS };
