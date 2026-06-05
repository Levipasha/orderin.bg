import express from 'express';
import crypto from 'crypto';
import Order from '../models/Order.js';
import Restaurant from '../models/Restaurant.js';
import PaymentEventLog from '../models/PaymentEventLog.js';
import PaymentAuditLedger from '../models/PaymentAuditLedger.js';
import { handlePaymentSuccess } from '../utils/paymentHandler.js';
import { createSplitTransfer, isMockMode } from '../services/razorpayRouteService.js';
import { detectAnomaly } from '../utils/fraudAndAlerting.js';
import { canTransition } from '../utils/paymentDomain.js';
import { getTraceContext } from '../utils/traceability.js';
import { redisRateLimiter } from '../utils/redisRateLimiter.js';
import logger from '../utils/logger.js';
import Razorpay from 'razorpay';

const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'mock_key_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'mock_key_secret'
});

/**
 * @route   POST /api/payments/create-order
 * @desc    Create Razorpay Order for Checkout
 */
router.post('/create-order', redisRateLimiter('create-order', 15, 60), async (req, res) => {
  const { orderId, amount, currency, receipt } = req.body;

  try {
    // 1. Direct payment creation (no orderId passed)
    if (!orderId) {
      const amountVal = parseInt(amount);
      if (!amountVal || amountVal < 100) {
        return res.status(400).json({ success: false, error: 'Amount must be at least 100 paise (₹1.00).' });
      }

      try {
        const response = await razorpay.orders.create({
          amount: amountVal,
          currency: currency || 'INR',
          receipt: receipt || `receipt_${Date.now()}`
        });

        return res.status(200).json({
          success: true,
          order_id: response.id,
          id: response.id,
          amount: response.amount,
          currency: response.currency
        });
      } catch (rzErr) {
        logger.error('[Payments] Razorpay direct order creation API failed', { error: rzErr.message, status: rzErr.statusCode });
        const isAuthError = rzErr.statusCode === 401 || /auth|unauthorized|invalid.*key/i.test(rzErr.message || '');
        if (isAuthError) {
          return res.status(401).json({
            success: false,
            error: 'Razorpay API Authentication failed: Invalid API keys.'
          });
        }
        return res.status(500).json({
          success: false,
          error: `Razorpay Order creation failed: ${rzErr.message}`
        });
      }
    }

    // 2. Database order-backed payment creation
    const order = await Order.findById(orderId).populate('restaurant');
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (order.paymentStatus === 'PAID') {
      return res.status(400).json({ success: false, error: 'Order is already paid' });
    }

    let restaurant = order.restaurant;
    if (!restaurant || !restaurant._id) {
      restaurant = await Restaurant.findById(order.restaurant);
    }
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    // Run anomaly fraud detection
    await detectAnomaly(order._id, order.restaurant, req);

    // Platform Commission calculations
    const commissionPercent = restaurant.commissionPercent !== undefined ? restaurant.commissionPercent : 10;
    const platformCommission = Math.round((order.totalAmount * commissionPercent / 100) * 100) / 100;
    const restaurantAmount = Math.round((order.totalAmount - platformCommission) * 100) / 100;

    await PaymentEventLog.create({
      order: order._id,
      event: 'payment_initiated_razorpay',
      details: {
        amount: order.totalAmount,
        platformCommission,
        restaurantAmount,
        commissionPercent,
        recipientAccount: restaurant.razorpayAccountId
      }
    });

    const trace = getTraceContext();

    const amountInPaise = Math.round(order.totalAmount * 100);
    if (amountInPaise < 100) {
      return res.status(400).json({ success: false, error: 'Amount must be at least 100 paise (₹1.00).' });
    }

    if (isMockMode) {
      const mockOrderId = `order_mock_${Math.random().toString(36).substring(2, 10)}`;
      
      order.razorpayOrderId = mockOrderId;
      order.orderStatus = 'PENDING_PAYMENT';
      order.paymentStatus = 'CREATED';
      await order.save();

      await PaymentAuditLedger.create({
        order: order._id,
        restaurant: order.restaurant,
        correlationId: trace.correlationId,
        traceId: trace.traceId,
        event: 'razorpay_mock_order_created',
        stateTransition: { fromState: 'CREATED', toState: 'CREATED' },
        details: { razorpayOrderId: mockOrderId, isMock: true }
      });

      return res.status(200).json({
        success: true,
        isMock: true,
        order_id: mockOrderId,
        id: mockOrderId,
        amount: amountInPaise,
        currency: 'INR',
        marketplace: {
          recipientAccount: restaurant.razorpayAccountId,
          platformCommission,
          restaurantAmount
        }
      });
    }

    try {
      const response = await razorpay.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt: `receipt_order_${order._id.toString().slice(-6)}`
      });

      order.razorpayOrderId = response.id;
      order.orderStatus = 'PENDING_PAYMENT';
      order.paymentStatus = 'CREATED';
      await order.save();

      await PaymentAuditLedger.create({
        order: order._id,
        restaurant: order.restaurant,
        correlationId: trace.correlationId,
        traceId: trace.traceId,
        event: 'razorpay_order_created',
        stateTransition: { fromState: 'CREATED', toState: 'CREATED' },
        details: {
          razorpayOrderId: response.id,
          receipt: response.receipt
        }
      });

      logger.info(`[Payments] Razorpay Order created: ${response.id} for Order: ${order._id}`);

      return res.status(200).json({
        success: true,
        isMock: false,
        order_id: response.id,
        id: response.id,
        amount: response.amount,
        currency: response.currency,
        marketplace: {
          recipientAccount: restaurant.razorpayAccountId,
          platformCommission,
          restaurantAmount
        }
      });
    } catch (rzErr) {
      logger.error('[Payments] Razorpay order creation API failed', { error: rzErr.message, status: rzErr.statusCode });
      const isAuthError = rzErr.statusCode === 401 || /auth|unauthorized|invalid.*key/i.test(rzErr.message || '');
      if (isAuthError) {
        return res.status(401).json({
          success: false,
          error: 'Razorpay API Authentication failed: Invalid API keys.'
        });
      }
      return res.status(500).json({
        success: false,
        error: `Razorpay Order creation failed: ${rzErr.message}`
      });
    }
  } catch (err) {
    logger.error('[Payments] create-order endpoint error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

const verifyPaymentHandler = async (req, res) => {
  const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature, isMock } = req.body;

  try {
    // 1. Missing fields validation
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Missing Razorpay checkout parameters for verification.' });
    }

    // 2. Direct verification (no database order linked)
    if (!orderId) {
      const generatedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');

      if (generatedSignature !== razorpay_signature) {
        logger.warn('[Payments Verify] Signature mismatch on direct verification');
        return res.status(400).json({ success: false, error: 'Payment signature verification failed.' });
      }
      return res.status(200).json({ success: true, message: 'Payment signature verified successfully.' });
    }

    // 3. Database order-backed verification
    const order = await Order.findById(orderId).populate('restaurant');
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (order.paymentStatus === 'PAID') {
      return res.status(200).json({
        success: true,
        message: 'Order already processed and paid',
        order
      });
    }

    const restaurant = order.restaurant;
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant linked to order not found' });
    }

    if (isMockMode || isMock) {
      const io = req.app.get('io');
      const mockTxId = razorpay_payment_id || `pay_mock_${Math.random().toString(36).substring(2, 10)}`;
      
      const result = await handlePaymentSuccess(io, {
        orderId,
        transactionId: mockTxId,
        signature: null,
        eventId: null,
        isMock: true
      });

      order.razorpayPaymentId = mockTxId;
      await order.save();

      return res.status(200).json(result);
    }

    if (!canTransition(order.paymentStatus, 'PROCESSING')) {
      return res.status(400).json({ success: false, error: 'Invalid order payment status transition sequence.' });
    }

    // Secure cryptographic signature check
    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (generatedSignature !== razorpay_signature) {
      logger.warn('[Payments] Signature verification failed');
      return res.status(400).json({ success: false, error: 'Payment signature verification failed. Secure check failed.' });
    }

    // Transition payment to processing
    order.paymentStatus = 'PROCESSING';
    order.orderStatus = 'PAYMENT_PROCESSING';
    order.razorpayPaymentId = razorpay_payment_id;
    await order.save();

    const trace = getTraceContext();
    await PaymentAuditLedger.create({
      order: order._id,
      restaurant: order.restaurant,
      correlationId: trace.correlationId,
      traceId: trace.traceId,
      event: 'payment_verify_initiated',
      stateTransition: { fromState: 'CREATED', toState: 'PROCESSING' },
      details: { razorpay_order_id, razorpay_payment_id }
    });

    const io = req.app.get('io');
    const result = await handlePaymentSuccess(io, {
      orderId: order._id,
      transactionId: razorpay_payment_id,
      signature: razorpay_signature,
      eventId: `verify_${razorpay_payment_id}`,
      isMock: false
    });

    return res.status(200).json(result);
  } catch (err) {
    logger.error('[Payments Verify] Error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
};

// Register verification endpoints
router.post('/verify', redisRateLimiter('verify', 15, 60), verifyPaymentHandler);
router.post('/verify-payment', redisRateLimiter('verify', 15, 60), verifyPaymentHandler);

export default router;
