'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const sharp = require('sharp');
const logger = require('./logger');

// ─── TensorFlow backend: prefer NATIVE (tfjs-node) ─────────────
// tfjs-node uses the native libtensorflow (oneDNN/AVX2) — face detection
// is ~5-10x faster than pure-JS tfjs. If the native binary can't load
// (missing on a host, arch mismatch), fall back to pure-JS tfjs via a
// module shim so the bot never crashes.
let tf, faceapi;
let TF_NATIVE = false;
try {
  tf = require('@tensorflow/tfjs-node');
  faceapi = require('@vladmandic/face-api/dist/face-api.node.js');
  TF_NATIVE = true;
} catch (e) {
  logger.warn('⚠️ tfjs-node unavailable — using pure-JS tfjs: ' + (e.message || '').substring(0, 80));
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, opts) {
    if (request === '@tensorflow/tfjs-node') {
      return origResolve.call(this, '@tensorflow/tfjs', parent, isMain, opts);
    }
    return origResolve.call(this, request, parent, isMain, opts);
  };
  tf = require('@tensorflow/tfjs');
  faceapi = require('@vladmandic/face-api/dist/face-api.node.js');
}

// ─── Live Photo / video → still frame ───────────────────────────
// iPhone Live Photos (and any video) arrive as MP4/MOV even when
// WhatsApp tags the message type as "image". Sharp can't read those,
// so detect the ISO-BMFF/QuickTime container by magic bytes and pull a
// single representative frame via ffmpeg before face detection.
function _isVideoBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  // Bytes 4-7 == 'ftyp' → ISO base media (mp4/m4v/mov/heic-seq etc.)
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('ascii');
    // HEIC/HEIF still images also use ftyp — those sharp CAN read, so
    // only treat known video brands as video.
    return /^(mp4|mp42|isom|iso2|M4V|qt|avc1|dash)/i.test(brand);
  }
  return false;
}

// Extract ONE representative frame (used by addReference etc.)
async function _extractFrameFromVideo(videoBuffer) {
  const frames = await _extractFramesFromVideo(videoBuffer, 1);
  if (!frames.length) throw new Error('ffmpeg extracted no frame from video');
  return frames[0];
}

