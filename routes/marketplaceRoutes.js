import express from 'express';
import { protect, authorize } from '../middleware/auth.js';
import Restaurant from '../models/Restaurant.js';
import KycDocument from '../models/KycDocument.js';
import Transfer from '../models/Transfer.js';
import Payout from '../models/Payout.js';
import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import { createLinkedAccount, isMockMode } from '../services/razorpayRouteService.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Apply auth protection to all routes
router.use(protect);

/**
 * @route   POST /api/marketplace/submit-kyc
 * @desc    Restaurant admin submits text-only KYC details (no file uploads required)
 * @access  restaurant_admin
 */
router.post('/submit-kyc', authorize('restaurant_admin'), async (req, res) => {
  const {
    ownerName, email, phone, panNumber, gstNumber, address,
    bankName, accountHolderName, accountNumber, ifscCode
  } = req.body;

  // Validate required fields
  if (!ownerName || !email || !phone || !panNumber || !address) {
    return res.status(400).json({ success: false, error: 'All business profile fields are required (ownerName, email, phone, panNumber, address).' });
  }
  if (!accountHolderName || !bankName || !accountNumber || !ifscCode) {
    return res.status(400).json({ success: false, error: 'All bank account details are required (accountHolderName, bankName, accountNumber, ifscCode).' });
  }

  // PAN format validation
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(panNumber)) {
    return res.status(400).json({ success: false, error: 'Invalid PAN number format. Expected format: ABCDE1234F' });
  }

  // IFSC code validation
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
    return res.status(400).json({ success: false, error: 'Invalid IFSC code format. Expected format: ABCD0123456' });
  }

  // Account number validation
  if (!/^[0-9]{9,18}$/.test(accountNumber)) {
    return res.status(400).json({ success: false, error: 'Invalid bank account number. Must be 9–18 digits.' });
  }

  // Optional GST validation
  if (gstNumber && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstNumber)) {
    return res.status(400).json({ success: false, error: 'Invalid GSTIN format. Expected: 22ABCDE1234F1Z5 (or leave empty)' });
  }

  try {
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant profile not found. Please complete your restaurant setup first.' });
    }

    // Update restaurant fields
    restaurant.ownerName = ownerName;
    restaurant.email = email;
    restaurant.phone = phone;
    restaurant.panNumber = panNumber;
    restaurant.gstNumber = gstNumber || '';
    restaurant.address = address;
    restaurant.bankDetails.bankName = bankName;
    restaurant.bankDetails.accountHolderName = accountHolderName;
    restaurant.bankDetails.accountNumber = accountNumber;
    restaurant.bankDetails.ifscCode = ifscCode;
    
    // Auto-approve KYC for single-account manual payout model
    restaurant.kycStatus = 'verified';
    restaurant.settlementStatus = 'active';

    await restaurant.save();

    logger.info(`[Marketplace API] Text-only KYC submitted for restaurant: ${restaurant.name} (${restaurant._id})`);

    return res.status(200).json({
      success: true,
      message: 'KYC details submitted successfully! A Super Admin will review and approve your account.',
      kycStatus: 'submitted',
      restaurant
    });
  } catch (err) {
    logger.error('[Marketplace API] KYC submission failed', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});



/**
 * @route   POST /api/marketplace/kyc/verify
 * @desc    Super Admin approves/rejects restaurant's KYC document submission
 * @access  super_admin
 */
