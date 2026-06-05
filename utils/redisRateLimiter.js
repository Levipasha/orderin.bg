import { getRedisClient, checkRedisAvailability } from './redisClient.js';
import logger from './logger.js';

/**
 * Sliding Window Rate Limiter using Redis pipeline transactions.
 * Bypasses checks to keep transactions flowing if Redis is disconnected.
 */
export function redisRateLimiter(routeIdentifier, limit = 60, windowSec = 60) {
  const windowMs = windowSec * 1000;

  return async (req, res, next) => {
    if (!checkRedisAvailability()) {
      // Graceful degradation: let requests through
      return next();
    }

    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const redisKey = `rate:limit:${routeIdentifier}:${ip}`;
    const now = Date.now();
    const clearBefore = now - windowMs;

    try {
      const redis = getRedisClient();

      const pipeline = redis.pipeline();
      pipeline.zremrangebyscore(redisKey, 0, clearBefore);
      pipeline.zcard(redisKey);
      pipeline.zadd(redisKey, now, now);
      pipeline.pexpire(redisKey, windowMs + 1000); // 1s buffer

      const results = await pipeline.exec();
      const count = results[1][1]; // Get ZCARD result

      if (count > limit) {
        logger.warn(`[Rate Limiter] Request blocked for IP: ${ip} on: ${routeIdentifier} (${count}/${limit})`);
        return res.status(429).json({
          success: false,
          error: 'Rate limit exceeded. Please wait before retrying.'
        });
      }

      next();
    } catch (err) {
      logger.error(`[Rate Limiter Error] Redis check failed: ${err.message}. Bypassing block.`);
      next(); // Bypasses block in case of network issues
    }
  };
}