// Extract up to `maxFrames` still frames sampled across a Live Photo/video.
// A single frame can land on motion blur; sampling several and taking the
// best face match recovers the quality lost vs an original still.
async function _extractFramesFromVideo(videoBuffer, maxFrames = 6) {
  const base = path.join(os.tmpdir(), `face-vid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const tmpIn = `${base}.mp4`;
  const pattern = `${base}-%02d.jpg`;
  fs.writeFileSync(tmpIn, videoBuffer);
  try {
    await new Promise((resolve, reject) => {
      // 3 fps sampling + thumbnail-ish quality; cap frame count. Covers the
      // whole ~1-3s Live Photo clip with several sharp candidates.
      execFile('ffmpeg', ['-y', '-i', tmpIn, '-vf', 'fps=3', '-frames:v', String(maxFrames), '-q:v', '2', pattern],
        { timeout: 30000 }, (err) => err ? reject(err) : resolve());
    });
    const frames = [];
    for (let i = 1; i <= maxFrames; i++) {
      const p = `${base}-${String(i).padStart(2, '0')}.jpg`;
      if (fs.existsSync(p)) { frames.push(fs.readFileSync(p)); try { fs.unlinkSync(p); } catch {} }
    }
    logger.info(`🎞️ Live Photo/video → extracted ${frames.length} candidate frame(s) for face detection`);
    return frames;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
  }
}

const CONFIG_FILE = path.join(__dirname, '..', 'photo-filter-config.json');
const MODELS_DIR = path.join(__dirname, '..', 'node_modules', '@vladmandic', 'face-api', 'model');

let initialized = false;
let initError = null;

// ─── Config ─────────────────────────────────────────────────────
let _configCache = null;
let _configMtime = null;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const stat = fs.statSync(CONFIG_FILE);
      const mtime = stat.mtime.getTime();
      if (_configCache && _configMtime === mtime) return _configCache;
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (!cfg.ownerGroups) cfg.ownerGroups = [];
      _configCache = cfg;
      _configMtime = mtime;
      return cfg;
    }
  } catch (err) {
    logger.error('⚠️ Config read error:', err.message);
  }
  return { referenceDescriptors: {}, monitoredGroups: [], ownerGroups: [], threshold: 0.45, enabled: true };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  _configCache = config;
  try { _configMtime = fs.statSync(CONFIG_FILE).mtime.getTime(); } catch (_) {}
}

// ─── Initialize face-api models ─────────────────────────────────
async function initFaceAPI() {
  if (initialized) return true;
  if (initError) return false;

  try {
    // With native tfjs-node the backend is 'tensorflow' — do NOT force 'cpu'
    // (that would drop back to the slow pure-JS kernels). Only pin 'cpu' for
    // the pure-JS fallback.
    if (!TF_NATIVE) await tf.setBackend('cpu');
    await tf.ready();

    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_DIR);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);

    initialized = true;
    logger.info(`✅ Face recognition models loaded (backend: ${tf.getBackend()}${TF_NATIVE ? ' — native' : ''})`);
    return true;
  } catch (err) {
    initError = err.message;
    logger.error('❌ Face recognition init failed:', err.message);
    return false;
  }
}

// ─── Convert image buffer → tf.Tensor3D via sharp ──────────────
// `maxDim` caps the long edge. Default 1280 is fine for close-up faces;
// small faces (e.g. a face inside a phone-screen screenshot) need a
// bigger canvas so the face stays above the detector's minimum size.
async function bufferToTensor(imageBuffer, maxDim = 1280) {
  // iPhone Live Photos / videos arrive as MP4 even when tagged "image" —
  // transparently pull a still frame so face detection works on them.
  if (_isVideoBuffer(imageBuffer)) {
    imageBuffer = await _extractFrameFromVideo(imageBuffer);
  }
  const _magic = Buffer.isBuffer(imageBuffer)
    ? imageBuffer.slice(0, 12).toString('hex')
    : `(not a buffer: ${typeof imageBuffer})`;
  const { data, info } = await sharp(imageBuffer, { failOn: 'none' })
    .rotate() // apply EXIF orientation — iPhone portrait photos are stored
              // rotated with an orientation flag; without this the face comes
              // out sideways and the detector (expects upright faces) misses it
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .sharpen({ sigma: 1.2, m1: 0.5, m2: 0.8 }) // enhance edges — helps with blurry distant faces
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .catch(err => {
      logger.warn(`bufferToTensor: sharp rejected buffer (len=${imageBuffer?.length}, magic=${_magic}): ${err.message}`);
      throw err;
    });

  return tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
}

// Detection options — lower minConfidence so small/distant faces aren't missed.
// Default is 0.5; 0.3 catches faces that are far away or partially occluded.
const DETECTION_OPTIONS = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3, maxResults: 50 });

// ─── Detect faces in image buffer ───────────────────────────────
async function _detectAt(imageBuffer, maxDim) {
  const tensor = await bufferToTensor(imageBuffer, maxDim);
  try {
    return await faceapi
      .detectAllFaces(tensor, DETECTION_OPTIONS)
      .withFaceLandmarks()
      .withFaceDescriptors();
  } finally {
    tensor.dispose();
  }
}

async function detectFaces(imageBuffer) {
  if (!(await initFaceAPI())) {
    throw new Error('Face recognition not initialized: ' + initError);
  }

  // Fast pass at 1280px.
  let detections = await _detectAt(imageBuffer, 1280);
  // Nothing found? The face may be small (e.g. a screenshot where the face
  // occupies a small part of a tall phone-screen frame). Retry once at
  // 2200px so the face stays above the detector's minimum size.
  if (detections.length === 0) {
    const hi = await _detectAt(imageBuffer, 2200);
    if (hi.length > 0) {
      logger.info(`🔍 detectFaces: 0 at 1280px, ${hi.length} at 2200px (small/screenshot face)`);
      detections = hi;
    }
  }
  return detections;
}

// ─── Add reference photo for a person ───────────────────────────
// `chooseIndex` (0-based) picks a SPECIFIC detected face instead of guessing
// the largest — used by the numbered-faces flow, where the owner looks at an
// annotated image and tells us exactly which face is the person.
/**
 * שומר את פרצוף הייחוס כתמונה, לצד הווקטור.
 *
 * נקרא בכל מסלול שמוסיף ייחוס — וואטסאפ, האפליקציה, ואישור מועמד. תמיד
 * best-effort: כישלון בשמירת התמונה לא מבטל ייחוס תקין.
 */
async function _keepReferenceImage(name, imageBuffer, chosen) {
  try {
    await require('./face-archive').recordReference({
      name, buffer: imageBuffer, box: chosen?.detection?.box || null,
    });
  } catch (_) { /* the descriptor is what matters for recognition */ }
}

// Answers that are a refusal, not a name. One of these got through and created
// a "person" called אף אחד holding an exact copy of one of שי's descriptors —
// so every face near it matched both at identical distance, the gap was 0.000,
// and the ambiguity guard then refused to name שי at all. A dead entry nobody
// could see was quietly suppressing real matches.
const NON_NAMES = [
  // Refusals
  'אף אחד', 'אףאחד', 'אין', 'לא יודע', 'לאיודע', 'לא', 'כלום', 'אחר', 'אף אחת', 'אףאחת',
  'none', 'nobody', 'no', 'unknown', 'skip', 'dunno',
  // Commands. "1 למחוק" created a person called למחוק — the same failure as
  // אף אחד, one day later, because the first version of this list held only
  // nouns of refusal. An instruction is never a name.
  'מחק', 'למחוק', 'תמחק', 'מחיקה', 'הסר', 'להסיר', 'תסיר', 'הסרה',
  'בטל', 'ביטול', 'לבטל', 'טעות', 'שגוי', 'לא נכון', 'לאנכון', 'לא זוהה', 'לאזוהה',
  'נכון', 'תקן', 'לתקן', 'תיקון', 'סיום', 'עזוב', 'עצור',
  'delete', 'remove', 'wrong', 'cancel', 'undo', 'fix',
];

function _isNonName(name) {
  const n = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!n) return true;
  if (n.length > 40) return true;
  return NON_NAMES.includes(n) || NON_NAMES.includes(n.replace(/\s/g, ''));
}

async function addReference(name, imageBuffer, { force = false, chooseIndex = null } = {}) {
  if (_isNonName(name)) {
    logger.warn(`📸 addReference rejected non-name: "${name}"`);
    return {
      success: false,
      error: `"${name}" הוא לא שם. אם אף אחד בתמונה הוא לא מי שחיפשת, פשוט אל תוסיף ייחוס.`,
      facesFound: 0,
    };
  }
  const detections = await detectFaces(imageBuffer);

  // Quality guard: reject images that are too dark or overexposed
  let brightness = null;
  try {
    const _m = await sharp(imageBuffer).metadata();
    const imgStats = await sharp(imageBuffer).stats();
    brightness = imgStats.channels.reduce((s, c) => s + c.mean, 0) / imgStats.channels.length;
    logger.info(`📸 addReference "${name}": ${detections.length} face(s) | ${_m.width}x${_m.height} | bright=${brightness.toFixed(0)} | ${(imageBuffer.length/1024).toFixed(0)}KB`);
    if (brightness < 30) {
      return { success: false, error: 'התמונה חשוכה מדי — נסה תמונה עם תאורה טובה יותר 💡', facesFound: 0 };
    }
    if (brightness > 240) {
      return { success: false, error: 'התמונה בהירה מדי / שרופה — נסה תמונה אחרת ☀️', facesFound: 0 };
    }
  } catch (_) { /* quality check is optional — never block on its failure */ }

  if (detections.length === 0) {
    return { success: false, error: 'לא זוהו פנים בתמונה', facesFound: 0 };
  }

  // Multiple faces: instead of rejecting outright (annoying for close-up
  // photos that catch a bit of a bystander), pick the LARGEST face — the
  // subject you photographed up close is almost always the biggest. Only
  // block when two faces are similarly large (ambiguous who to store).
  let chosen = detections[0];
  // Explicit pick from the numbered-faces flow — the owner already told us
  // which face is the person, so skip the largest-face guessing entirely.
  if (chooseIndex !== null && detections[chooseIndex]) {
    chosen = detections[chooseIndex];
    logger.info(`📸 addReference "${name}": using owner-picked face #${chooseIndex + 1} of ${detections.length}`);
  } else if (detections.length > 1) {
    const area = d => (d.detection?.box?.width || 0) * (d.detection?.box?.height || 0);
    const sorted = [...detections].sort((a, b) => area(b) - area(a));
    const biggest = area(sorted[0]);
    const second = area(sorted[1]);
    // If the second-largest face is ≥70% the size of the largest, it's
    // ambiguous — refuse rather than risk storing the wrong child.
    if (second >= biggest * 0.7) {
      return {
        success: false,
        error: `זוהו ${detections.length} פנים בגודל דומה — שלח תמונה שרואים בה בעיקר את ${name}`,
        facesFound: detections.length,
      };
    }
    chosen = sorted[0];
    logger.info(`📸 addReference "${name}": ${detections.length} faces, picked largest (${Math.round(biggest)}px² vs ${Math.round(second)}px²)`);
  }

  const config = loadConfig();
  if (!config.referenceDescriptors[name]) {
    config.referenceDescriptors[name] = [];
  }

  // ── Already there: the same face, saved twice ───────────────────
  {
    const own = config.referenceDescriptors[name] || [];
    for (const refArr of own) {
      if (faceapi.euclideanDistance(chosen.descriptor, new Float32Array(refArr)) < 0.06) {
        logger.info(`📸 addReference "${name}": the same face is already a reference — not added again`);
        return { success: true, duplicate: true, facesAdded: 0, totalReferences: own.length };
      }
    }
  }

  // ── Contamination guard ───────────────────────────────────────
  // If this person already has references, make sure the new face actually
  // resembles them. A face that's far from EVERY existing reference is very
  // likely the wrong person (e.g. an adult accidentally captured) — storing
  // it poisons the set and causes false positives. Reject clear outliers.
  const existing = config.referenceDescriptors[name];
  if (existing.length >= 2 && !force) {
    const newDesc = chosen.descriptor;
    let minDist = Infinity;
    for (const refArr of existing) {
      const d = faceapi.euclideanDistance(newDesc, new Float32Array(refArr));
      if (d < minDist) minDist = d;
    }
    // Only hard-reject CLEAR outliers (a different person sits ~0.75+ away).
    // The 0.62–0.75 band can be the same child in a very different photo
    // (age/angle/expression), so let it through with the "!" override.
    if (minDist > 0.75) {
      logger.warn(`📸 addReference "${name}": rejected outlier (min dist ${minDist.toFixed(3)})`);
      return {
        success: false,
        error: `הפנים בתמונה רחוקות מאוד מ-${existing.length} הייחוסים הקיימים של *${name}* — כנראה אדם אחר. אם זו באמת ${name}, שלח עם כיתוב "ייחוס ${name}!" (עם סימן קריאה) כדי לאלץ 🙏`,
        reason: 'outlier',
        facesFound: detections.length,
      };
    }
    if (minDist > 0.55) {
      logger.info(`📸 addReference "${name}": borderline (min dist ${minDist.toFixed(3)}) — added with note`);
      config.referenceDescriptors[name].push(Array.from(chosen.descriptor));
      saveConfig(config);
      await _keepReferenceImage(name, imageBuffer, chosen);
      return {
        success: true,
        facesAdded: 1,
        totalReferences: config.referenceDescriptors[name].length,
        note: `⚠️ התמונה נראית קצת שונה מהייחוסים הקיימים של ${name} (מרחק ${minDist.toFixed(2)}). אם הזיהוי יתחיל לטעות, אפשר למחוק אותה.`,
      };
    }
  }

  // ── Cross-person contamination guard ──────────────────────────
  // The real-world failure (2026-09-05): a photo of מיה got stored under שי,
  // which pulled the two sibling sets together (closest cross distance 0.40)
  // and made every match weak and unreliable. If the new face is closer to
  // SOMEONE ELSE's references than to this person's, it's the wrong label.
  {
    let bestOther = Infinity, otherName = null;
    for (const [otherPerson, descs] of Object.entries(config.referenceDescriptors)) {
      if (otherPerson === name || !descs.length) continue;
      for (const refArr of descs) {
        const d = faceapi.euclideanDistance(chosen.descriptor, new Float32Array(refArr));
        if (d < bestOther) { bestOther = d; otherName = otherPerson; }
      }
    }
    let bestOwn = Infinity;
    for (const refArr of (config.referenceDescriptors[name] || [])) {
      const d = faceapi.euclideanDistance(chosen.descriptor, new Float32Array(refArr));
      if (d < bestOwn) bestOwn = d;
    }
    if (otherName && bestOther < bestOwn && !force) {
      logger.warn(`📸 addReference "${name}": rejected — closer to ${otherName} (${bestOther.toFixed(3)} < ${bestOwn.toFixed(3)})`);
      return {
        success: false,
        error: `הפנים האלה דומות יותר ל-*${otherName}* מאשר ל-*${name}* (${bestOther.toFixed(2)} מול ${bestOwn.toFixed(2)}) — כנראה בחרת את הפרצוף הלא נכון. בדוק את המספר, או שלח עם "!" בסוף כדי לאלץ.`,
        reason: 'closer', other: otherName,
        facesFound: detections.length,
      };
    }
  }

  // Store the chosen (largest / only) face descriptor
  config.referenceDescriptors[name].push(Array.from(chosen.descriptor));

  saveConfig(config);
  await _keepReferenceImage(name, imageBuffer, chosen);
  return {
    success: true,
    facesAdded: 1,
    totalReferences: config.referenceDescriptors[name].length,
  };
}

