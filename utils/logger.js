import fs from 'fs';
import path from 'path';
import { getTraceContext } from './traceability.js';

const LOG_DIR = path.resolve('logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logFile = path.join(LOG_DIR, 'combined.log');
const errorFile = path.join(LOG_DIR, 'error.log');

/**
 * Serializes and writes a log entry, enriching it with trace context if present.
 */
function writeLog(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const context = getTraceContext();

  const logEntry = {
    timestamp,
    level,
    traceId: context.traceId,
    correlationId: context.correlationId,
    message,
    meta
  };
  
  const serialized = JSON.stringify(logEntry) + '\n';
  
  // Terminal log formatting (with trace markers and levels)
  const colors = {
    INFO: '\x1b[32m',  // Green
    WARN: '\x1b[33m',  // Yellow
    ERROR: '\x1b[31m', // Red
    RESET: '\x1b[0m'
  };
  const color = colors[level] || colors.RESET;
  const traceLabel = `[${context.traceId}]`;
  console.log(`[${timestamp}] ${traceLabel} ${color}${level}${colors.RESET}: ${message}`, Object.keys(meta).length ? JSON.stringify(meta) : '');

  // Append to logs files
  fs.appendFile(logFile, serialized, () => {});
  if (level === 'ERROR') {
    fs.appendFile(errorFile, serialized, () => {});
  }
}

export const logger = {
  info: (message, meta) => writeLog('INFO', message, meta),
  warn: (message, meta) => writeLog('WARN', message, meta),
  error: (message, meta) => writeLog('ERROR', message, meta)
};

export default logger;
