import Redis from 'ioredis';
import logger from './logger.js';

const host = process.env.REDIS_HOST || '127.0.0.1';
const port = parseInt(process.env.REDIS_PORT) || 6379;
const password = process.env.REDIS_PASSWORD || null;
const tlsEnabled = process.env.REDIS_TLS_ENABLED === 'true';

let redisInstance = null;
let isRedisAvailable = false;
let reconnectAttempts = 0;

/**
 * Reconnection strategy using exponential backoff.
 */
const retryStrategy = (times) => {
  reconnectAttempts = times;
  if (times > 3) {
    logger.warn(`[Redis Client] Maximum reconnection attempts reached. Disabling Redis.`);
    return null; // Stop retrying
  }
  const delay = Math.min(times * 150, 5000); // Wait up to 5 seconds
  logger.warn(`[Redis Client] Connection retry attempt #${times} in ${delay}ms...`);
  return delay;
};

/**
 * Resolves the active Redis client connection instance.
 */
export function getRedisClient() {
  if (redisInstance) {
    return redisInstance;
  }
  
  // logger.info('[Redis Client] Redis initialization is disabled. Running independently from Docker/Redis.');
  isRedisAvailable = false;
  return null;
}

/**
 * Public checker for system degradation and fallbacks.
 */
export function checkRedisAvailability() {
  return isRedisAvailable && redisInstance && redisInstance.status === 'ready';
}

export function getReconnectAttempts() {
  return reconnectAttempts;
}

// Pre-initialize client connection
getRedisClient();

export default getRedisClient;
