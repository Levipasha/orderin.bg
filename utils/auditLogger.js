import AuditLog from '../models/AuditLog.js';
import logger from './logger.js';

/**
 * Creates a structured audit log entry.
 */
export async function writeAuditLog({
  restaurantId,
  orderId = null,
  actor,
  actorRole = 'guest',
  action,
  fromState = null,
  toState = null,
  metadata = {}
}, session = null) {
  try {
    const logData = {
      restaurant: restaurantId,
      order: orderId,
      actor,
      actorRole,
      action,
      fromState,
      toState,
      metadata
    };

    const doc = session 
      ? await AuditLog.create([logData], { session })
      : await AuditLog.create(logData);

    logger.info(`[Audit Log] Actor: ${actor}, Action: ${action}`, { orderId });
    return doc;
  } catch (err) {
    logger.error(`[Audit Log Error] Failed to create log: ${err.message}`, { action, actor });
  }
}
