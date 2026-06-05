import { getRedisClient, checkRedisAvailability } from './redisClient.js';
import logger from './logger.js';

/**
 * Buffers a payment transition in Redis.
 */
export async function bufferPaymentState(orderId, stateData, ttlSeconds = 120) {
  if (!checkRedisAvailability()) return false;
  try {
    const redis = getRedisClient();
    const key = `payment:buffer:${orderId}`;
    await redis.set(key, JSON.stringify(stateData), 'EX', ttlSeconds);
    logger.info(`[Payment Buffer] Buffered state for order: ${orderId} (Status: ${stateData.paymentStatus})`);
    return true;
  } catch (err) {
    logger.error(`[Payment Buffer Error] Failed to write state buffer for ${orderId}: ${err.message}`);
    return false;
  }
}

/**
 * Fetches buffered payment state from Redis.
 */
export async function getBufferedPaymentState(orderId) {
  if (!checkRedisAvailability()) return null;
  try {
    const redis = getRedisClient();
    const key = `payment:buffer:${orderId}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error(`[Payment Buffer Error] Failed to retrieve state buffer for ${orderId}: ${err.message}`);
    return null;
  }
}

/**
 * Invalidates state buffer.
 */
export async function clearPaymentBuffer(orderId) {
  if (!checkRedisAvailability()) return false;
  try {
    const redis = getRedisClient();
    const key = `payment:buffer:${orderId}`;
    await redis.del(key);
    return true;
  } catch (err) {
    return false;
  }
}
