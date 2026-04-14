'use strict';
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB per file
const MAX_LOG_FILES = 5;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── Performance tracking ──────────────────────────────────────
const perfStats = {
  apiCalls: [],      // last 50 API call durations
  toolCalls: [],     // last 50 tool call durations
  totalRequests: 0,
  totalErrors: 0,
  startTime: Date.now(),
};

function trackApiCall(durationMs, model) {
  perfStats.apiCalls.push({ duration: durationMs, model, time: Date.now() });
  if (perfStats.apiCalls.length > 50) perfStats.apiCalls.shift();
  perfStats.totalRequests++;
}

function trackToolCall(toolName, durationMs, success) {
  perfStats.toolCalls.push({ tool: toolName, duration: durationMs, success, time: Date.now() });
  if (perfStats.toolCalls.length > 50) perfStats.toolCalls.shift();
  if (!success) perfStats.totalErrors++;
}

function getPerfSummary() {
  const uptime = Math.round((Date.now() - perfStats.startTime) / 60000);
  const avgApi = perfStats.apiCalls.length > 0
    ? Math.round(perfStats.apiCalls.reduce((s, c) => s + c.duration, 0) / perfStats.apiCalls.length)
    : 0;
  const avgTool = perfStats.toolCalls.length > 0
    ? Math.round(perfStats.toolCalls.reduce((s, c) => s + c.duration, 0) / perfStats.toolCalls.length)
    : 0;
  const slowestApi = perfStats.apiCalls.length > 0
    ? Math.max(...perfStats.apiCalls.map(c => c.duration))
    : 0;

  return {
    uptime: `${Math.floor(uptime / 60)}h ${uptime % 60}m`,
    totalRequests: perfStats.totalRequests,
    totalErrors: perfStats.totalErrors,
    avgApiMs: avgApi,
    avgToolMs: avgTool,
    slowestApiMs: slowestApi,
    recentApiCalls: perfStats.apiCalls.slice(-5),
    recentToolCalls: perfStats.toolCalls.slice(-5),
  };
}

// ─── File logger with rotation ─────────────────────────────────
function getLogFile() {
  return path.join(LOG_DIR, `bot-${new Date().toISOString().slice(0, 10)}.log`);
}

function rotateIfNeeded(logFile) {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_SIZE) {
      const rotated = logFile.replace('.log', `-${Date.now()}.log`);
      fs.renameSync(logFile, rotated);
    }
    // Clean old log files
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('bot-') && f.endsWith('.log'))
      .sort()
      .reverse();
    for (const f of files.slice(MAX_LOG_FILES)) {
      fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch {}
}

function writeLog(level, message, data) {
  const ts = new Date().toISOString();
  const logFile = getLogFile();
  rotateIfNeeded(logFile);

  let line = `[${ts}] [${level}] ${message}`;
  if (data !== undefined) {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    line += ` | ${str.substring(0, 500)}`;
  }
  line += '\n';

  try {
    fs.appendFileSync(logFile, line, 'utf-8');
  } catch {}
}

// ─── Public API ────────────────────────────────────────────────
const logger = {
  info: (msg, data) => { console.log(msg); writeLog('INFO', msg, data); },
  warn: (msg, data) => { console.warn(msg); writeLog('WARN', msg, data); },
  error: (msg, data) => { console.error(msg); writeLog('ERROR', msg, data); },
  debug: (msg, data) => { writeLog('DEBUG', msg, data); }, // file only, no console
  perf: trackApiCall,
  perfTool: trackToolCall,
  getPerfSummary,
};

module.exports = logger;