// ─── Find matching faces in an image ────────────────────────────
// Minimum confidence to actually forward a match to the owner.
// Without this floor, faces whose distance is JUST below threshold round to
// 0-15% confidence — the user sees photos with score 0% and asks "why?".
// 10% floor (distance ≤ 0.9×threshold). The floor exists to drop near-zero
// "0% confidence" noise. It was briefly 25% to fight a false positive, but the
// real cause was a CONTAMINATED reference set — once cleaned, wrong people sit
// far away (~0.68), so a low floor is safe and lets genuine matches in the
// 0.32–0.43 band (fresh photos of the real child) through instead of "No match".
const MIN_FORWARD_CONFIDENCE = 10;

// Siblings' reference sets sit only ~0.41 apart, so one face can fall under
// BOTH thresholds. If the runner-up person is nearly as close as the winner we
// genuinely cannot tell them apart — naming one would be a coin flip, and that
// is exactly how "מיה" kept getting reported for her sister (2026-09-05).
const AMBIGUITY_MARGIN = 0.06;

// ── Crowd protection (2026-09-05) ──────────────────────────────
// A group photo of many children gives many chances to false-match: an
// 18-face photo produced "מיה (15%)" at distance ~0.425 — a stranger, not her.
// Two rules, both only bite when the match is NOT strong on its own:
//   • CROWD: with many faces, demand a clearly better distance.
//   • STAND-OUT: the real child should be much closer to her references than
//     every OTHER face in the same photo. If several kids are equally close,
//     none of them is her.
const STRONG_DIST = 0.35;          // this close = accept regardless
const CROWD_FACES = 6;             // "many faces" starts here
const CROWD_MAX_DIST = 0.42;       // in a crowd, weaker than this is noise
const FACE_STANDOUT_MARGIN = 0.05; // winner must beat the next face by this

// Match a set of detected faces against the references.
// Each face is assigned ONLY to its closest person (winner-takes-the-face)
// so similar-looking people (e.g. sisters) don't both get reported for the
// same face. Returns deduped matches sorted best-first.
/**
 * ההחלטה על כל פרצוף בנפרד — מי זה, או למה לא נקבע.
 *
 * הוצא החוצה כי היו שתי החלטות מקבילות שלא הסכימו: השמות נקבעו כאן, אבל
 * המסגרות בתמונה נקבעו לפי מרחק בלבד. פרצוף שנפסל כדו־משמעי בין שי למיה
 * קיבל מסגרת ירוקה ולא קיבל שם, ולכן התמונה הראתה שתי בנות והכיתוב אמר אחת.
 * עכשיו שתיהן קוראות מאותה פונקציה, ואי־הסכמה כזו לא יכולה לחזור.
 *
 * מחזיר מערך מקביל ל-detections:
 *   { name, distance, confidence }        — זוהה
 *   { ambiguous: [שם, שם], distance }     — פרצוף אמיתי, לא ניתן לשייך
 *   null                                  — לא מוכר
 */
