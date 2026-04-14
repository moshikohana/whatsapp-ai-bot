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
const tf = require('@tensorflow/tfjs');
const sharp = require('sharp');
const faceapi = require('@vladmandic/face-api/dist/face-api.node.js');
const logger = require('./logger');

const CONFIG_FILE = path.join(__dirname, '..', 'photo-filter-config.json');
const MODELS_DIR = path.join(__dirname, '..', 'node_modules', '@vladmandic', 'face-api', 'model');

let initialized = false;
let initError = null;

// ─── Config ─────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return {
    referenceDescriptors: {},
    monitoredGroups: [],
    threshold: 0.45,
    enabled: true,
  };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
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
async function bufferToTensor(imageBuffer) {
  const { data, info } = await sharp(imageBuffer)
    .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
}

// ─── Detect faces in image buffer ───────────────────────────────
async function detectFaces(imageBuffer) {
  if (!(await initFaceAPI())) {
    throw new Error('Face recognition not initialized: ' + initError);
  }

  const tensor = await bufferToTensor(imageBuffer);
  try {
    const detections = await faceapi
      .detectAllFaces(tensor)
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
  if (detections.length === 0) {
    return { success: false, error: 'לא זוהו פנים בתמונה', facesFound: 0 };
  }

  const config = loadConfig();
  if (!config.referenceDescriptors[name]) {
    config.referenceDescriptors[name] = [];
  }

  // Add each detected face's descriptor
  for (const det of detections) {
    config.referenceDescriptors[name].push(Array.from(det.descriptor));
  }

  saveConfig(config);
  return {
    success: true,
    facesAdded: detections.length,
    totalReferences: config.referenceDescriptors[name].length,
  };
}

// ─── Find matching faces in an image ────────────────────────────
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

      if (bestDistance < config.threshold) {
        matches.push({
          name,
          distance: Math.round(bestDistance * 1000) / 1000,
          confidence: Math.round((1 - bestDistance) * 100),
        });
      }
    }
  }

  // Best match first
  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}

// ─── Blur non-matching faces in image ───────────────────────────
async function blurNonMatchingFaces(imageBuffer) {
  const config = loadConfig();
  const detections = await detectFaces(imageBuffer);
  if (detections.length === 0) return { buffer: imageBuffer, blurred: 0, matched: 0 };

  // Get original dimensions + calculate resize scale
  const origMeta = await sharp(imageBuffer).metadata();
  const maxDim = 640;
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
  saveConfig(config);
}

function isBlurEnabled() {
  return !!loadConfig().blurEnabled;
}

function getStatus() {
  const config = loadConfig();
  const names = Object.keys(config.referenceDescriptors);
  return {
    enabled: config.enabled,
    blurEnabled: !!config.blurEnabled,
    threshold: config.threshold,
    monitoredGroups: config.monitoredGroups,
    references: names.map(n => ({ name: n, count: config.referenceDescriptors[n].length })),
    totalReferences: getReferenceCount(),
    initialized,
    initError,
  };
}

module.exports = {
  initFaceAPI,
  detectFaces,
  addReference,
  findMatches,
  blurNonMatchingFaces,
  isBlurEnabled,
  setBlurEnabled,
  getMonitoredGroups,
  addMonitoredGroup,
  removeMonitoredGroup,
  getReferenceCount,
  clearReferences,
  setThreshold,
  setEnabled,
  getStatus,
  loadConfig,
};
