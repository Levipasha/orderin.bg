import { getRedisClient, checkRedisAvailability } from './redisClient.js';
import logger from './logger.js';

/**
 * Stores checkout session or payment attempt metadata in Redis.
 */
export async function setPaymentSession(orderId, sessionData, ttlSeconds = 1800) {
  if (!checkRedisAvailability()) return false;
  try {
    const redis = getRedisClient();
    const key = `payment:session:${orderId}`;
    await redis.set(key, JSON.stringify(sessionData), 'EX', ttlSeconds);
    return true;
  } catch (err) {
    logger.error(`[Cache Error] Failed to store payment session for ${orderId}: ${err.message}`);
    return false;
  }
}

/**
 * Fetches checkout session metadata from Redis.
 */
export async function getPaymentSession(orderId) {
  if (!checkRedisAvailability()) return null;
  try {
    const redis = getRedisClient();
    const key = `payment:session:${orderId}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error(`[Cache Error] Failed to retrieve session for ${orderId}: ${err.message}`);
    return null;
  }
}

/**
 * Asserts event uniqueness using Redis SET NX.
 * Returns true if duplicate, false if new (and sets key).
 */
export async function checkAndMarkIdempotentEvent(eventId, ttlSeconds = 86400) {
  if (!checkRedisAvailability()) {
    // If Redis is down, return false and let the DB unique index verify duplication
    return false;
  }
  try {
    const redis = getRedisClient();
    const key = `payment:idempotency:${eventId}`;
    const result = await redis.set(key, 'processed', 'NX', 'EX', ttlSeconds);
    return result !== 'OK';
  } catch (err) {
    logger.error(`[Cache Error] Idempotency verification failed for ${eventId}: ${err.message}`);
    return false;
  }
}

/**
 * Invalidates a specific cache key.
 */
export async function invalidateCacheKey(key) {
  if (!checkRedisAvailability()) return false;
  try {
    const redis = getRedisClient();
    await redis.del(key);
    return true;
  } catch (err) {
    logger.error(`[Cache Error] Invalidation failed for ${key}: ${err.message}`);
    return false;
  }
}