function _decideFaces(detections, config) {
  const faceCount = detections.length;

  const distOf = (det, descriptors) => {
    let best = Infinity;
    for (const refDesc of descriptors) {
      const d = faceapi.euclideanDistance(det.descriptor, new Float32Array(refDesc));
      if (d < best) best = d;
    }
    return best;
  };
  const perPersonAll = {};
  for (const [name, descriptors] of Object.entries(config.referenceDescriptors || {})) {
    if (!descriptors.length) continue;
    perPersonAll[name] = detections.map(d => distOf(d, descriptors)).sort((a, b) => a - b);
  }

  return detections.map(det => {
    const perPerson = [];
    for (const [name, descriptors] of Object.entries(config.referenceDescriptors || {})) {
      if (!descriptors.length) continue;
      perPerson.push({
        name,
        distance: distOf(det, descriptors),
        threshold: config.perPersonThresholds?.[name] ?? config.threshold,
      });
    }
    perPerson.sort((a, b) => a.distance - b.distance);
    const winner = perPerson.find(p => p.distance < p.threshold) || null;
    if (!winner) return null;

    // 1) Which PERSON is it? Refuse to guess between look-alike siblings.
    const runnerUp = perPerson.find(p => p.name !== winner.name);
    if (runnerUp && (runnerUp.distance - winner.distance) < AMBIGUITY_MARGIN) {
      logger.info(`🤝 Ambiguous face: ${winner.name} ${winner.distance.toFixed(3)} vs ${runnerUp.name} ${runnerUp.distance.toFixed(3)} — not naming`);
      // Returned rather than dropped, so the caller can say a face was found
      // but could not be attributed — which is the truth, and is actionable.
      return { ambiguous: [winner.name, runnerUp.name], distance: winner.distance };
    }

    // 2) Crowd + stand-out checks — skipped for a strong, unmistakable match.
    if (winner.distance > STRONG_DIST) {
      if (faceCount >= CROWD_FACES && winner.distance > CROWD_MAX_DIST) {
        logger.info(`👥 Crowd photo (${faceCount} faces): ${winner.name} at ${winner.distance.toFixed(3)} too weak — skipping`);
        return null;
      }
      const all = perPersonAll[winner.name] || [];
      const nextFace = all.find(d => d > winner.distance + 1e-9);
      if (faceCount >= 3 && nextFace !== undefined && (nextFace - winner.distance) < FACE_STANDOUT_MARGIN) {
        logger.info(`👥 ${winner.name} doesn't stand out (${winner.distance.toFixed(3)} vs next face ${nextFace.toFixed(3)}) — skipping`);
        return null;
      }
    }

    const confidence = Math.round(Math.max(0, (1 - winner.distance / winner.threshold) * 100));
    if (confidence < MIN_FORWARD_CONFIDENCE) return null;
    return {
      name: winner.name,
      distance: Math.round(winner.distance * 1000) / 1000,
      confidence,
      threshold: winner.threshold,
    };
  });
}

function _matchDetections(detections, config) {
  const decisions = _decideFaces(detections, config);
  const matches = decisions.filter(d => d && d.name);

  // Faces the recogniser saw but could not attribute. Carried alongside the
  // matches so a caption can admit "one more face I could not place" instead
  // of silently dropping a child from a photo she is in.
  // faceIndex says WHICH face. Without it a question about a background child
  // arrived over a photo with the main child framed, and "הכי קרוב למיה" read
  // as a verdict on the girl in front — it was about a boy in the back row.
  const ambiguous = decisions.map((d, i) => (d && d.ambiguous
    ? { between: d.ambiguous, distance: Math.round(d.distance * 1000) / 1000, faceIndex: i }
    : null)).filter(Boolean);

  const deduped = {};
  for (const m of matches) {
    if (!deduped[m.name] || m.confidence > deduped[m.name].confidence) deduped[m.name] = m;
  }
  const out = Object.values(deduped).sort((a, b) => b.confidence - a.confidence);
  out.ambiguous = ambiguous;
  return out;
}

// Best "near miss" across detected faces: the closest reference even though
// it didn't pass the threshold. Lets the bot say "didn't recognize, but
// closest was שי" so the user knows it got close (and which person to add
// more references for). Only reported when reasonably close.
function _computeNearMiss(detections, config) {
  let best = null; // { name, distance, threshold, faceIndex }
  detections.forEach((det, i) => {
    for (const [name, descriptors] of Object.entries(config.referenceDescriptors)) {
      if (!descriptors.length) continue;
      let d = Infinity;
      for (const refDesc of descriptors) {
        const dist = faceapi.euclideanDistance(det.descriptor, new Float32Array(refDesc));
        if (dist < d) d = dist;
      }
      if (!best || d < best.distance) {
        best = { name, distance: d, threshold: config.perPersonThresholds?.[name] ?? config.threshold, faceIndex: i };
      }
    }
  });
  if (!best) return null;
  // Only call it a "near miss" if it's within a reasonable margin of the
  // threshold — anything past that is genuinely a different person.
  if (best.distance > best.threshold + 0.15) return null;
  // Rough closeness %: how far into the threshold band it landed.
  const closeness = Math.round(Math.max(0, (1 - best.distance / (best.threshold + 0.15)) * 100));
  return { name: best.name, distance: Math.round(best.distance * 1000) / 1000, closeness, faceIndex: best.faceIndex };
}

/**
 * איפה בתמונה נמצא פרצוף, במילים — ובאיזה גודל.
 * detections are in the downscaled (≤1280px) frame detectFaces used; the
 * geometry is returned in the original image's pixels, like numberFaces.
 */
async function faceGeometry(imageBuffer, det) {
  const raw = await sharp(imageBuffer).metadata();
  // Detection ran on the EXIF-rotated image; a portrait iPhone photo stored
  // sideways reports its width and height swapped.
  const meta = (raw.orientation || 1) >= 5 ? { width: raw.height, height: raw.width } : raw;
  const ratio = Math.min(1280 / meta.width, 1280 / meta.height, 1);
  const scale = 1 / ratio;
  const b = det.detection.box;
  const x = b.x * scale, y = b.y * scale, w = b.width * scale, h = b.height * scale;
  const cx = (x + w / 2) / meta.width, cy = (y + h / 2) / meta.height;
  const rel = w / meta.width;
  const horiz = cx < 0.34 ? 'בצד שמאל' : cx > 0.66 ? 'בצד ימין' : 'באמצע';
  const vert = cy < 0.35 ? 'למעלה' : cy > 0.7 ? 'למטה' : '';
  return {
    x, y, w, h, rel, width: meta.width, height: meta.height,
    // A face under ~6% of the frame's width is a child in the back row.
    small: rel < 0.06,
    where: [rel < 0.06 ? 'ברקע' : null, horiz, vert].filter(Boolean).join(' '),
  };
}

