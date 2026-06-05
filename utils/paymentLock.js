import PaymentLock from '../models/PaymentLock.js';
import { getRedisClient, checkRedisAvailability } from './redisClient.js';
import logger from './logger.js';

// Safe release Lua script: Deletes key only if owner matches value to prevent cross-worker lock release
const LUA_RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/**
 * Acquires a distributed lock using Redis, falling back to MongoDB if Redis is unavailable.
 */
export async function acquirePaymentLock(orderId, owner = 'system', maxRetries = 10, retryDelayMs = 150) {
  const lockKey = `payment:lock:${orderId}`;
  const ttlMs = 30000; // 30 seconds expiration limit

  let attempt = 0;
  while (attempt < maxRetries) {
    // 1. Try Redis Locking if active
    if (checkRedisAvailability()) {
      try {
        const redis = getRedisClient();
        // NX: set only if key does not exist; PX: millisecond TTL
        const result = await redis.set(lockKey, owner, 'NX', 'PX', ttlMs);
        if (result === 'OK') {
          logger.info(`[Lock Manager] Redis lock ACQUIRED for: ${lockKey} (Owner: ${owner})`);
          return true;
        }
      } catch (err) {
        logger.error(`[Lock Manager Error] Redis lock acquisition failed: ${err.message}. Falling back to DB...`);
      }
    } else {
      // 2. Fallback to MongoDB unique index locking
      try {
        await PaymentLock.create({ orderId, owner, acquiredAt: new Date() });
        logger.info(`[Lock Manager] MongoDB fallback lock ACQUIRED for: ${orderId} (Owner: ${owner})`);
        return true;
      } catch (err) {
        if (err.code !== 11000) {
          logger.error(`[Lock Manager Error] Fallback MongoDB lock failed: ${err.message}`);
          return false;
        }
      }
    }

    // Wait and retry if not acquired
    attempt++;
    if (attempt >= maxRetries) {
      logger.warn(`[Lock Manager] Distributed lock TIMEOUT for order: ${orderId} after ${maxRetries} attempts.`);
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
  }

  return false;
}

/**
 * Releases the distributed lock.
 */
export async function releasePaymentLock(orderId, owner = 'system') {
  const lockKey = `payment:lock:${orderId}`;

  // 1. Try Redis Release
  if (checkRedisAvailability()) {
    try {
      const redis = getRedisClient();
      const result = await redis.eval(LUA_RELEASE_SCRIPT, 1, lockKey, owner);
      if (result === 1) {
        logger.info(`[Lock Manager] Redis lock RELEASED for: ${lockKey} (Owner: ${owner})`);
        return true;
      }
      logger.warn(`[Lock Manager] Redis lock release skipped: lock expired or owned by another worker for ${lockKey}`);
      return false;
    } catch (err) {
      logger.error(`[Lock Manager Error] Redis lock release failed: ${err.message}. Falling back to DB...`);
    }
  }

  // 2. Fallback MongoDB Lock deletion
  try {
    const result = await PaymentLock.deleteOne({ orderId, owner });
    if (result.deletedCount > 0) {
      logger.info(`[Lock Manager] MongoDB fallback lock RELEASED for: ${orderId} (Owner: ${owner})`);
      return true;
    }
    logger.warn(`[Lock Manager] MongoDB fallback lock release skipped: Not found or different owner for ${orderId}`);
    return false;
  } catch (err) {
    logger.error(`[Lock Manager Error] Failed to delete MongoDB lock: ${err.message}`);
    return false;
  }
}
