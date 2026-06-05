import PaymentAnomaly from '../models/PaymentAnomaly.js';
import { createAndSendNotification } from './notifier.js';
import logger from './logger.js';

/**
 * Tracks payment request velocity and logs anomaly flags for suspicious traffic.
 */
export async function detectAnomaly(orderId, restaurantId, req) {
  try {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'unknown';

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const recentAnomalies = await PaymentAnomaly.countDocuments({
      ipAddress: ip,
      createdAt: { $gte: fiveMinutesAgo }
    });

    if (recentAnomalies >= 5) {
      const anomaly = await PaymentAnomaly.create({
        restaurant: restaurantId,
        order: orderId,
        reason: 'velocity_threshold_breached',
        severity: 'high',
        ipAddress: ip,
        userAgent,
        details: { count: recentAnomalies, msg: 'Suspected payment spam or rapid retry abuse from client.' }
      });

      logger.warn(`[Fraud Watch] High velocity warning logged for IP ${ip}. Reason: ${anomaly.reason}`);
      return anomaly;
    }

    return null;
  } catch (err) {
    logger.error(`[Fraud Watch Error] Failed check execution: ${err.message}`);
  }
}

/**
 * Logs and creates dashboard alerts for high-severity issues (ledger mismatch, signature forgery).
 */
export async function triggerPaymentAlert(io, { type, message, orderId = null, restaurantId = null, details = {} }) {
  const alertText = `🚨 [CRITICAL ALERT] [${type.toUpperCase()}]: ${message}`;
  logger.error(alertText, { orderId, details });

  try {
    await createAndSendNotification(io, {
      restaurantId,
      orderId,
      title: `SEVERITY ALERT: ${type.toUpperCase()}`,
      message,
      type: 'payment',
      recipient: 'admin'
    });
  } catch (err) {
    logger.error(`[Alerting System Error] Failed to persist security alert: ${err.message}`);
  }
}
export async function logSimpleAnomaly(orderId, restaurantId, reason, details = {}) {
  try {
    await PaymentAnomaly.create({
      restaurant: restaurantId,
      order: orderId,
      reason,
      severity: 'medium',
      details
    });
  } catch (err) {
    logger.error(`[Fraud Watch Error] Simple anomaly log failed: ${err.message}`);
  }
}
