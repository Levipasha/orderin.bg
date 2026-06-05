import express from 'express';
import EmailLog from '../models/EmailLog.js';
import { generateInvoicePdf } from '../utils/invoiceGenerator.js';
import { 
  sendWelcomeEmail, 
  sendLoginAlertEmail, 
  sendSubscriptionEmail, 
  sendExpiryReminderEmail, 
  sendExpiredEmail, 
  sendPaymentSuccessEmail, 
  sendPaymentFailedEmail,
  sendAdminAlert
} from '../services/emailService.js';
import { runSubscriptionBillingCheck } from '../utils/emailScheduler.js';
import logger from '../utils/logger.js';
import { SUBSCRIPTION_MONTHLY_PRICE_INR } from '../config/subscription.js';

const router = express.Router();

/**
 * GET /api/emails/logs
 * Fetches all tracked email logs from MongoDB with pagination, filtering, and sorting.
 */
router.get('/logs', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.recipient) {
      filter.recipient = new RegExp(req.query.recipient.trim(), 'i');
    }
    if (req.query.status) {
      filter.status = req.query.status;
    }
    if (req.query.emailType) {
      filter.emailType = req.query.emailType;
    }

    const logs = await EmailLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId', 'name email');

    const total = await EmailLog.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: {
        logs,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    logger.error(`[Email Routes] Failed loading email logs: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/emails/test-welcome
 * Triggers a welcome email test payload.
 */
router.post('/test-welcome', async (req, res) => {
  const { email, name } = req.body;
  
  if (!email || !name) {
    return res.status(400).json({ success: false, error: 'Email and Name are required.' });
  }

  try {
    sendWelcomeEmail(email, name);
    res.status(200).json({ 
      success: true, 
      message: `Welcome email for '${name}' enqueued successfully to background process queue.` 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/emails/test-invoice
 * Generates mock PDF invoice and enqueues a Payment Success invoice notification.
 */
router.post('/test-invoice', async (req, res) => {
  const { email, name, amount } = req.body;

  if (!email || !name) {
    return res.status(400).json({ success: false, error: 'Email and Name are required.' });
  }

  try {
    const totalAmount = parseFloat(amount) || SUBSCRIPTION_MONTHLY_PRICE_INR;
    const gstAmount = parseFloat((totalAmount * 0.18 / 1.18).toFixed(2)); // Reverse GST (18%)
    
    const mockInvoiceData = {
      invoiceNumber: `INV-${Math.floor(100000 + Math.random() * 900000)}`,
      transactionId: `pay_${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
      orderId: `order_${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
      customerName: name,
      customerEmail: email,
      planName: 'Premium Pro',
      amountPaid: totalAmount,
      gstAmount,
      paymentDate: new Date(),
      paymentMethod: 'razorpay'
    };

    // 1. Generate PDF Kit invoice
    const pdfBuffer = await generateInvoicePdf(mockInvoiceData);

    // 2. Dispatch email with PDF attachment enqueued
    sendPaymentSuccessEmail(email, name, mockInvoiceData, pdfBuffer);

    res.status(200).json({
      success: true,
      message: `Tax Invoice PDF generated successfully. Payment success email with invoice attachment enqueued.`,
      invoiceDetails: mockInvoiceData
    });
  } catch (err) {
    logger.error(`[Email Routes] Test invoice flow crashed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/emails/test-failed-payment
 * Triggers a payment failed alert notification.
 */
router.post('/test-failed-payment', async (req, res) => {
  const { email, name, amount, reason } = req.body;

  if (!email || !name) {
    return res.status(400).json({ success: false, error: 'Email and Name are required.' });
  }

  try {
    sendPaymentFailedEmail(email, name, {
      planName: 'Premium Pro',
      amountPaid: parseFloat(amount) || SUBSCRIPTION_MONTHLY_PRICE_INR,
      failureReason: reason || 'Insufficient funds in customer card or authentication challenge failed.',
      gateway: 'Razorpay Secure Gateway',
      retryUrl: 'https://orderin.com/login'
    });

    res.status(200).json({
      success: true,
      message: `Payment failed email for '${name}' enqueued successfully.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/emails/trigger-scheduler
 * Developer routing to run daily subscription billing scan immediately.
 */
router.post('/trigger-scheduler', async (req, res) => {
  try {
    const summary = await runSubscriptionBillingCheck();
    res.status(200).json({
      success: true,
      message: 'Subscription billing scan trigger executed successfully.',
      summary
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