router.post('/kyc/verify', authorize('super_admin'), async (req, res) => {
  const { restaurantId, action, rejectionReason } = req.body; // action: 'approve' | 'reject'

  // Task 16: Log incoming restaurant ID
  console.log(`[KYC VERIFY REQUEST] Incoming restaurant ID: ${restaurantId}, Action: ${action}`);

  if (!restaurantId || !action) {
    return res.status(400).json({ success: false, error: 'Restaurant ID and action (approve/reject) are required' });
  }

  try {
    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) {
      console.log(`[KYC VERIFY VALIDATION FAIL] Restaurant not found in database: ${restaurantId}`);
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    // Task 16: Log retrieved restaurant details
    console.log(`[KYC VERIFY RETRIEVED RESTAURANT] Name: ${restaurant.name}, Current Status: ${restaurant.kycStatus}`);

    // Try to find a KYC document (for document-based flow — optional for text-only flow)
    const kycDoc = await KycDocument.findOne({ restaurant: restaurantId });

    if (action === 'reject') {
      // Update KYC document if it exists
      if (kycDoc) {
        kycDoc.status = 'rejected';
        kycDoc.rejectionReason = rejectionReason || 'Information submitted did not meet requirements.';
        await kycDoc.save();
      }

      restaurant.kycStatus = 'rejected';
      restaurant.settlementStatus = 'suspended';
      await restaurant.save();

      logger.info(`[Marketplace API] KYC rejected for restaurant: ${restaurant.name}. Reason: ${rejectionReason || 'Requirements not met'}`);
      return res.status(200).json({
        success: true,
        message: 'KYC rejected. Restaurant has been notified to resubmit with corrected details.',
        restaurant
      });
    }

    if (action === 'approve') {
      // Task 2: Validate restaurant KYC data BEFORE Razorpay API call
      // businessName exists, ownerName, email, phone, panNumber, accountNumber, ifscCode, accountHolderName
      const missingFields = [];
      if (!restaurant.name && !restaurant.businessName) missingFields.push('businessName/name');
      if (!restaurant.ownerName) missingFields.push('ownerName');
      if (!restaurant.email) missingFields.push('email');
      if (!restaurant.phone) missingFields.push('phone');
      if (!restaurant.panNumber) missingFields.push('panNumber');
      if (!restaurant.bankDetails?.accountNumber) missingFields.push('bankDetails.accountNumber');
      if (!restaurant.bankDetails?.ifscCode) missingFields.push('bankDetails.ifscCode');
      if (!restaurant.bankDetails?.accountHolderName) missingFields.push('bankDetails.accountHolderName');

      if (missingFields.length > 0) {
        console.log(`[KYC VERIFY VALIDATION FAIL] Missing fields: [${missingFields.join(', ')}]`);
        return res.status(400).json({
          success: false,
          message: 'Missing required KYC fields',
          error: `Missing required KYC fields: ${missingFields.join(', ')}`
        });
      }

      // Task 4: Validate PAN format before API call
      const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
      if (!panRegex.test(restaurant.panNumber)) {
        console.log(`[KYC VERIFY VALIDATION FAIL] Invalid PAN format: ${restaurant.panNumber}`);
        return res.status(400).json({
          success: false,
          message: 'Invalid PAN number format. Expected format: ABCDE1234F',
          error: 'Invalid PAN format.'
        });
      }

      // Task 5: Validate IFSC format
      const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
      if (!ifscRegex.test(restaurant.bankDetails.ifscCode)) {
        console.log(`[KYC VERIFY VALIDATION FAIL] Invalid IFSC format: ${restaurant.bankDetails.ifscCode}`);
        return res.status(400).json({
          success: false,
          message: 'Invalid IFSC code format. Expected format: ABCD0123456',
          error: 'Invalid IFSC format.'
        });
      }

      // Task 6: Validate phone format (exactly 10 digits)
      const phoneDigits = restaurant.phone.replace(/[^0-9]/g, '');
      if (phoneDigits.length !== 10) {
        console.log(`[KYC VERIFY VALIDATION FAIL] Phone is not 10 digits: ${restaurant.phone}`);
        return res.status(400).json({
          success: false,
          message: 'Contact phone must be exactly 10 digits.',
          error: 'Invalid phone length.'
        });
      }

      // Task 16: Log validation pass
      console.log(`[KYC VERIFY VALIDATION SUCCESS] All required fields verified successfully.`);

      // Update KYC document status if it exists
      if (kycDoc) {
        kycDoc.status = 'verified';
        kycDoc.rejectionReason = '';
        await kycDoc.save();
      }

      // Trigger Razorpay Linked Account Creation
      try {
        // Task 16: Log Razorpay request started
        console.log(`[KYC VERIFY RAZORPAY REQUEST STARTED] Registering Linked Account on Razorpay Route for ${restaurant.name}...`);
        
        const updatedRestaurant = await createLinkedAccount(restaurant);
        
        // Task 16: Log Razorpay response received & Mongo save success
        console.log(`[KYC VERIFY RAZORPAY RESPONSE RECEIVED] Successfully provisioned Linked Account: ${updatedRestaurant.razorpayAccountId}`);
        console.log(`[KYC VERIFY MONGO SAVE SUCCESS] Updated restaurant database entry saved successfully.`);

        logger.info(`[Marketplace API] KYC approved and Razorpay Linked Account created for restaurant: ${restaurant.name}`);
        return res.status(200).json({
          success: true,
          message: 'Linked Account created successfully',
          restaurant: updatedRestaurant,
          isMock: isMockMode
        });
      } catch (rzErr) {
        logger.error('[Marketplace API] Razorpay linked account provisioning failed', { error: rzErr.message });
        
        // Reset state defensively so restaurant can retry after correcting details
        if (kycDoc) {
          kycDoc.status = 'submitted';
          await kycDoc.save();
        } else {
          restaurant.kycStatus = 'submitted';
          await restaurant.save();
        }

        // Task 5: Add safe backend response handling (NEVER return undefined, return explicit error message)
        const errorDescription = rzErr.message || 'Linked account creation failed';
        return res.status(400).json({
          success: false,
          message: errorDescription,
          error: errorDescription
        });
      }
    }

    return res.status(400).json({ success: false, error: 'Invalid action parameter. Use approve or reject.' });
  } catch (err) {
    logger.error('[Marketplace API] KYC approval/rejection failed', { error: err.message });
    return res.status(500).json({ success: false, message: err.message || 'Internal server error', error: err.message });
  }
});

