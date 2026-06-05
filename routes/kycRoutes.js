import express from 'express';
import { protect, authorize } from '../middleware/auth.js';
import { uploadKycFields, getUploadedFileUrl } from '../middleware/upload.js';
import KycDocument from '../models/KycDocument.js';
import Restaurant from '../models/Restaurant.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Apply auth protection to all KYC routes
router.use(protect);

/**
 * @route   POST /api/restaurant/kyc/upload
 * @desc    Upload KYC documents (PAN card, bank proof, optional GST, optional Aadhaar)
 * @access  restaurant_admin, super_admin
 */
router.post('/upload', authorize('restaurant_admin', 'super_admin'), (req, res) => {
  uploadKycFields(req, res, async (err) => {
    if (err) {
      logger.error('[KYC Upload] Multer error', { error: err.message });
      return res.status(400).json({ success: false, error: err.message });
    }

    try {
      let restaurant;
      if (req.user.role === 'super_admin' && req.body.restaurantId) {
        restaurant = await Restaurant.findById(req.body.restaurantId);
      } else {
        restaurant = await Restaurant.findOne({ owner: req.user._id });
      }

      if (!restaurant) {
        return res.status(404).json({ success: false, error: 'Restaurant profile not found. Please create a profile first.' });
      }

      // Check files
      const files = req.files || {};
      
      if (!files.panCard) {
        return res.status(400).json({ success: false, error: 'PAN card image/pdf is required for verification.' });
      }
      if (!files.bankProof) {
        return res.status(400).json({ success: false, error: 'Bank proof (cancelled cheque or statement) is required.' });
      }

      // Extract URLs
      const panCardUrl = getUploadedFileUrl(files.panCard[0]);
      const bankProofUrl = getUploadedFileUrl(files.bankProof[0]);
      const gstCertificateUrl = files.gstCertificate ? getUploadedFileUrl(files.gstCertificate[0]) : '';
      const aadhaarUrl = files.aadhaar ? getUploadedFileUrl(files.aadhaar[0]) : '';

      // Save or update KYC document
      let kycDoc = await KycDocument.findOne({ restaurant: restaurant._id });
      
      if (kycDoc) {
        kycDoc.panCardUrl = panCardUrl;
        kycDoc.bankProofUrl = bankProofUrl;
        if (gstCertificateUrl) kycDoc.gstCertificateUrl = gstCertificateUrl;
        if (aadhaarUrl) kycDoc.aadhaarUrl = aadhaarUrl;
        kycDoc.status = 'submitted';
        kycDoc.rejectionReason = '';
        await kycDoc.save();
      } else {
        kycDoc = await KycDocument.create({
          restaurant: restaurant._id,
          panCardUrl,
          bankProofUrl,
          gstCertificateUrl,
          aadhaarUrl,
          status: 'submitted'
        });
      }

      // Update restaurant details if sent in body
      if (req.body.ownerName) restaurant.ownerName = req.body.ownerName;
      if (req.body.email) restaurant.email = req.body.email;
      if (req.body.phone) restaurant.phone = req.body.phone;
      if (req.body.panNumber) restaurant.panNumber = req.body.panNumber;
      if (req.body.gstNumber) restaurant.gstNumber = req.body.gstNumber; // Optional GST Number
      if (req.body.address) restaurant.address = req.body.address;
      
      if (req.body.bankName) restaurant.bankDetails.bankName = req.body.bankName;
      if (req.body.accountHolderName) restaurant.bankDetails.accountHolderName = req.body.accountHolderName;
      if (req.body.accountNumber) restaurant.bankDetails.accountNumber = req.body.accountNumber;
      if (req.body.ifscCode) restaurant.bankDetails.ifscCode = req.body.ifscCode;

      // Update global KYC state
      restaurant.kycStatus = 'submitted';
      await restaurant.save();

      logger.info(`[KYC Upload] Onboarding documents submitted for restaurant: ${restaurant.name}`);

      return res.status(200).json({
        success: true,
        message: 'KYC documents and business details submitted successfully for review.',
        kycStatus: 'submitted',
        kycDocument: kycDoc,
        restaurant
      });
    } catch (dbErr) {
      logger.error('[KYC Upload] Database error', { error: dbErr.message });
      return res.status(500).json({ success: false, error: dbErr.message });
    }
  });
});

/**
 * @route   GET /api/restaurant/kyc/status
 * @desc    Get KYC document and status details for the current restaurant
 * @access  restaurant_admin, super_admin
 */
router.get('/status', authorize('restaurant_admin', 'super_admin'), async (req, res) => {
  try {
    let restaurant;
    if (req.user.role === 'super_admin' && req.query.restaurantId) {
      restaurant = await Restaurant.findById(req.query.restaurantId);
    } else {
      restaurant = await Restaurant.findOne({ owner: req.user._id });
    }

    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant profile not found' });
    }

    const kycDoc = await KycDocument.findOne({ restaurant: restaurant._id });

    return res.status(200).json({
      success: true,
      kycStatus: restaurant.kycStatus,
      settlementStatus: restaurant.settlementStatus,
      razorpayAccountId: restaurant.razorpayAccountId,
      bankDetails: restaurant.bankDetails,
      businessDetails: {
        ownerName: restaurant.ownerName,
        email: restaurant.email,
        phone: restaurant.phone,
        panNumber: restaurant.panNumber,
        gstNumber: restaurant.gstNumber,
        address: restaurant.address
      },
      kycDocument: kycDoc || null
    });
  } catch (err) {
    logger.error('[KYC Status] Error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
