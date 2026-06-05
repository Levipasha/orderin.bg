import Notification from '../models/Notification.js';
import logger from './logger.js';

/**
 * Creates a persistent notification in MongoDB and broadcasts it in real-time.
 */
export async function createAndSendNotification(io, {
  restaurantId,
  orderId = null,
  title,
  message,
  type, // 'customer' | 'kitchen' | 'admin' | 'payment'
  recipient // 'kitchen' | 'admin' | 'customer_${orderId}'
}) {
  try {
    const notification = await Notification.create({
      restaurant: restaurantId,
      order: orderId,
      title,
      message,
      type,
      recipient,
      status: 'unread'
    });

    if (io) {
      let room = '';
      if (recipient === 'kitchen') {
        room = `restaurant_${restaurantId}`;
      } else if (recipient === 'admin') {
        room = `admin_${restaurantId}`;
      } else {
        room = recipient; // e.g. order tracking room
      }

      io.to(room).emit('notification', notification);
      logger.info(`[Notification Sent] Room: ${room}, Title: "${title}"`);
    }

    return notification;
  } catch (err) {
    logger.error(`[Notification Error] Failed to dispatch: ${err.message}`, { title, recipient });
  }
}
