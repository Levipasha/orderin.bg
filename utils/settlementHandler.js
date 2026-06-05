import MarketplaceSettlement from '../models/MarketplaceSettlement.js';
import Order from '../models/Order.js';
import { initiateSplitAfterPayment, syncSettlementStatus } from './cashfreeMarketplace.js';
import { runInTransaction } from './transactionHelper.js';
import logger from './logger.js';

/**
 * Record webhook event on settlement document (idempotent append).
 */
async function appendWebhookEvent(settlement, eventType, eventId, payload) {
  const exists = settlement.webhookEvents?.some(e => e.eventId === eventId && eventId);
  if (exists) return settlement;

  settlement.webhookEvents = settlement.webhookEvents || [];
  settlement.webhookEvents.push({
    type: eventType,
    eventId: eventId || null,
    payload,
    receivedAt: new Date()
  });
  return settlement.save();
}

/**
 * PAYMENT_SUCCESS — payment captured in nodal; split initiated via order_splits or fallback.
 */
export async function handleMarketplacePaymentSuccess({
  orderId,
  cashfreeOrderId,
  cashfreePaymentId,
  eventId,
  payload
}) {
  const order = await Order.findById(orderId);
  if (!order) throw new Error(`Order ${orderId} not found for marketplace settlement`);

  let settlement = await MarketplaceSettlement.findOne({ order: orderId });
  if (!settlement) {
    settlement = await MarketplaceSettlement.findOne({ cashfreeOrderId });
  }
  if (!settlement) {
    logger.warn('[Settlement] No marketplace record on payment success', { orderId, cashfreeOrderId });
    return null;
  }

  settlement.paymentStatus = 'PAID';
  if (cashfreePaymentId) settlement.cashfreePaymentId = cashfreePaymentId;
  if (cashfreeOrderId) settlement.cashfreeOrderId = cashfreeOrderId;

  if (settlement.splitType === 'order_splits') {
    settlement.settlementStatus = 'SPLIT_INITIATED';
    settlement.splitInitiatedAt = new Date();
  }

  await appendWebhookEvent(settlement, 'PAYMENT_SUCCESS_WEBHOOK', eventId, payload);

  logger.info('[Settlement] Payment success recorded in marketplace ledger', {
    orderId,
    settlementStatus: settlement.settlementStatus
  });

  return settlement;
}

/**
 * Trigger split-after-payment fallback (schedule after 2 minutes per Cashfree docs).
 */
export function scheduleSplitAfterPaymentFallback(settlementId) {
  setTimeout(async () => {
    try {
      const settlement = await MarketplaceSettlement.findById(settlementId);
      if (!settlement || settlement.paymentStatus !== 'PAID') return;
      if (settlement.settlementStatus === 'SETTLED') return;
      if (settlement.splitType !== 'order_splits') return;

      await initiateSplitAfterPayment(settlement);
    } catch (err) {
      logger.error('[Settlement] Split-after-payment fallback failed', {
        settlementId,
        error: err.message
      });
    }
  }, 2 * 60 * 1000);
}

/**
 * SETTLEMENT_SUCCESS / VENDOR_SETTLEMENT_SUCCESS — vendor bank payout completed.
 */
export async function handleSettlementSuccess({ orderId, cashfreeOrderId, eventId, payload }) {
  return runInTransaction(async () => {
    let settlement = orderId
      ? await MarketplaceSettlement.findOne({ order: orderId })
      : null;

    if (!settlement && cashfreeOrderId) {
      settlement = await MarketplaceSettlement.findOne({ cashfreeOrderId });
    }

    if (!settlement) {
      const order = cashfreeOrderId
        ? await Order.findOne({ cashfreeOrderId })
        : null;
      if (order) {
        settlement = await MarketplaceSettlement.findOne({ order: order._id });
      }
    }

    if (!settlement) {
      logger.warn('[Settlement] SETTLEMENT_SUCCESS with no matching record', { orderId, cashfreeOrderId });
      return { success: false, message: 'Settlement record not found' };
    }

    settlement.settlementStatus = 'SETTLED';
    settlement.settledAt = new Date();
    settlement.settlementFailureReason = null;

    const vendorId =
      payload?.data?.vendor_id ||
      payload?.data?.settlement?.vendor_id ||
      payload?.vendor_id;
    if (vendorId) {
      settlement.settlementDetails = {
        ...(settlement.settlementDetails || {}),
        vendor_id: vendorId,
        webhook: payload?.data || payload
      };
    }

    await appendWebhookEvent(settlement, 'SETTLEMENT_SUCCESS', eventId, payload);

    try {
      await syncSettlementStatus(settlement.order);
    } catch (syncErr) {
      logger.warn('[Settlement] Recon sync after success failed', { error: syncErr.message });
    }

    logger.info('[Settlement] Vendor settlement marked SETTLED', {
      orderId: settlement.order,
      vendorId: settlement.cashfreeVendorId
    });

    return { success: true, settlement };
  });
}

/**
 * SETTLEMENT_FAILED / VENDOR_SETTLEMENT_FAILED
 */
export async function handleSettlementFailed({ orderId, cashfreeOrderId, eventId, payload, reason }) {
  let settlement = orderId
    ? await MarketplaceSettlement.findOne({ order: orderId })
    : null;

  if (!settlement && cashfreeOrderId) {
    settlement = await MarketplaceSettlement.findOne({ cashfreeOrderId });
  }

  if (!settlement) {
    logger.warn('[Settlement] SETTLEMENT_FAILED with no matching record', { orderId, cashfreeOrderId });
    return { success: false, message: 'Settlement record not found' };
  }

  settlement.settlementStatus = 'SETTLEMENT_FAILED';
  settlement.failedAt = new Date();
  settlement.settlementFailureReason =
    reason ||
    payload?.data?.failure_reason ||
    payload?.data?.settlement?.failure_reason ||
    payload?.message ||
    'Settlement failed';

  await appendWebhookEvent(settlement, 'SETTLEMENT_FAILED', eventId, payload);

  logger.error('[Settlement] Vendor settlement failed', {
    orderId: settlement.order,
    reason: settlement.settlementFailureReason
  });

  return { success: true, settlement };
}