/** מסמן פרצוף אחד בכתום, עם "?" מעליו — כדי שיהיה ברור על מי השאלה. */
async function markFace(imageBuffer, det, color = '#ff9100') {
  const g = await faceGeometry(imageBuffer, det);
  const pad = Math.round(g.w * 0.3);
  const x = Math.max(0, Math.round(g.x - pad)), y = Math.max(0, Math.round(g.y - pad));
  const w = Math.min(g.width - x, Math.round(g.w + pad * 2)), h = Math.min(g.height - y, Math.round(g.h + pad * 2));
  const bw = Math.max(3, Math.min(Math.round(g.width * 0.006), Math.round(w * 0.06)));
  const b = Math.max(26, Math.min(Math.round(g.width * 0.05), Math.round(w * 0.7)));
  const box = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect x="${bw / 2}" y="${bw / 2}" width="${w - bw}" height="${h - bw}" fill="none" stroke="${color}" stroke-width="${bw}" rx="${Math.min(10, Math.round(w / 8))}"/></svg>`);
  const badge = Buffer.from(`<svg width="${b}" height="${b}" xmlns="http://www.w3.org/2000/svg"><circle cx="${b / 2}" cy="${b / 2}" r="${b / 2 - 2}" fill="${color}" stroke="#fff" stroke-width="3"/><text x="50%" y="50%" dy="0.36em" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="${Math.round(b * 0.62)}" font-weight="bold" fill="#000">?</text></svg>`);
  const bx = Math.min(g.width - b, Math.max(0, Math.round(x + w / 2 - b / 2)));
  const by = y - b - 2 >= 0 ? y - b - 2 : Math.min(g.height - b, y + h + 2);
  const buffer = await sharp(imageBuffer).rotate().composite([
    { input: await sharp(box).png().toBuffer(), left: x, top: y },
    { input: await sharp(badge).png().toBuffer(), left: bx, top: by },
  ]).jpeg({ quality: 88 }).toBuffer();
  return { buffer, geometry: g };
}

async function findMatches(imageBuffer) {
  const config = loadConfig();
  if (!config.enabled || Object.keys(config.referenceDescriptors).length === 0) return [];

  // Still image → single detection pass. Attach the detections + the exact
  // image used so callers (highlight/blur) can reuse them instead of running
  // a second full detection pass (halves per-photo time).
  if (!_isVideoBuffer(imageBuffer)) {
    const detections = await detectFaces(imageBuffer);
    logger.info(`🔎 findMatches: ${detections.length} face(s) detected`);
    if (detections.length === 0) { const e = []; e.detections = []; e.frameBuffer = imageBuffer; return e; }
    const m = _matchDetections(detections, config);
    m.detections = detections; m.frameBuffer = imageBuffer;
    if (m.length === 0) m.nearMiss = _computeNearMiss(detections, config);
    return m;
  }

  // Video/Live Photo → process frames ONE AT A TIME and stop at the first
  // frame that yields a match. Detection on pure-JS tfjs is the slow part
  // (~10-20s/frame), so early-exit turns the common "clear match" case from
  // ~2 min (all 6 frames) into a few seconds. Only ambiguous / no-match
  // photos pay for extra frames.
  const frames = await _extractFramesFromVideo(imageBuffer, 6);
  let bestNear = null; // track the closest near-miss across frames (no re-detect)
  for (let i = 0; i < frames.length; i++) {
    let dets;
    try { dets = await detectFaces(frames[i]); } catch (e) { continue; }
    if (!dets.length) continue;
    const m = _matchDetections(dets, config);
    if (m.length) {
      logger.info(`🔎 findMatches (video): matched on frame ${i + 1}/${frames.length} → ${m.map(x => x.name + ' ' + x.confidence + '%').join(', ')}`);
      m.detections = dets; m.frameBuffer = frames[i];
      return m;
    }
    const nm = _computeNearMiss(dets, config);
    if (nm && (!bestNear || nm.closeness > bestNear.closeness)) bestNear = nm;
  }
  logger.info(`🔎 findMatches (video): no match across ${frames.length} frames`);
  const e = []; e.detections = []; e.frameBuffer = frames[0] || imageBuffer;
  if (bestNear) e.nearMiss = bestNear;
  return e;
}

// ─── Blur non-matching faces in image ───────────────────────────
async function blurNonMatchingFaces(imageBuffer, preDetected = null) {
  const config = loadConfig();
  const detections = preDetected || await detectFaces(imageBuffer);
  if (detections.length === 0) return { buffer: imageBuffer, blurred: 0, matched: 0 };

  // Get original dimensions + calculate resize scale
  const origMeta = await sharp(imageBuffer).metadata();
  const maxDim = 1280;
  const ratio = Math.min(maxDim / origMeta.width, maxDim / origMeta.height, 1);
  const scaleX = 1 / ratio;
  const scaleY = 1 / ratio;

  // Classify each face as matched or unmatched
  const unmatchedBoxes = [];
  let matchedCount = 0;

  for (const det of detections) {
    let isMatch = false;
    for (const [, descriptors] of Object.entries(config.referenceDescriptors)) {
      for (const refDesc of descriptors) {
        const dist = faceapi.euclideanDistance(det.descriptor, new Float32Array(refDesc));
        if (dist < config.threshold) { isMatch = true; break; }
      }
      if (isMatch) break;
    }

    if (isMatch) {
      matchedCount++;
    } else {
      unmatchedBoxes.push(det.detection.box);
    }
  }

  if (unmatchedBoxes.length === 0) return { buffer: imageBuffer, blurred: 0, matched: matchedCount };

  // Build blur composites for each unmatched face
  const composites = [];
  for (const box of unmatchedBoxes) {
    const pad = Math.round(box.width * scaleX * 0.35);
    const x = Math.max(0, Math.round(box.x * scaleX - pad));
    const y = Math.max(0, Math.round(box.y * scaleY - pad));
    const w = Math.min(origMeta.width - x, Math.round(box.width * scaleX + pad * 2));
    const h = Math.min(origMeta.height - y, Math.round(box.height * scaleY + pad * 2));

    if (w <= 2 || h <= 2) continue;

    try {
      const blurred = await sharp(imageBuffer)
        .extract({ left: x, top: y, width: w, height: h })
        .blur(30)
        .toBuffer();
      composites.push({ input: blurred, left: x, top: y });
    } catch (err) {
      logger.warn(`Blur region failed (${x},${y} ${w}x${h}):`, err.message);
    }
  }

  if (composites.length === 0) return { buffer: imageBuffer, blurred: 0, matched: matchedCount };

  const result = await sharp(imageBuffer)
    .composite(composites)
    .jpeg({ quality: 85 })
    .toBuffer();

  logger.info(`🔒 Blurred ${composites.length} faces, kept ${matchedCount} clear`);
  return { buffer: result, blurred: composites.length, matched: matchedCount };
}

// ─── Highlight matching faces (draw colored border around them) ──
async function highlightMatchingFaces(imageBuffer, { blurOthers = false, preDetected = null, matchedOnly = false, allowed = null } = {}) {
  const cfg0 = loadConfig();
  // Only the people allowed in this group get a frame (see allowedNames).
  const config = allowed && allowed.length
    ? { ...cfg0, referenceDescriptors: Object.fromEntries(Object.entries(cfg0.referenceDescriptors || {}).filter(([n]) => allowed.includes(n))) }
    : cfg0;
  const detections = preDetected || await detectFaces(imageBuffer);
  if (detections.length === 0) return { buffer: imageBuffer, highlighted: 0, blurred: 0, matched: 0 };

  const origMeta = await sharp(imageBuffer).metadata();
  const maxDim = 1280;
  const ratio = Math.min(maxDim / origMeta.width, maxDim / origMeta.height, 1);
  const scaleX = 1 / ratio;
  const scaleY = 1 / ratio;

  const matchedBoxes = [];
  const ambiguousBoxes = [];
  const unmatchedBoxes = [];

  // The exact same decision the caption is built from. Previously this loop
  // ran its own distance test, which accepted faces the naming logic had
  // rejected as ambiguous — so a photo of both girls came back with two green
  // boxes and a caption naming only one of them.
  const decisions = _decideFaces(detections, config);

  for (let i = 0; i < detections.length; i++) {
    const det = detections[i];
    const decision = decisions[i];
    const isMatch = !!(decision && decision.name);
    const isAmbiguous = !!(decision && decision.ambiguous);
    const box = det.detection.box;
    const pad = Math.round(box.width * scaleX * 0.35);
    const x = Math.max(0, Math.round(box.x * scaleX - pad));
    const y = Math.max(0, Math.round(box.y * scaleY - pad));
    const w = Math.min(origMeta.width - x, Math.round(box.width * scaleX + pad * 2));
    const h = Math.min(origMeta.height - y, Math.round(box.height * scaleY + pad * 2));
    if (isMatch) matchedBoxes.push({ x, y, w, h, name: decision.name });
    else if (isAmbiguous) ambiguousBoxes.push({ x, y, w, h, between: decision.ambiguous });
    else unmatchedBoxes.push({ x, y, w, h });
  }

  const composites = [];
  const borderWidth = Math.max(4, Math.round(origMeta.width * 0.006));

  // Green border for matched faces
  for (const { x, y, w, h } of matchedBoxes) {
    if (w <= 4 || h <= 4) continue;
    try {
      // Build SVG border overlay
      const svg = Buffer.from(
        `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect x="${borderWidth / 2}" y="${borderWidth / 2}" width="${w - borderWidth}" height="${h - borderWidth}" ` +
        `fill="none" stroke="#00e676" stroke-width="${borderWidth}" rx="8"/>` +
        `</svg>`
      );
      const border = await sharp(svg).png().toBuffer();
      composites.push({ input: border, left: x, top: y });
    } catch {}
  }

  // Amber border for a real face the recogniser could not attribute. Shown
  // even under matchedOnly: this is a face it is actively unsure about, and
  // hiding it is what made a child silently disappear from a photo she is in.
  for (const { x, y, w, h } of ambiguousBoxes) {
    if (w <= 4 || h <= 4) continue;
    try {
      const svg = Buffer.from(
        `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect x="${borderWidth / 2}" y="${borderWidth / 2}" width="${w - borderWidth}" height="${h - borderWidth}" ` +
        `fill="none" stroke="#ffab00" stroke-width="${borderWidth}" rx="8" stroke-dasharray="${borderWidth * 3},${borderWidth * 2}"/>` +
        `</svg>`
      );
      composites.push({ input: await sharp(svg).png().toBuffer(), left: x, top: y });
    } catch {}
  }

  // Blur OR red border for unmatched faces — unless matchedOnly, in which
  // case we leave unrecognized faces (e.g. an adult next to the child)
  // completely untouched and only mark the recognized person.
  for (const { x, y, w, h } of (matchedOnly ? [] : unmatchedBoxes)) {
    if (w <= 4 || h <= 4) continue;
    try {
      if (blurOthers) {
        const blurred = await sharp(imageBuffer).extract({ left: x, top: y, width: w, height: h }).blur(30).toBuffer();
        composites.push({ input: blurred, left: x, top: y });
      } else {
        const svg = Buffer.from(
          `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
          `<rect x="${borderWidth / 2}" y="${borderWidth / 2}" width="${w - borderWidth}" height="${h - borderWidth}" ` +
          `fill="none" stroke="#ff1744" stroke-width="${borderWidth}" rx="8" opacity="0.75"/>` +
          `</svg>`
        );
        const border = await sharp(svg).png().toBuffer();
        composites.push({ input: border, left: x, top: y });
      }
    } catch {}
  }

  if (composites.length === 0) {
    return { buffer: imageBuffer, highlighted: matchedBoxes.length, blurred: 0, matched: matchedBoxes.length, ambiguous: ambiguousBoxes.length };
  }

  const result = await sharp(imageBuffer).composite(composites).jpeg({ quality: 88 }).toBuffer();
  const othersShown = matchedOnly ? 0 : unmatchedBoxes.length;
  logger.info(`🟢 Highlighted ${matchedBoxes.length} matched` +
    (ambiguousBoxes.length ? `, ${ambiguousBoxes.length} ambiguous` : '') +
    (othersShown ? `, ${blurOthers ? 'blurred' : 'marked'} ${othersShown} others` : ' (only matched)'));
  return {
    buffer: result, highlighted: matchedBoxes.length,
    blurred: blurOthers ? othersShown : 0,
    matched: matchedBoxes.length, ambiguous: ambiguousBoxes.length,
  };
}

