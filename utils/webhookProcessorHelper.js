import Order from '../models/Order.js';
import { handlePaymentSuccess, handlePaymentFailure } from './paymentHandler.js';
import {
  handleSettlementSuccess,
  handleSettlementFailed,
  handleMarketplacePaymentSuccess
} from './settlementHandler.js';
import { runInTraceContext } from './traceability.js';
import logger from './logger.js';

const PAYMENT_SUCCESS_EVENTS = new Set([
  'PAYMENT_SUCCESS_WEBHOOK',
  'ORDER_PAID',
  'PAYMENT_SUCCESS'
]);

const PAYMENT_FAILED_EVENTS = new Set([
  'PAYMENT_FAILED_WEBHOOK',
  'PAYMENT_FAILED'
]);

const SETTLEMENT_SUCCESS_EVENTS = new Set([
  'SETTLEMENT_SUCCESS',
  'VENDOR_SETTLEMENT_SUCCESS',
  'SETTLEMENT_PROCESSED'
]);

const SETTLEMENT_FAILED_EVENTS = new Set([
  'SETTLEMENT_FAILED',
  'VENDOR_SETTLEMENT_FAILED',
  'SETTLEMENT_REJECTED'
]);

function resolveCashfreeOrderId(payload) {
  return (
    payload?.data?.order?.order_id ||
    payload?.data?.order?.cf_order_id ||
    payload?.order?.order_id ||
    payload?.order_id
  );
}

function resolveCashfreePaymentId(payload) {
  return (
    payload?.data?.payment?.cf_payment_id ||
    payload?.data?.payment?.payment_id ||
    payload?.payment?.cf_payment_id
  );
}

/**
 * Handles webhook jobs — payment capture + marketplace nodal settlement events.
 */
export async function processWebhookJob(io, data) {
  const { eventId, event, payload } = data;

  const traceContext = payload.traceContext || {
    traceId: `tr_bull_${eventId}`,
    correlationId: `corr_bull_${eventId}`
  };

  await runInTraceContext(traceContext, async () => {
    logger.info(`[Webhook Processor] Event: ${eventId} [Type: ${event}]`);

    if (event === 'payment.captured') {
      const paymentEntity = payload.payload?.payment?.entity;
      if (!paymentEntity) return;

      const razorpayOrderId = paymentEntity.order_id;
      const paymentId = paymentEntity.id;

      const order = await Order.findOne({ razorpayOrderId });
      if (!order) {
        throw new Error(`Order not found for Razorpay Order ID: ${razorpayOrderId}`);
      }

      if (order.paymentStatus !== 'PAID') {
        await handlePaymentSuccess(io, {
          orderId: order._id,
          transactionId: paymentId,
          signature: null,
          eventId,
          isMock: false
        });
      }
      return;
    }

    const cfOrderId = resolveCashfreeOrderId(payload);
    const cfPaymentId = resolveCashfreePaymentId(payload);

    if (PAYMENT_SUCCESS_EVENTS.has(event)) {
      const order = await Order.findOne({ cashfreeOrderId: cfOrderId });
      if (!order) {
        throw new Error(`Order not found for Cashfree Order ID: ${cfOrderId}`);
      }

      await handleMarketplacePaymentSuccess({
        orderId: order._id,
        cashfreeOrderId: cfOrderId,
        cashfreePaymentId: cfPaymentId,
        eventId,
        payload
      });

      await handlePaymentSuccess(io, {
        orderId: order._id,
        transactionId: cfPaymentId || cfOrderId,
        signature: payload.signature || 'webhook_queue',
        eventId,
        isMock: false
      });
      return;
    }

    if (PAYMENT_FAILED_EVENTS.has(event)) {
      const order = await Order.findOne({ cashfreeOrderId: cfOrderId });
      if (!order) {
        throw new Error(`Order not found for failed Cashfree Order ID: ${cfOrderId}`);
      }

      await handlePaymentFailure(io, {
        orderId: order._id,
        errorDetails: {
          code: payload.data?.payment?.payment_status,
          description: payload.data?.error_details?.error_description || 'Payment failed',
          paymentId: cfPaymentId
        },
        eventId
      });
      return;
    }

    if (SETTLEMENT_SUCCESS_EVENTS.has(event)) {
      const order = cfOrderId ? await Order.findOne({ cashfreeOrderId: cfOrderId }) : null;
      await handleSettlementSuccess({
        orderId: order?._id,
        cashfreeOrderId: cfOrderId,
        eventId,
        payload
      });
      return;
    }

    if (SETTLEMENT_FAILED_EVENTS.has(event)) {
      const order = cfOrderId ? await Order.findOne({ cashfreeOrderId: cfOrderId }) : null;
      await handleSettlementFailed({
        orderId: order?._id,
        cashfreeOrderId: cfOrderId,
        eventId,
        payload
      });
      return;
    }

    logger.warn(`[Webhook Processor] Unhandled event type: ${event}`);
  });
}
