import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import WebhookEvent from '../models/WebhookEvent.js';
import PaymentEventLog from '../models/PaymentEventLog.js';
import PaymentSnapshot from '../models/PaymentSnapshot.js';
import PaymentAuditLedger from '../models/PaymentAuditLedger.js';
import { acquirePaymentLock, releasePaymentLock } from './paymentLock.js';
import { canTransition } from './paymentDomain.js';
import { getTraceContext } from './traceability.js';
import { createAndSendNotification } from './notifier.js';
import { writeAuditLog } from './auditLogger.js';
import { runInTransaction } from './transactionHelper.js';
import logger from './logger.js';
import { bufferPaymentState } from './paymentBuffer.js';
import Restaurant from '../models/Restaurant.js';

/**
 * atomic payment success confirmation handler
 */
export const handlePaymentSuccess = async (io, { orderId, transactionId, signature, eventId, isMock = false }) => {
  const lockOwner = eventId ? `webhook_${eventId}` : `api_${Date.now()}`;
  
  // 1. Acquire Distributed Lock (fails fast if locked)
  const hasLock = await acquirePaymentLock(orderId.toString(), lockOwner);
  if (!hasLock) {
    logger.warn(`[Payment Success Handler] Conflict: Could not acquire lock for order ${orderId}. Processing aborted.`);
    throw new Error('Lock acquisition failed; transaction already in progress.');
  }

  try {
    // 2. Fetch order to verify state transition eligibility
    const order = await Order.findById(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    // 2.5 Idempotency Check: If already PAID, return success immediately to prevent concurrent verification crashes
    if (order.paymentStatus === 'PAID') {
      logger.info(`[Payment Success Handler] Order ${orderId} is already marked as PAID. Returning success.`);
      return { success: true, message: 'Order already processed and paid', order };
    }

    // 3. Central Domain Validation
    if (!canTransition(order.paymentStatus, 'PAID')) {
      logger.warn(`[Payment Success Handler] Rejected out-of-order transition from current status: ${order.paymentStatus} to PAID`);
      return { success: true, message: 'State transition rejected due to precedence validation rules', order };
    }

    // 4. Idempotency Check for Webhooks
    if (eventId) {
      const existingEvent = await WebhookEvent.findOne({ eventId });
      if (existingEvent) {
        logger.info(`[Idempotency Check] Webhook Event ${eventId} already processed.`);
        return { success: true, message: 'Already processed', order };
      }
    }

    const trace = getTraceContext();

    return await runInTransaction(async (session) => {
      // Record event ID inside session to prevent race conditions
      if (eventId) {
        await WebhookEvent.create([{ eventId, event: 'payment.captured' }], { session });
      }

      // 5. Update Status
      const updatedOrder = await Order.findOneAndUpdate(
        { _id: orderId, paymentStatus: { $ne: 'PAID' } },
        {
          paymentStatus: 'PAID',
          orderStatus: 'PAID'
        },
        { new: true, session }
      );

      if (!updatedOrder) {
        throw new Error('Failed to update order status to PAID. Concurrent modification detected.');
      }

      // Get restaurant details for commission calculations
      const restaurant = await Restaurant.findById(updatedOrder.restaurant).session(session);
      const commissionPercent = restaurant?.commissionPercent !== undefined ? restaurant.commissionPercent : 10;
      const platformCommission = Math.round((updatedOrder.totalAmount * commissionPercent / 100) * 100) / 100;
      const restaurantAmount = Math.round((updatedOrder.totalAmount - platformCommission) * 100) / 100;

      // 6. Create Payment Ledger Entry (with marketplace split metadata)
      await Payment.create([{
        order: updatedOrder._id,
        restaurant: updatedOrder.restaurant,
        transactionId: transactionId || `mock_tx_${Math.random().toString(36).substring(5)}`,
        paymentId: transactionId,
        signature,
        amount: updatedOrder.totalAmount,
        status: 'PAID',
        gateway: 'razorpay',
        platformCommission,
        restaurantAmount,
        settlementStatus: (restaurant?.razorpayAccountId && restaurant?.kycStatus === 'verified') ? 'SPLIT_INITIATED' : 'PENDING'
      }], { session });

      // 7. Write Immutable Invoice Snapshot
      const invoiceNumber = `INV-${updatedOrder.restaurant.toString().slice(-4).toUpperCase()}-${Date.now().toString().slice(-6)}`;
      await PaymentSnapshot.create([{
        order: updatedOrder._id,
        restaurant: updatedOrder.restaurant,
        invoiceNumber,
        totals: {
          subTotal: updatedOrder.subTotal,
          gstAmount: updatedOrder.gstAmount,
          deliveryCharge: updatedOrder.deliveryCharge,
          totalAmount: updatedOrder.totalAmount
        },
        items: updatedOrder.items.map(i => ({
          menuItem: i.menuItem,
          name: i.name,
          price: i.price,
          quantity: i.quantity,
          selectedAddons: i.selectedAddons || []
        })),
        metadata: {
          customerName: updatedOrder.customerName,
          customerPhone: updatedOrder.customerPhone,
          tableNo: updatedOrder.tableNo,
          paymentMethod: updatedOrder.paymentMethod,
          transactionId: transactionId || 'mock',
          paymentGateway: 'razorpay'
        }
      }], { session });

      // 8. Write Append-Only Audit Ledger
      await PaymentAuditLedger.create([{
        order: updatedOrder._id,
        restaurant: updatedOrder.restaurant,
        correlationId: trace.correlationId,
        traceId: trace.traceId,
        event: 'payment_verified_paid',
        stateTransition: {
          fromState: order.paymentStatus,
          toState: 'PAID'
        },
        details: { transactionId, signature, eventId, isMock }
      }], { session });

      // Log Transition Event
      await PaymentEventLog.create([{
        order: updatedOrder._id,
        event: isMock ? 'mock_payment_success' : 'payment_success',
        details: { transactionId, signature, eventId }
      }], { session });

      // 9. Write General Audit Log
      await writeAuditLog({
        restaurantId: updatedOrder.restaurant,
        orderId: updatedOrder._id,
        actor: 'system',
        actorRole: 'system',
        action: 'payment_verified_paid',
        fromState: order.paymentStatus,
        toState: 'PAID',
        metadata: { transactionId, signature, eventId, isMock }
      }, session);

      // 10. Dispatch Notifications
      // Kitchen Alert
      await createAndSendNotification(io, {
        restaurantId: updatedOrder.restaurant,
        orderId: updatedOrder._id,
        title: 'New Paid Order',
        message: `Order #${updatedOrder._id.toString().slice(-4)} (Table: ${updatedOrder.tableNo || 'Delivery'}) is paid!`,
        type: 'kitchen',
        recipient: 'kitchen'
      });

      // Customer Alert
      await createAndSendNotification(io, {
        restaurantId: updatedOrder.restaurant,
        orderId: updatedOrder._id,
        title: 'Order Confirmed',
        message: 'Your payment was successfully received. The kitchen has received your order.',
        type: 'customer',
        recipient: `customer_${updatedOrder._id}`
      });

      // 11. Emit real-time Socket updates
      if (io) {
        const roomCustomer = `order_${updatedOrder._id}`;
        const roomRestaurant = `restaurant_${updatedOrder.restaurant}`;
        const roomQueue = `queue_${updatedOrder.restaurant}`;

        io.to(roomCustomer).emit('payment_update', {
          success: true,
          orderStatus: 'PAID',
          paymentStatus: 'PAID',
          order: updatedOrder
        });

        io.to(roomRestaurant).emit('new_order', {
          order: updatedOrder
        });

        io.to(roomQueue).emit('queue_update', {
          order: updatedOrder
        });
      }

      await bufferPaymentState(updatedOrder._id, {
        paymentStatus: 'PAID',
        orderStatus: 'PAID'
      });

      return { success: true, message: 'Order confirmed successfully', order: updatedOrder };
    });
  } catch (err) {
    logger.error(`[paymentHandler Error] handlePaymentSuccess failed: ${err.message}`, { orderId });
    throw err;
  } finally {
    // 12. Release Lock
    await releasePaymentLock(orderId.toString(), lockOwner);
  }
};

/**
 * atomic payment failure handler
 */
export const handlePaymentFailure = async (io, { orderId, errorDetails, eventId }) => {
  const lockOwner = eventId ? `webhook_fail_${eventId}` : `api_fail_${Date.now()}`;

  const hasLock = await acquirePaymentLock(orderId.toString(), lockOwner);
  if (!hasLock) {
    logger.warn(`[Payment Failure Handler] Conflict: Could not acquire lock for order ${orderId}. Aborting.`);
    throw new Error('Lock acquisition failed; transaction already in progress.');
  }

  try {
    const order = await Order.findById(orderId);
    if (!order) {
      return { success: false, message: 'Order not found' };
    }

    if (!canTransition(order.paymentStatus, 'FAILED')) {
      logger.warn(`[Payment Failure Handler] Rejected out-of-order transition from state: ${order.paymentStatus} to FAILED`);
      return { success: true, message: 'State transition rejected due to precedence validation rules', order };
    }

    if (eventId) {
      const existingEvent = await WebhookEvent.findOne({ eventId });
      if (existingEvent) {
        logger.info(`[Idempotency Check] Webhook Event ${eventId} already processed.`);
        return { success: true };
      }
    }

    const trace = getTraceContext();

    return await runInTransaction(async (session) => {
      if (eventId) {
        await WebhookEvent.create([{ eventId, event: 'payment.failed' }], { session });
      }

      const updatedOrder = await Order.findOneAndUpdate(
        { _id: orderId, paymentStatus: { $nin: ['PAID', 'REFUNDED'] } },
        {
          paymentStatus: 'FAILED',
          orderStatus: 'FAILED'
        },
        { new: true, session }
      );

      if (!updatedOrder) {
        throw new Error('Concurrent modification detected during failure status transition.');
      }

      await PaymentEventLog.create([{
        order: updatedOrder._id,
        event: 'payment_failure',
        details: errorDetails || {}
      }], { session });

      // Write Append-Only Audit Ledger
      await PaymentAuditLedger.create([{
        order: updatedOrder._id,
        restaurant: updatedOrder.restaurant,
        correlationId: trace.correlationId,
        traceId: trace.traceId,
        event: 'payment_failed',
        stateTransition: {
          fromState: order.paymentStatus,
          toState: 'FAILED'
        },
        details: errorDetails
      }], { session });

      await writeAuditLog({
        restaurantId: updatedOrder.restaurant,
        orderId: updatedOrder._id,
        actor: 'system',
        actorRole: 'system',
        action: 'payment_failed',
        fromState: order.paymentStatus,
        toState: 'FAILED',
        metadata: errorDetails
      }, session);

      await createAndSendNotification(io, {
        restaurantId: updatedOrder.restaurant,
        orderId: updatedOrder._id,
        title: 'Payment Failed',
        message: errorDetails?.description || 'Payment transaction failed. Please try again.',
        type: 'payment',
        recipient: `customer_${updatedOrder._id}`
      });

      if (io) {
        io.to(`order_${updatedOrder._id}`).emit('payment_update', {
          success: false,
          orderStatus: 'FAILED',
          paymentStatus: 'FAILED',
          error: errorDetails?.description || 'Payment Failed'
        });
      }

      await bufferPaymentState(updatedOrder._id, {
        paymentStatus: 'FAILED',
        orderStatus: 'FAILED'
      });

      return { success: true, order: updatedOrder };
    });
  } catch (err) {
    logger.error(`[paymentHandler Error] handlePaymentFailure failed: ${err.message}`, { orderId });
    throw err;
  } finally {
    await releasePaymentLock(orderId.toString(), lockOwner);
  }
};
