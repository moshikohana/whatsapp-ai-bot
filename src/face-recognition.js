'use strict';

// ─── Mock tfjs-node → pure JS tfjs (no native deps needed) ─────
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, opts) {
  if (request === '@tensorflow/tfjs-node') {
    return origResolve.call(this, '@tensorflow/tfjs', parent, isMain, opts);
  }
  return origResolve.call(this, request, parent, isMain, opts);
};

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const tf = require('@tensorflow/tfjs');
const sharp = require('sharp');
const faceapi = require('@vladmandic/face-api/dist/face-api.node.js');
const logger = require('./logger');

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

async function _extractFrameFromVideo(videoBuffer) {
  const tmpIn = path.join(os.tmpdir(), `face-vid-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  const tmpOut = `${tmpIn}.jpg`;
  fs.writeFileSync(tmpIn, videoBuffer);
  try {
    await new Promise((resolve, reject) => {
      // Grab a frame ~0.5s in (past any black lead-in), scaled sanely.
      execFile('ffmpeg', ['-y', '-ss', '0.5', '-i', tmpIn, '-frames:v', '1', '-q:v', '2', tmpOut],
        { timeout: 30000 }, (err) => err ? reject(err) : resolve());
    });
    const frame = fs.readFileSync(tmpOut);
    logger.info(`🎞️ Live Photo/video → extracted ${frame.length}B frame for face detection`);
    return frame;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
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
    await tf.setBackend('cpu');
    await tf.ready();

    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_DIR);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);

    initialized = true;
    logger.info('✅ Face recognition models loaded');
    return true;
  } catch (err) {
    initError = err.message;
    logger.error('❌ Face recognition init failed:', err.message);
    return false;
  }
}

// ─── Convert image buffer → tf.Tensor3D via sharp ──────────────
// Use 1280px for higher resolution — critical for small faces in group photos.
async function bufferToTensor(imageBuffer) {
  // iPhone Live Photos / videos arrive as MP4 even when tagged "image" —
  // transparently pull a still frame so face detection works on them.
  if (_isVideoBuffer(imageBuffer)) {
    imageBuffer = await _extractFrameFromVideo(imageBuffer);
  }
  // Diagnostic: log the buffer's magic bytes so we can see what format
  // actually arrives when sharp rejects it ("unsupported image format").
  const _magic = Buffer.isBuffer(imageBuffer)
    ? imageBuffer.slice(0, 12).toString('hex')
    : `(not a buffer: ${typeof imageBuffer})`;
  const { data, info } = await sharp(imageBuffer, { failOn: 'none' })
    .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
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
async function detectFaces(imageBuffer) {
  if (!(await initFaceAPI())) {
    throw new Error('Face recognition not initialized: ' + initError);
  }

  const tensor = await bufferToTensor(imageBuffer);
  try {
    const detections = await faceapi
      .detectAllFaces(tensor, DETECTION_OPTIONS)
      .withFaceLandmarks()
      .withFaceDescriptors();
    return detections;
  } finally {
    tensor.dispose();
  }
}

// ─── Add reference photo for a person ───────────────────────────
async function addReference(name, imageBuffer) {
  const detections = await detectFaces(imageBuffer);

  // Quality guard: reject images that are too dark or overexposed
  try {
    const imgStats = await sharp(imageBuffer).stats();
    const brightness = imgStats.channels.reduce((s, c) => s + c.mean, 0) / imgStats.channels.length;
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

  // If multiple faces detected, reject: storing the wrong face contaminates the reference set
  // and causes 100% false-positive matches for other children in the photo.
  if (detections.length > 1) {
    return {
      success: false,
      error: `זוהו ${detections.length} פנים בתמונה — אנא שלח תמונה עם פנים של ${name} בלבד`,
      facesFound: detections.length,
    };
  }

  const config = loadConfig();
  if (!config.referenceDescriptors[name]) {
    config.referenceDescriptors[name] = [];
  }

  // Only add the single detected face's descriptor
  config.referenceDescriptors[name].push(Array.from(detections[0].descriptor));

  saveConfig(config);
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
// 25% means: distance must be ≤ 75% of threshold (clearly inside, not borderline).
const MIN_FORWARD_CONFIDENCE = 25;

async function findMatches(imageBuffer) {
  const config = loadConfig();
  if (!config.enabled || Object.keys(config.referenceDescriptors).length === 0) return [];

  const detections = await detectFaces(imageBuffer);
  if (detections.length === 0) return [];

  const matches = [];

  for (const det of detections) {
    for (const [name, descriptors] of Object.entries(config.referenceDescriptors)) {
      if (!descriptors.length) continue;

      let bestDistance = Infinity;
      for (const refDesc of descriptors) {
        const dist = faceapi.euclideanDistance(
          det.descriptor,
          new Float32Array(refDesc),
        );
        if (dist < bestDistance) bestDistance = dist;
      }

      const effectiveThreshold = config.perPersonThresholds?.[name] ?? config.threshold;
      if (bestDistance < effectiveThreshold) {
        const confidence = Math.round(Math.max(0, (1 - bestDistance / effectiveThreshold) * 100));
        // Skip borderline matches that round to a low confidence — they were
        // almost certainly false positives or low-quality face crops.
        if (confidence < MIN_FORWARD_CONFIDENCE) {
          // (kept for log visibility — debug aid)
          // console.log(`🚫 Low-confidence match suppressed: ${name} (${confidence}%, dist=${bestDistance.toFixed(3)}/threshold=${effectiveThreshold})`);
          continue;
        }
        matches.push({
          name,
          distance: Math.round(bestDistance * 1000) / 1000,
          confidence,
          threshold: effectiveThreshold,
        });
      }
    }
  }

  // Deduplicate: keep only the best (highest confidence) entry per name
  const deduped = {};
  for (const m of matches) {
    if (!deduped[m.name] || m.confidence > deduped[m.name].confidence) {
      deduped[m.name] = m;
    }
  }

  // Best match first
  return Object.values(deduped).sort((a, b) => b.confidence - a.confidence);
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
async function highlightMatchingFaces(imageBuffer, { blurOthers = false, preDetected = null } = {}) {
  const config = loadConfig();
  const detections = preDetected || await detectFaces(imageBuffer);
  if (detections.length === 0) return { buffer: imageBuffer, highlighted: 0, blurred: 0, matched: 0 };

  const origMeta = await sharp(imageBuffer).metadata();
  const maxDim = 1280;
  const ratio = Math.min(maxDim / origMeta.width, maxDim / origMeta.height, 1);
  const scaleX = 1 / ratio;
  const scaleY = 1 / ratio;

  const matchedBoxes = [];
  const unmatchedBoxes = [];

  for (const det of detections) {
    let bestDist = Infinity;
    let matchedName = null;
    for (const [name, descriptors] of Object.entries(config.referenceDescriptors)) {
      for (const refDesc of descriptors) {
        const dist = faceapi.euclideanDistance(det.descriptor, new Float32Array(refDesc));
        if (dist < bestDist) { bestDist = dist; matchedName = name; }
      }
    }
    const isMatch = bestDist < config.threshold;
    const box = det.detection.box;
    const pad = Math.round(box.width * scaleX * 0.35);
    const x = Math.max(0, Math.round(box.x * scaleX - pad));
    const y = Math.max(0, Math.round(box.y * scaleY - pad));
    const w = Math.min(origMeta.width - x, Math.round(box.width * scaleX + pad * 2));
    const h = Math.min(origMeta.height - y, Math.round(box.height * scaleY + pad * 2));
    if (isMatch) matchedBoxes.push({ x, y, w, h, name: matchedName });
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

  // Blur OR red border for unmatched faces
  for (const { x, y, w, h } of unmatchedBoxes) {
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

  if (composites.length === 0) return { buffer: imageBuffer, highlighted: matchedBoxes.length, blurred: 0, matched: matchedBoxes.length };

  const result = await sharp(imageBuffer).composite(composites).jpeg({ quality: 88 }).toBuffer();
  logger.info(`🟢 Highlighted ${matchedBoxes.length} matched, ${blurOthers ? 'blurred' : 'marked'} ${unmatchedBoxes.length} others`);
  return { buffer: result, highlighted: matchedBoxes.length, blurred: blurOthers ? unmatchedBoxes.length : 0, matched: matchedBoxes.length };
}

// ─── Group management ───────────────────────────────────────────
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
  loadConfig,
};