// ─── Group management ───────────────────────────────────────────
// Annotate EVERY detected face with a big number badge so the owner can refer
// to a face by number ("2"). Powers both the pick-a-face reference flow and
// detection feedback. `faces[i]` corresponds to `detections[i]`, so the number
// the owner sees maps straight back to a specific detection.
async function numberFaces(imageBuffer, preDetected = null, allowed = null) {
  const cfg0 = loadConfig();
  // In a group limited to certain people, only they are candidates — a face
  // in שי's kindergarten is never labelled "מיה", however alike they look.
  const config = allowed && allowed.length
    ? { ...cfg0, referenceDescriptors: Object.fromEntries(Object.entries(cfg0.referenceDescriptors || {}).filter(([n]) => allowed.includes(n))) }
    : cfg0;
  const detections = preDetected || await detectFaces(imageBuffer);
  if (!detections.length) return { buffer: imageBuffer, faces: [], count: 0, detections: [] };

  const origMeta = await sharp(imageBuffer).metadata();
  const ratio = Math.min(1280 / origMeta.width, 1280 / origMeta.height, 1);
  const scale = 1 / ratio;

  const composites = [];
  const faces = [];
  const borderWidth = Math.max(4, Math.round(origMeta.width * 0.006));
  const badge = Math.max(30, Math.round(origMeta.width * 0.055));

  for (let i = 0; i < detections.length; i++) {
    const det = detections[i];
    // What does the bot currently think this face is?
    let bestDist = Infinity, nearest = null;
    for (const [name, descriptors] of Object.entries(config.referenceDescriptors || {})) {
      for (const refDesc of descriptors) {
        const d = faceapi.euclideanDistance(det.descriptor, new Float32Array(refDesc));
        if (d < bestDist) { bestDist = d; nearest = name; }
      }
    }
    const effTh = config.perPersonThresholds?.[nearest] ?? config.threshold;
    const isMatch = nearest !== null && bestDist < effTh * (1 - MIN_FORWARD_CONFIDENCE / 100);
    const confidence = bestDist === Infinity ? 0 : Math.max(0, Math.round((1 - bestDist) * 100));

    const box = det.detection.box;
    const pad = Math.round(box.width * scale * 0.3);
    const x = Math.max(0, Math.round(box.x * scale - pad));
    const y = Math.max(0, Math.round(box.y * scale - pad));
    const w = Math.min(origMeta.width - x, Math.round(box.width * scale + pad * 2));
    const h = Math.min(origMeta.height - y, Math.round(box.height * scale + pad * 2));

    faces.push({ n: i + 1, matchedName: isMatch ? nearest : null, nearest, confidence, isMatch });
    if (w <= 4 || h <= 4) continue;

    const color = isMatch ? '#00e676' : '#2979ff';
    // Sized to the face and set above it, not on it. A fixed badge of 5.5% of
    // the photo's width was ~88px on a class photo where a face is 40 —
    // the number covered the very face it labelled, in the one view whose
    // purpose is to look at that face and say who it is.
    const b = Math.max(22, Math.min(badge, Math.round(w * 0.6)));
    const bw = Math.max(2, Math.min(borderWidth, Math.round(w * 0.05)));
    try {
      const boxSvg = Buffer.from(
        `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect x="${bw / 2}" y="${bw / 2}" width="${w - bw}" height="${h - bw}" ` +
        `fill="none" stroke="${color}" stroke-width="${bw}" rx="${Math.min(10, Math.round(w / 8))}"/></svg>`);
      composites.push({ input: await sharp(boxSvg).png().toBuffer(), left: x, top: y });

      const badgeSvg = Buffer.from(
        `<svg width="${b}" height="${b}" xmlns="http://www.w3.org/2000/svg">` +
        `<circle cx="${b / 2}" cy="${b / 2}" r="${b / 2 - 2}" fill="${color}" stroke="#ffffff" stroke-width="${Math.max(2, Math.round(b / 14))}"/>` +
        `<text x="50%" y="50%" dy="0.36em" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" ` +
        `font-size="${Math.round(b * 0.6)}" font-weight="bold" fill="#000000">${i + 1}</text></svg>`);
      const bx = Math.min(origMeta.width - b, Math.max(0, Math.round(x + w / 2 - b / 2)));
      // Above the box when there is room; below it for a face at the top edge.
      const by = y - b - 2 >= 0 ? y - b - 2 : Math.min(origMeta.height - b, y + h + 2);
      composites.push({ input: await sharp(badgeSvg).png().toBuffer(), left: bx, top: by });
    } catch {}
  }

  if (!composites.length) return { buffer: imageBuffer, faces, count: faces.length, detections };
  const buffer = await sharp(imageBuffer).composite(composites).jpeg({ quality: 88 }).toBuffer();
  logger.info(`🔢 numberFaces: annotated ${faces.length} face(s)`);
  return { buffer, faces, count: faces.length, detections };
}