/**
 * @route   GET /api/marketplace/pending-kyc
 * @desc    Get all restaurants with submitted KYC (text-only + document-based)
 * @access  super_admin
 */
router.get('/pending-kyc', authorize('super_admin'), async (req, res) => {
  try {
    // Fetch restaurants that have submitted KYC (text-only flow)
    const submittedRestaurants = await Restaurant.find({ kycStatus: 'submitted' })
      .populate('owner', 'name email')
      .sort({ updatedAt: -1 })
      .lean();

    // Also fetch any document-based KYC submissions for backward compatibility
    const kycDocs = await KycDocument.find({ status: 'submitted' })
      .populate('restaurant', 'name ownerName email phone kycStatus bankDetails panNumber gstNumber address')
      .sort({ updatedAt: -1 })
      .lean();

    // Build unified list: restaurant-native entries + doc-based entries not already covered
    const restaurantIds = new Set(submittedRestaurants.map(r => r._id.toString()));
    const docBasedExtra = kycDocs.filter(d => d.restaurant && !restaurantIds.has(d.restaurant._id?.toString()));

    // Format restaurant-direct entries to match the doc-based shape expected by frontend
    const restaurantEntries = submittedRestaurants.map(r => ({
      _id: r._id,
      restaurant: r,
      panCardUrl: null,
      bankProofUrl: null,
      gstCertificateUrl: null,
      aadhaarUrl: null,
      isTextOnlyKyc: true,
      updatedAt: r.updatedAt
    }));

    const pendingKyc = [...restaurantEntries, ...docBasedExtra];

    return res.status(200).json({ success: true, pendingKyc });
  } catch (err) {
    logger.error('[Marketplace API] pending-kyc fetch failed', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/marketplace/linked-account/status
 * @desc    Fetch Razorpay Linked Account details and validations for current restaurant
 * @access  restaurant_admin, super_admin
 */
router.get('/linked-account/status', authorize('restaurant_admin', 'super_admin'), async (req, res) => {
  try {
    let restaurant;
    if (req.user.role === 'super_admin' && req.query.restaurantId) {
      restaurant = await Restaurant.findById(req.query.restaurantId);
    } else {
      restaurant = await Restaurant.findOne({ owner: req.user._id });
    }

    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    const validations = {
      isPanValid: /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(restaurant.panNumber || ''),
      isIfscValid: /^[A-Z]{4}0[A-Z0-9]{6}$/.test(restaurant.bankDetails?.ifscCode || ''),
      isAccountNumberValid: /^[0-9]{9,18}$/.test(restaurant.bankDetails?.accountNumber || '')
    };

    return res.status(200).json({
      success: true,
      razorpayAccountId: restaurant.razorpayAccountId,
      kycStatus: restaurant.kycStatus,
      settlementStatus: restaurant.settlementStatus,
      bankDetails: restaurant.bankDetails,
      panNumber: restaurant.panNumber,
      gstNumber: restaurant.gstNumber,
      validations,
      isMock: isMockMode
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/marketplace/settlements
 * @desc    List split settlement transfers for a restaurant admin or platform superadmin
 * @access  restaurant_admin, super_admin
 */
router.get('/settlements', authorize('restaurant_admin', 'super_admin'), async (req, res) => {
  try {
    const filter = {};

    if (req.user.role === 'restaurant_admin') {
      const restaurant = await Restaurant.findOne({ owner: req.user._id });
      if (!restaurant) {
        return res.status(404).json({ success: false, error: 'Restaurant not found' });
      }
      filter.restaurant = restaurant._id;
    } else if (req.query.restaurantId) {
      filter.restaurant = req.query.restaurantId;
    }

    const transfers = await Transfer.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(req.query.limit, 10) || 50)
      .populate('order', 'totalAmount orderStatus tableNo customerName customerPhone')
      .lean();

    return res.status(200).json({ success: true, settlements: transfers });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/marketplace/payouts
 * @desc    List overall bank payout settlement histories for linked accounts
 * @access  restaurant_admin, super_admin
 */
router.get('/payouts', authorize('restaurant_admin', 'super_admin'), async (req, res) => {
  try {
    const filter = {};

    if (req.user.role === 'restaurant_admin') {
      const restaurant = await Restaurant.findOne({ owner: req.user._id });
      if (!restaurant) {
        return res.status(404).json({ success: false, error: 'Restaurant not found' });
      }
      filter.restaurant = restaurant._id;
    } else if (req.query.restaurantId) {
      filter.restaurant = req.query.restaurantId;
    }

    const payouts = await Payout.find(filter)
      .sort({ settledAt: -1 })
      .limit(parseInt(req.query.limit, 10) || 50)
      .lean();

    return res.status(200).json({ success: true, payouts });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/marketplace/analytics
 * @desc    Get detailed platform revenue and restaurant split statistics
 * @access  restaurant_admin, super_admin
 */
router.get('/analytics', authorize('restaurant_admin', 'super_admin'), async (req, res) => {
  try {
    let restaurant = null;
    let filter = {};

    if (req.user.role === 'restaurant_admin') {
      restaurant = await Restaurant.findOne({ owner: req.user._id });
      if (!restaurant) {
        return res.status(404).json({ success: false, error: 'Restaurant not found' });
      }
      filter.restaurant = restaurant._id;
    } else if (req.query.restaurantId) {
      filter.restaurant = req.query.restaurantId;
    }

    // 1. Fetch completed payments from Payment model
    const payments = await Payment.find({
      ...filter,
      status: { $in: ['PAID', 'success'] }
    });

    const totalSales = payments.reduce((sum, p) => sum + p.amount, 0);
    const restaurantShare = payments.reduce((sum, p) => sum + p.restaurantAmount, 0);
    const platformCommission = payments.reduce((sum, p) => sum + p.platformCommission, 0);

    // 2. Fetch completed Payouts (manual settlements)
    const completedPayouts = await Payout.find({ ...filter, status: 'processed' });
    const totalSettledToBank = completedPayouts.reduce((sum, p) => sum + p.amount, 0);

    return res.status(200).json({
      success: true,
      analytics: {
        totalSales: Math.round(totalSales * 100) / 100,
        restaurantShare: Math.round(restaurantShare * 100) / 100,
        platformCommission: Math.round(platformCommission * 100) / 100,
        settledToBank: Math.round(totalSettledToBank * 100) / 100,
        failedTransfersCount: 0,
        failedTransfersAmount: 0,
        pendingSettlements: Math.round((restaurantShare - totalSettledToBank) * 100) / 100
      }
    });
  } catch (err) {
    logger.error('[Marketplace API] Analytics retrieval failed', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
