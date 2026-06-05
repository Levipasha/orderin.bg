import Order from '../models/Order.js';
import ReconciliationJob from '../models/ReconciliationJob.js';
import PaymentEventLog from '../models/PaymentEventLog.js';
import { handlePaymentSuccess, handlePaymentFailure } from './paymentHandler.js';
import { createAndSendNotification } from './notifier.js';
import { triggerPaymentAlert } from './fraudAndAlerting.js';
import logger from './logger.js';
import Razorpay from 'razorpay';

// Configure Razorpay client
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'mock_key_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'mock_key_secret'
});
const isRazorpayMock = !process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID.startsWith('mock');

/**
 * Scans stuck payment orders and checks status directly against Razorpay Route
 */
export async function reconcilePayments(io) {
  const startTime = new Date();
  let scannedCount = 0;
  let repairedCount = 0;
  let cleanedCount = 0;
  const errors = [];
  const details = { repairedOrders: [], cleanedOrders: [] };

  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 1000 * 60);

    const stuckOrders = await Order.find({
      paymentStatus: { $in: ['pending', 'processing', 'CREATED', 'PROCESSING', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING'] },
      createdAt: { $gte: oneDayAgo, $lte: fiveMinutesAgo }
    });

    scannedCount = stuckOrders.length;
    if (scannedCount > 0) {
      logger.info(`🔄 background payment reconciliation: Found ${scannedCount} stuck orders to verify.`);
    }

    const isMockMode = isRazorpayMock;

    for (const order of stuckOrders) {
      try {
        const orderAgeMs = Date.now() - new Date(order.createdAt).getTime();
        const oneHourMs = 60 * 60 * 1000;
        const thirtyMinsMs = 30 * 60 * 1000;

        // 1. Reconcile Razorpay stuck orders
        if (order.razorpayOrderId && !order.razorpayOrderId.startsWith('order_mock_')) {
          if (isRazorpayMock) {
            if (orderAgeMs > thirtyMinsMs) {
              await Order.findOneAndUpdate(
                { _id: order._id },
                { paymentStatus: 'FAILED', orderStatus: 'FAILED' }
              );
              cleanedCount++;
              details.cleanedOrders.push({ orderId: order._id, reason: 'Stale mock Razorpay order cleanup' });
            }
            continue;
          }

          try {
            const rzOrder = await razorpay.orders.fetch(order.razorpayOrderId);
            if (rzOrder && rzOrder.status === 'paid') {
              const rzPayments = await razorpay.orders.fetchPayments(order.razorpayOrderId);
              const successPayment = rzPayments.items?.find(p => p.status === 'captured') || rzPayments.items?.[0];
              const transactionId = successPayment?.id || `pay_${Date.now()}`;

              logger.info(`✨ Repairing Paid Razorpay Order ${order._id} - Captured payment found: ${transactionId}`);
              await handlePaymentSuccess(io, {
                orderId: order._id,
                transactionId,
                signature: 'reconciled',
                eventId: `reconcile_captured_${transactionId}`,
                isMock: false
              });

              await PaymentEventLog.create({
                order: order._id,
                event: 'reconciliation_repair_paid_razorpay',
                details: { paymentId: transactionId }
              });

              repairedCount++;
              details.repairedOrders.push({ orderId: order._id, status: 'PAID', paymentId: transactionId });
            } else if (orderAgeMs > oneHourMs) {
              logger.info(`🗑️ Cleaning up stale Razorpay order ${order._id} - older than 1 hour with status: ${rzOrder?.status}`);
              await Order.findOneAndUpdate(
                { _id: order._id },
                { paymentStatus: 'FAILED', orderStatus: 'FAILED' }
              );

              await PaymentEventLog.create({
                order: order._id,
                event: 'reconciliation_cleanup_stale_razorpay',
                details: { ageMinutes: Math.round(orderAgeMs / 60000), rzStatus: rzOrder?.status }
              });

              cleanedCount++;
              details.cleanedOrders.push({ orderId: order._id, reason: 'Older than 1 hour without success' });
            }
          } catch (rzErr) {
            logger.error(`[Reconciliation Worker] Razorpay check failed for order ${order._id}: ${rzErr.message}`);
          }
          continue;
        }

        // 2. Generic stale order fallback for orders with no payment gateway ID or stuck in CREATED
        if (!order.razorpayOrderId) {
          if (orderAgeMs > thirtyMinsMs) {
            await Order.findOneAndUpdate(
              { _id: order._id },
              { paymentStatus: 'FAILED', orderStatus: 'FAILED' }
            );
            cleanedCount++;
            details.cleanedOrders.push({ orderId: order._id, reason: 'Stale order with no payment gateway ID' });
          }
        }
      } catch (orderErr) {
        logger.error(`Error reconciling order ${order._id}: ${orderErr.message}`, { orderId: order._id });
        errors.push(`Order ${order._id}: ${orderErr.message}`);
      }
    }

    await ReconciliationJob.create({
      runAt: startTime,
      status: errors.length > 0 ? 'FAILED' : 'SUCCESS',
      scannedCount,
      repairedCount,
      cleanedCount,
      errors,
      details
    });

    if (scannedCount > 0) {
      logger.info(`🏁 Reconciliation Job complete. Scanned: ${scannedCount}, Repaired: ${repairedCount}, Cleaned: ${cleanedCount}`);
    }
  } catch (globalErr) {
    logger.error(`Fatal error in reconciliation job: ${globalErr.message}`, { stack: globalErr.stack });
    
    await ReconciliationJob.create({
      runAt: startTime,
      status: 'FAILED',
      scannedCount,
      repairedCount,
      cleanedCount,
      errors: [globalErr.message],
      details: { error: globalErr.stack }
    });
  }
}