function getMonitoredGroups() {
  return loadConfig().monitoredGroups;
}

function addMonitoredGroup(groupName) {
  const config = loadConfig();
  if (!config.monitoredGroups.includes(groupName)) {
    config.monitoredGroups.push(groupName);
    saveConfig(config);
    return true;
  }
  return false;
}

function removeMonitoredGroup(groupName) {
  const config = loadConfig();
  const before = config.monitoredGroups.length;
  config.monitoredGroups = config.monitoredGroups.filter(g => g !== groupName);
  saveConfig(config);
  return config.monitoredGroups.length < before;
}

// ─── Utilities ──────────────────────────────────────────────────
function getReferenceCount(name) {
  const config = loadConfig();
  if (name) return config.referenceDescriptors[name]?.length || 0;
  return Object.values(config.referenceDescriptors).reduce((s, a) => s + a.length, 0);
}

/**
 * כמה טוב הבוט מבדיל בין שני אנשים — המספר שקובע אם הזיהוי שווה משהו.
 *
 * מודד את המרחק הקטן ביותר בין סט הייחוסים של אחד לשל השני. ככל שהוא קטן,
 * כך הסטים חופפים, וכך יותר פרצופים ייפסלו כדו־משמעיים. בבוקר ה-8.9 שי ומיה
 * עמדו על 0.010 — הרבה מתחת ל-AMBIGUITY_MARGIN של 0.06 — ולכן מיה נעלמה
 * מתמונות שהיא בהן. עד עכשיו לא הייתה שום דרך לראות את המספר הזה.
 */
function separation() {
  const config = loadConfig();
  const names = Object.keys(config.referenceDescriptors || {})
    .filter(n => (config.referenceDescriptors[n] || []).length);
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = config.referenceDescriptors[names[i]];
      const b = config.referenceDescriptors[names[j]];
      let min = Infinity;
      for (const da of a) {
        const fa = new Float32Array(da);
        for (const db of b) {
          const d = faceapi.euclideanDistance(fa, new Float32Array(db));
          if (d < min) min = d;
        }
      }
      pairs.push({
        a: names[i], b: names[j],
        distance: Math.round(min * 1000) / 1000,
        // Graded against the margin that actually decides whether a face gets
        // named, so the label means something operational and not just "low".
        level: min < AMBIGUITY_MARGIN ? 'weak'
          : min < AMBIGUITY_MARGIN * 2 ? 'fair'
          : 'strong',
        margin: AMBIGUITY_MARGIN,
      });
    }
  }
  return pairs.sort((x, y) => x.distance - y.distance);
}

/**
 * מוחק את הייחוס שגרם לזיהוי השגוי.
 *
 * "2 לא זוהה" אומר שפרצוף מספר 2 שויך למישהו שהוא לא. האשם אינו הסט כולו
 * אלא ייחוס אחד ספציפי — התמונה שנשמרה בטעות תחת השם הזה, ושפרצוף 2 קרוב
 * אליה יותר מלכל השאר. מחיקה שלה מתקנת את הזיהוי בלי לפגוע ב-15 הייחוסים
 * התקינים, שזה מה ש-clearReferences היה עושה.
 *
 * chooseIndex — אינדקס הפרצוף מתוך המספור (0-based).
 */
