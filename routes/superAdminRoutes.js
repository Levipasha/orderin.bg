import express from 'express';
import { protect, authorize } from '../middleware/auth.js';
import User from '../models/User.js';
import Restaurant from '../models/Restaurant.js';
import Order from '../models/Order.js';
import Category from '../models/Category.js';
import Subscription from '../models/Subscription.js';
import Coupon from '../models/Coupon.js';
import Payment from '../models/Payment.js';
import Payout from '../models/Payout.js';

const router = express.Router();

// Apply protection and role checks to all super-admin endpoints
router.use(protect);
router.use(authorize('super_admin'));

// @desc    Get dashboard analytics
// @route   GET /api/super-admin/analytics
router.get('/analytics', async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    const totalRestaurants = await Restaurant.countDocuments();
    const totalUsers = await User.countDocuments({ role: 'customer' });
    
    const revenueStats = await Order.aggregate([
      { $match: { paymentStatus: 'paid' } },
      { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } }
    ]);
    const totalRevenue = revenueStats[0]?.totalRevenue || 0;

    const restaurantsByStatus = await Restaurant.aggregate([
      { $group: { _id: '$isActive', count: { $sum: 1 } } }
    ]);

    const activeSubscriptions = await Subscription.countDocuments({ status: 'active' });

    res.status(200).json({
      success: true,
      analytics: {
        totalOrders,
        totalRestaurants,
        totalUsers,
        totalRevenue,
        activeSubscriptions,
        restaurantsByStatus
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Get all restaurants list
// @route   GET /api/super-admin/restaurants
router.get('/restaurants', async (req, res) => {
  try {
    const now = new Date();
    await Restaurant.updateMany(
      { subscriptionExpiry: { $lt: now }, subscriptionActive: true },
      { subscriptionActive: false, isActive: false }
    );
    const restaurants = await Restaurant.find().populate('owner', 'name email phone');
    res.status(200).json({ success: true, restaurants });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Approve or toggle active status of restaurant
// @route   PUT /api/super-admin/restaurants/:id/status
router.put('/restaurants/:id/status', async (req, res) => {
  const { isApproved, isActive } = req.body;
  try {
    const updateData = {};
    if (isApproved !== undefined) updateData.isApproved = isApproved;
    if (isActive !== undefined) updateData.isActive = isActive;

    const restaurant = await Restaurant.findByIdAndUpdate(req.params.id, updateData, { new: true });
    
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    res.status(200).json({ success: true, message: 'Restaurant status updated', restaurant });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Create a global menu category
// @route   POST /api/super-admin/categories
router.post('/categories', async (req, res) => {
  const { name, image } = req.body;
  try {
    const category = await Category.create({ name, image, restaurant: null });
    res.status(201).json({ success: true, category });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Create global discount coupon
// @route   POST /api/super-admin/coupons
router.post('/coupons', async (req, res) => {
  const { code, discountType, discountValue, minOrderAmount, expiryDate } = req.body;
  try {
    const coupon = await Coupon.create({
      code,
      discountType,
      discountValue,
      minOrderAmount,
      expiryDate,
      restaurant: null
    });
    res.status(201).json({ success: true, coupon });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Get unmasked bank details of a restaurant
// @route   GET /api/super-admin/restaurants/:id/bank-details
router.get('/restaurants/:id/bank-details', async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id).lean();
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }
    res.status(200).json({
      success: true,
      bankDetails: restaurant.bankDetails
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Get payout ledger for all restaurants
// @route   GET /api/super-admin/payouts/ledger
router.get('/payouts/ledger', async (req, res) => {
  try {
    const restaurants = await Restaurant.find().populate('owner', 'name email phone').lean();
    
    const ledger = await Promise.all(restaurants.map(async (rest) => {
      // Sum payments
      const payments = await Payment.find({
        restaurant: rest._id,
        status: { $in: ['PAID', 'success'] }
      });
      const totalSales = payments.reduce((sum, p) => sum + p.amount, 0);
      const netEarnings = payments.reduce((sum, p) => sum + p.restaurantAmount, 0);
      
      // Sum payouts
      const payouts = await Payout.find({
        restaurant: rest._id,
        status: 'processed'
      });
      const totalPaid = payouts.reduce((sum, p) => sum + p.amount, 0);
      
      return {
        restaurantId: rest._id,
        name: rest.name,
        ownerName: rest.ownerName || rest.owner?.name || 'N/A',
        email: rest.email || rest.owner?.email || 'N/A',
        phone: rest.phone || rest.owner?.phone || 'N/A',
        bankDetails: rest.bankDetails, // Unmasked since we used .lean()!
        totalSales: Math.round(totalSales * 100) / 100,
        netEarnings: Math.round(netEarnings * 100) / 100,
        totalPaid: Math.round(totalPaid * 100) / 100,
        pendingBalance: Math.round((netEarnings - totalPaid) * 100) / 100,
        payoutHistory: payouts
      };
    }));
    
    res.status(200).json({ success: true, ledger });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Record a manual bank transfer payout to a restaurant
// @route   POST /api/super-admin/payouts
router.post('/payouts', async (req, res) => {
  const { restaurantId, amount, referenceId } = req.body;
  if (!restaurantId || !amount) {
    return res.status(400).json({ success: false, error: 'Restaurant ID and payout amount are required' });
  }
  try {
    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }
    
    const payout = await Payout.create({
      restaurant: restaurantId,
      amount: Number(amount),
      payoutMethod: 'manual',
      referenceId: referenceId || `manual_ref_${Date.now()}`,
      status: 'processed',
      settledAt: new Date()
    });
    
    res.status(201).json({ success: true, message: 'Manual payout logged successfully', payout });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