/**
 * Automatically resolve stale payment sessions (Payment State Timeout Engine)
 */
export async function expireStalePayments(io) {
  let expiredCount = 0;
  try {
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);

    // 1. Stuck processing orders (Older than 15 mins)
    const stuckProcessing = await Order.find({
      paymentStatus: { $in: ['PROCESSING', 'PAYMENT_PROCESSING', 'processing'] },
      updatedAt: { $lte: fifteenMinsAgo }
    });

    for (const order of stuckProcessing) {
      order.paymentStatus = 'FAILED';
      order.orderStatus = 'FAILED';
      await order.save();

      await createAndSendNotification(io, {
        restaurantId: order.restaurant,
        orderId: order._id,
        title: 'Payment Timeout',
        message: `Your payment session for Order #${order._id.toString().slice(-4)} has timed out.`,
        type: 'payment',
        recipient: `customer_${order._id}`
      });

      expiredCount++;
      logger.info(`[Timeout Engine] Marked stuck PROCESSING order FAILED: ${order._id}`);
    }

    // 2. Stuck created orders (Older than 30 mins)
    const stuckCreated = await Order.find({
      paymentStatus: { $in: ['CREATED', 'PENDING_PAYMENT', 'pending'] },
      createdAt: { $lte: thirtyMinsAgo }
    });

    for (const order of stuckCreated) {
      order.paymentStatus = 'FAILED';
      order.orderStatus = 'FAILED';
      await order.save();

      expiredCount++;
      logger.info(`[Timeout Engine] Expired stale CREATED order: ${order._id}`);
    }

    if (expiredCount > 0) {
      logger.info(`🏁 Payment State Timeout Engine complete. Expired ${expiredCount} orders.`);
    }
  } catch (err) {
    logger.error(`[Timeout Engine Error] Execution failed: ${err.message}`);
  }
  return expiredCount;
}

/**
 * Continuous reconciliation comparing database records with actual gateway states
 */
export async function verifyPaymentConsistency(io) {
  if (isRazorpayMock) {
    return;
  }

  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const orders = await Order.find({
      paymentStatus: 'PAID',
      updatedAt: { $gte: oneDayAgo }
    });

    if (orders.length === 0) {
      return;
    }

    let mismatchCount = 0;

    for (const order of orders) {
      if (!order.razorpayOrderId || order.razorpayOrderId.startsWith('order_mock_')) {
        continue;
      }

      try {
        const rzOrder = await razorpay.orders.fetch(order.razorpayOrderId);
        const rzAmountINR = rzOrder.amount_paid / 100; // Razorpay stores in paise

        if (rzOrder.status === 'paid' && Math.abs(rzAmountINR - order.totalAmount) > 0.01) {
          mismatchCount++;
          await triggerPaymentAlert(io, {
            type: 'ledger_mismatch',
            message: `Order #${order._id} total amount (₹${order.totalAmount}) does not match captured Razorpay gateway amount (₹${rzAmountINR})!`,
            orderId: order._id,
            restaurantId: order.restaurant,
            details: { orderAmount: order.totalAmount, capturedAmount: rzAmountINR }
          });
        }
      } catch (rzErr) {
        logger.error(`[Consistency Engine] Failed fetching payments for order ${order._id}: ${rzErr.message}`);
      }
    }
    if (mismatchCount > 0) {
      logger.info(`🏁 Payment Consistency Verification Engine complete. Found ${mismatchCount} mismatches.`);
    }
  } catch (err) {
    logger.error(`[Consistency Engine Error] Execution failed: ${err.message}`);
  }
}

/**
 * Initializes the background interval scheduler
 */
export function startReconciliationWorker(io, intervalMs = 3 * 60 * 1000) {
  // Run on startup after short delay
  setTimeout(async () => {
    await reconcilePayments(io);
    await expireStalePayments(io);
    await verifyPaymentConsistency(io);
  }, 10 * 1000);
  
  // Set interval
  setInterval(async () => {
    await reconcilePayments(io);
    await expireStalePayments(io);
    await verifyPaymentConsistency(io);
  }, intervalMs);

  logger.info(`⏰ Payment reconciliation & timeout verification schedulers loaded.`);
}