async function removeReferenceNear(name, imageBuffer, chooseIndex) {
  const config = loadConfig();
  const descs = config.referenceDescriptors[name];
  if (!descs || !descs.length) {
    return { success: false, error: `אין ייחוסים ל-${name}` };
  }
  if (descs.length === 1) {
    // Refused rather than silently emptying the person: losing the last
    // reference turns a wrong match into no recognition at all, which is a
    // bigger change than he asked for.
    return {
      success: false,
      error: `ל-*${name}* יש ייחוס אחד בלבד. מחיקה שלו תבטל את הזיהוי לגמרי — אם זו הכוונה, שלח *אפס ייחוסים ${name}*.`,
    };
  }

  const detections = await detectFaces(imageBuffer);
  if (!detections.length) return { success: false, error: 'לא זוהו פנים בתמונה' };
  const det = detections[chooseIndex];
  if (!det) return { success: false, error: `אין פרצוף מספר ${chooseIndex + 1} (יש ${detections.length})` };

  let bestIdx = -1, bestDist = Infinity;
  for (let i = 0; i < descs.length; i++) {
    const d = faceapi.euclideanDistance(det.descriptor, new Float32Array(descs[i]));
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  if (bestIdx < 0) return { success: false, error: 'לא נמצא ייחוס מתאים' };

  descs.splice(bestIdx, 1);
  saveConfig(config);

  // The stored picture is removed alongside only when the two lists are still
  // aligned. References predating image storage have no picture, so the counts
  // drift apart and an index-based delete would remove the wrong photo.
  let photoRemoved = false;
  try {
    const arch = require('./face-archive');
    if (arch.removeReferenceAt && arch.referenceCount(name) === descs.length + 1) {
      photoRemoved = arch.removeReferenceAt(name, bestIdx);
    }
  } catch (_) {}

  logger.info(`🗑️ removeReferenceNear "${name}": dropped #${bestIdx + 1} at distance ${bestDist.toFixed(3)} (${descs.length} left)`);
  return {
    success: true,
    name,
    removedIndex: bestIdx + 1,
    distance: Math.round(bestDist * 1000) / 1000,
    remaining: descs.length,
    photoRemoved,
  };
}

/**
 * מוחק ייחוס לפי מיקומו בסדר ההוספה — למחיקה ישירה מהאפליקציה.
 *
 * removeReferenceNear מוצא את האשם מתוך תמונה; כאן הוא כבר ידוע, כי הוא
 * מסתכל על תמונת הייחוס עצמה ובוחר אותה.
 */
function removeReferenceIndex(name, index) {
  const config = loadConfig();
  const descs = config.referenceDescriptors[name];
  if (!descs || !descs.length) return { success: false, error: `אין ייחוסים ל-${name}` };
  if (descs.length === 1) {
    return { success: false, error: `ל-${name} יש ייחוס אחד בלבד — מחיקה תבטל את הזיהוי לגמרי.` };
  }
  if (index < 0 || index >= descs.length) {
    return { success: false, error: `אין ייחוס מספר ${index + 1} (יש ${descs.length})` };
  }
  // The saved photos began after the first references (מיה: 14 vectors,
  // 8 photos) — the photos are the newest ones, so their index is offset.
  let archIndex = -1;
  try {
    const n = require('./face-archive').referenceCount(name);
    archIndex = index - (descs.length - n);
  } catch (_) {}
  descs.splice(index, 1);
  saveConfig(config);

  let photoRemoved = false;
  try {
    const arch = require('./face-archive');
    if (arch.removeReferenceAt && archIndex >= 0) photoRemoved = arch.removeReferenceAt(name, archIndex);
  } catch (_) {}

  logger.info(`🗑️ removeReferenceIndex "${name}": dropped #${index + 1} (${descs.length} left)`);
  return { success: true, name, removedIndex: index + 1, remaining: descs.length, photoRemoved };
}

function clearReferences(name) {
  const config = loadConfig();
  if (name) delete config.referenceDescriptors[name];
  else config.referenceDescriptors = {};
  saveConfig(config);
}

function setThreshold(value) {
  const config = loadConfig();
  config.threshold = Math.max(0.1, Math.min(0.8, value));
  saveConfig(config);
  return config.threshold;
}

function setEnabled(enabled) {
  const config = loadConfig();
  config.enabled = !!enabled;
  saveConfig(config);
}

function setBlurEnabled(enabled) {
  const config = loadConfig();
  config.blurEnabled = !!enabled;
  if (enabled) config.highlightMode = 'none'; // mutually exclusive
  saveConfig(config);
}

function isBlurEnabled() {
  return !!loadConfig().blurEnabled;
}

// highlightMode: 'none' | 'highlight' | 'highlight_blur'
function setHighlightMode(mode) {
  const config = loadConfig();
  config.highlightMode = mode || 'none';
  if (mode && mode !== 'none') config.blurEnabled = false; // mutually exclusive
  saveConfig(config);
}

function getHighlightMode() {
  return loadConfig().highlightMode || 'none';
}

function addOwnerGroup(groupName) {
  const config = loadConfig();
  if (!config.ownerGroups) config.ownerGroups = [];
  if (!config.ownerGroups.includes(groupName)) {
    config.ownerGroups.push(groupName);
    saveConfig(config);
    return true;
  }
  return false;
}

function removeOwnerGroup(groupName) {
  const config = loadConfig();
  if (!config.ownerGroups) config.ownerGroups = [];
  const before = config.ownerGroups.length;
  config.ownerGroups = config.ownerGroups.filter(g => g !== groupName);
  saveConfig(config);
  return config.ownerGroups.length < before;
}

function getStatus() {
  const config = loadConfig();
  const names = Object.keys(config.referenceDescriptors);
  return {
    enabled: config.enabled,
    blurEnabled: !!config.blurEnabled,
    highlightMode: config.highlightMode || 'none',
    threshold: config.threshold,
    monitoredGroups: config.monitoredGroups,
    ownerGroups: config.ownerGroups || [],
    groupWhitelist: config.groupWhitelist || {},
    groupMinConfidence: config.groupMinConfidence || {},
    references: names.map(n => ({ name: n, count: config.referenceDescriptors[n].length })),
    totalReferences: getReferenceCount(),
    initialized,
    initError,
  };
}

/**
 * Filter face matches by per-group whitelist.
 * @param {Array} matches - results from findMatches()
 * @param {string} groupName - the actual chat name
 * @param {object} groupWhitelist - { groupName: [allowedNames] }
 * @returns {Array} matches limited to whitelisted names (or all if no whitelist)
 */
/**
 * מי מותר בקבוצה הזו — או null כשאין הגבלה.
 * One answer for every place that shows a name: alerts already obeyed the
 * whitelist, but the archive, the questions and the numbering did not, so
 * "מיה" kept appearing on photos from שי's kindergarten, where she can't be.
 */
function allowedNames(groupName) {
  if (!groupName) return null;
  const wl = loadConfig().groupWhitelist || {};
  const entry = Object.entries(wl).find(([g]) => groupName.includes(g) || g.includes(groupName));
  return entry && Array.isArray(entry[1]) && entry[1].length ? entry[1] : null;
}
function isAllowed(name, groupName) {
  const a = allowedNames(groupName);
  return !a || a.includes(name);
}

function applyGroupWhitelist(matches, groupName, groupWhitelist) {
  if (!groupWhitelist || !groupName || !matches?.length) return matches || [];
  // Find the whitelist entry whose key best matches the group name (partial-match,
  // same approach as monitoredGroups detection)
  const entry = Object.entries(groupWhitelist).find(([g]) =>
    groupName.includes(g) || g.includes(groupName)
  );
  if (!entry) return matches; // no whitelist for this group → allow all
  const [, allowedNames] = entry;
  if (!Array.isArray(allowedNames) || !allowedNames.length) return matches;
  return matches.filter(m => allowedNames.includes(m.name));
}

/**
 * Drop matches below a per-group minimum confidence. Baby-heavy groups
 * (daycare/kindergarten) cluster many similar faces at distance 0.35-0.45,
 * exactly the band a lenient global floor lets through → false positives on
 * OTHER children. A stricter per-group floor keeps those out while leaving
 * the controlled test group (קניות) lenient. Groups without an entry are
 * unaffected.
 * @param {Array} matches
 * @param {string} groupName
 * @param {object} groupMinConfidence - { groupName: minConfidencePercent }
 */
function applyGroupMinConfidence(matches, groupName, groupMinConfidence) {
  if (!groupMinConfidence || !groupName || !matches?.length) return matches || [];
  const entry = Object.entries(groupMinConfidence).find(([g]) =>
    groupName.includes(g) || g.includes(groupName)
  );
  if (!entry) return matches;
  const [, minConf] = entry;
  if (typeof minConf !== 'number') return matches;
  return matches.filter(m => m.confidence >= minConf);
}

function setPersonThreshold(name, value) {
  const config = loadConfig();
  if (!config.perPersonThresholds) config.perPersonThresholds = {};
  config.perPersonThresholds[name] = Math.max(0.1, Math.min(0.8, value));
  saveConfig(config);
  return config.perPersonThresholds[name];
}

module.exports = {
  initFaceAPI,
  detectFaces,
  addReference,
  findMatches,
  blurNonMatchingFaces,
  highlightMatchingFaces,
  numberFaces,
  faceGeometry,     // where a face sits, in words (for "which child")
  allowedNames,     // who may appear in a group (whitelist), or null
  isAllowed,
  markFace,         // one face boxed in orange with a "?"
  _matchDetections, // exported for diagnostics/tests
  _decideFaces,     // the shared per-face decision — naming and drawing both use it
  separation,       // how well two people can be told apart
  removeReferenceNear, // drop the one reference that caused a wrong match
  removeReferenceIndex, // drop a reference the app picked directly
  isBlurEnabled,
  setBlurEnabled,
  getHighlightMode,
  setHighlightMode,
  getMonitoredGroups,
  addMonitoredGroup,
  removeMonitoredGroup,
  addOwnerGroup,
  removeOwnerGroup,
  getReferenceCount,
  clearReferences,
  setThreshold,
  setPersonThreshold,
  setEnabled,
  getStatus,
  applyGroupWhitelist,
  applyGroupMinConfidence,
  loadConfig,
};
