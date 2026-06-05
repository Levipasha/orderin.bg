import Order from '../models/Order.js';
import DailyAnalytics from '../models/DailyAnalytics.js';
import Restaurant from '../models/Restaurant.js';
import logger from './logger.js';

/**
 * Computes analytics metrics for a single restaurant on a specific date and updates cache.
 */
export async function aggregateDailyMetrics(restaurantId, targetDate = new Date()) {
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  try {
    const orders = await Order.find({
      restaurant: restaurantId,
      createdAt: { $gte: startOfDay, $lte: endOfDay }
    });

    const paidOrders = orders.filter(o => o.paymentStatus === 'PAID');
    const failedOrders = orders.filter(o => o.paymentStatus === 'FAILED');
    const cancelledOrders = orders.filter(o => o.orderStatus === 'cancelled' || o.orderStatus === 'CANCELLED');

    const grossRevenue = paidOrders.reduce((sum, o) => sum + o.totalAmount, 0);
    const totalOrders = orders.length;
    const successfulOrdersCount = paidOrders.length;
    const failedOrdersCount = failedOrders.length;
    const cancelledOrdersCount = cancelledOrders.length;
    const averageOrderValue = successfulOrdersCount > 0 ? (grossRevenue / successfulOrdersCount) : 0;

    const itemMap = {};
    paidOrders.forEach(order => {
      order.items.forEach(item => {
        const itemId = item.menuItem.toString();
        if (!itemMap[itemId]) {
          itemMap[itemId] = {
            menuItem: item.menuItem,
            name: item.name,
            quantity: 0,
            revenue: 0
          };
        }
        itemMap[itemId].quantity += item.quantity;
        itemMap[itemId].revenue += (item.price * item.quantity);
      });
    });

    const topItems = Object.values(itemMap)
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);

    const analytics = await DailyAnalytics.findOneAndUpdate(
      { restaurant: restaurantId, date: startOfDay },
      {
        grossRevenue,
        netRevenue: grossRevenue,
        totalOrders,
        successfulOrdersCount,
        failedOrdersCount,
        cancelledOrdersCount,
        averageOrderValue,
        topItems
      },
      { upsert: true, new: true }
    );

    logger.info(`[Analytics Aggregated] Restaurant: ${restaurantId}, Revenue: ₹${grossRevenue}`);
    return analytics;
  } catch (err) {
    logger.error(`[Analytics Aggregator Error] Failed for restaurant ${restaurantId}: ${err.message}`);
  }
}

/**
 * Compiles metrics for all registered restaurants.
 */
export async function runGlobalDailyAggregation(targetDate = new Date()) {
  try {
    const restaurants = await Restaurant.find({}, '_id');
    for (const rest of restaurants) {
      await aggregateDailyMetrics(rest._id, targetDate);
    }
    logger.info(`[Global Analytics] Finished daily aggregation run for all restaurants.`);
  } catch (err) {
    logger.error(`[Global Analytics Error] Execution failed: ${err.message}`);
  }
}

/**
 * Initializes cron-like periodic aggregation intervals.
 */
export function startAnalyticsScheduler() {
  // Delay first startup runs slightly
  setTimeout(() => runGlobalDailyAggregation(new Date()), 25 * 1000);

  // Poll aggregation calculations every 6 hours
  setInterval(() => {
    runGlobalDailyAggregation(new Date());
  }, 6 * 60 * 60 * 1000);
}
