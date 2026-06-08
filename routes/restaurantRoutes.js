import express from 'express';
import QRCode from 'qrcode';
import { protect, authorize } from '../middleware/auth.js';
import Restaurant from '../models/Restaurant.js';
import Menu from '../models/Menu.js';
import Category from '../models/Category.js';
import Review from '../models/Review.js';
import Order from '../models/Order.js';
import DailyAnalytics from '../models/DailyAnalytics.js';
import Coupon from '../models/Coupon.js';
import { sendSubscriptionEmail, sendPaymentSuccessEmail, sendAdminAlert } from '../services/emailService.js';
import { generateInvoicePdf } from '../utils/invoiceGenerator.js';
import { SUBSCRIPTION_MONTHLY_PRICE_INR } from '../config/subscription.js';

const router = express.Router();

// Public routes for Customers
const checkAndExpireSubscriptions = async () => {
  const now = new Date();
  await Restaurant.updateMany(
    { subscriptionExpiry: { $lt: now }, subscriptionActive: true },
    { subscriptionActive: false, isActive: false }
  );
};

// @desc    Get all active approved restaurants (public listing)
// @route   GET /api/restaurant/public/list
router.get('/public/list', async (req, res) => {
  try {
    await checkAndExpireSubscriptions();
    // Tolerant check so that newly created SaaS trial restaurants are visible instantly!
    const restaurants = await Restaurant.find({ isActive: true });
    res.status(200).json({ success: true, restaurants });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Get all active menu items/dishes across all active restaurants
// @route   GET /api/restaurant/public/dishes
router.get('/public/dishes', async (req, res) => {
  try {
    const activeRestaurants = await Restaurant.find({ isActive: true });
    const restaurantIds = activeRestaurants.map(r => r._id);

    const dishes = await Menu.find({
      restaurant: { $in: restaurantIds },
      isActive: true,
      inStock: true
    }).populate('restaurant', 'name slug logo banner theme rating tagline contact address')
      .populate('category', 'name image');

    res.status(200).json({ success: true, dishes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Get all unique active categories (public listing)
// @route   GET /api/restaurant/public/categories
router.get('/public/categories', async (req, res) => {
  try {
    const activeRestaurants = await Restaurant.find({ isActive: true });
    const restaurantIds = activeRestaurants.map(r => r._id);

    const categories = await Category.find({
      $or: [
        { restaurant: { $in: restaurantIds } },
        { restaurant: null }
      ],
      isActive: true
    }).sort({ name: 1 });

    res.status(200).json({ success: true, categories });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Get restaurant profile by slug (for customer menu viewing)
// @route   GET /api/restaurant/public/:slug
router.get('/public/:slug', async (req, res) => {
  try {
    await checkAndExpireSubscriptions();
    const restaurant = await Restaurant.findOne({ slug: req.params.slug.toLowerCase() });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }
    
    const isServiceActive = restaurant.isApproved && restaurant.isActive;

    // Fetch categories specific to this restaurant AND global categories (only if approved and active)
    const categories = isServiceActive
      ? await Category.find({
          $or: [
            { restaurant: restaurant._id },
            { restaurant: null } // global categories
          ],
          isActive: true
        })
      : [];

    // Fetch active menus (only if approved and active)
    const menus = isServiceActive
      ? await Menu.find({ restaurant: restaurant._id, isActive: true }).populate('category')
      : [];

    // Fetch active coupons specific to this restaurant AND global coupons (only if approved and active)
    const coupons = isServiceActive
      ? await Coupon.find({
          $or: [
            { restaurant: restaurant._id },
            { restaurant: null }
          ],
          isActive: true
        })
      : [];

    res.status(200).json({
      success: true,
      restaurant,
      categories,
      menus,
      coupons
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Protected routes (Requires Auth and Restaurant Admin role)
router.use(protect);
router.use(authorize('restaurant_admin', 'super_admin'));

// @desc    Create/Update restaurant profile
// @route   POST /api/restaurant/profile
router.post('/profile', async (req, res) => {
  const { name, slug, logo, banner, theme, timings, contact, settings, bankDetails, tagline, address, pinCode, ownerName, email, phone, panNumber, gstNumber, fssaiNumber, subscriptionPlan, subscriptionExpiry, subscriptionActive } = req.body;
  try {
    let restaurant = await Restaurant.findOne({ owner: req.user._id });
    
    const fieldsToUpdate = {
      name,
      slug: slug ? slug.toLowerCase().replace(/\s+/g, '-') : undefined,
      logo,
      banner,
      theme,
      timings,
      contact,
      settings,
      bankDetails,
      tagline,
      address,
      pinCode,
      ownerName,
      email,
      phone,
      panNumber,
      gstNumber,
      fssaiNumber,
      subscriptionPlan,
      subscriptionExpiry,
      subscriptionActive
    };

    // Clean undefined fields
    Object.keys(fieldsToUpdate).forEach(key => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]);

    if (restaurant) {
      restaurant = await Restaurant.findByIdAndUpdate(restaurant._id, fieldsToUpdate, { new: true });
      res.status(200).json({
        success: true,
        message: 'Profile updated successfully',
        restaurant
      });
    } else {
      fieldsToUpdate.owner = req.user._id;
      fieldsToUpdate.isApproved = true; // Auto-approve on creation for instant SaaS preview/onboarding!
      restaurant = await Restaurant.create(fieldsToUpdate);
      res.status(201).json({
        success: true,
        message: 'Restaurant profile created successfully',
        restaurant
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Get current user's restaurant profile
// @route   GET /api/restaurant/profile/me
router.get('/profile/me', async (req, res) => {
  try {
    await checkAndExpireSubscriptions();
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant profile not found for this admin' });
    }
    res.status(200).json({ success: true, restaurant });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Renew subscription for logged in restaurant owner
// @route   POST /api/restaurant/subscription/renew
router.post('/subscription/renew', async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant profile not found' });
    }

    // Extend subscription by 30 days
    const extendDays = 30;
    const newExpiry = new Date(Math.max(Date.now(), new Date(restaurant.subscriptionExpiry || Date.now()).getTime()) + extendDays * 24 * 60 * 60 * 1000);

    restaurant.subscriptionPlan = 'basic';
    restaurant.subscriptionExpiry = newExpiry;
    restaurant.subscriptionActive = true;
    restaurant.isActive = true; // reactivate account (start services!)
    await restaurant.save();

    // ── Trigger Dynamic PDF Invoice & Billing Success Emails ──
    try {
      const amountPaid = SUBSCRIPTION_MONTHLY_PRICE_INR;
      const gstAmount = parseFloat((amountPaid * 0.18 / 1.18).toFixed(2)); // Reverse GST (18%)
      const ownerEmail = req.user.email || restaurant.email || restaurant.contact?.email;
      const ownerName = req.user.name || restaurant.ownerName || 'Restaurant Partner';

      const invoiceDetails = {
        invoiceNumber: `INV-${Math.floor(100000 + Math.random() * 900000)}`,
        transactionId: `pay_${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
        orderId: `order_${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
        customerName: ownerName,
        customerEmail: ownerEmail,
        planName: 'Premium Pro',
        amountPaid,
        gstAmount,
        paymentDate: new Date(),
        paymentMethod: 'razorpay'
      };

      // 1. Generate PDF
      const pdfBuffer = await generateInvoicePdf(invoiceDetails);

      // 2. Dispatch Success Emails & Invoice attachment enqueued
      sendPaymentSuccessEmail(ownerEmail, ownerName, invoiceDetails, pdfBuffer);

      sendSubscriptionEmail(ownerEmail, ownerName, {
        planName: 'Premium Pro',
        amountPaid,
        billingCycle: 'Monthly',
        startDate: new Date(),
        expiryDate: newExpiry,
        transactionId: invoiceDetails.transactionId,
        paymentMethod: 'Razorpay Secure'
      });

      // 3. Dispatch Administrative notification alerts
      sendAdminAlert('admin@Orderin.com', ownerName, 'subscription_purchased', {
        restaurantId: restaurant._id,
        restaurantName: restaurant.name,
        amount: amountPaid,
        expiryDate: newExpiry
      });
    } catch (mailErr) {
      console.error('[Billing Mail Error] Failed to generate invoice or dispatch checkout notifications:', mailErr.message);
    }

    res.status(200).json({
      success: true,
      message: 'Subscription successfully renewed for 1 month! All services are active.',
      restaurant
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Add categories
// @route   POST /api/restaurant/categories
router.post('/categories', async (req, res) => {
  const { name, image } = req.body;
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Please create restaurant profile first' });
    }

    const category = await Category.create({
      name,
      image,
      restaurant: restaurant._id
    });
    res.status(201).json({ success: true, category });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Add / Edit / Delete Menu Items
// @route   POST /api/restaurant/menu
router.post('/menu', async (req, res) => {
  const { name, description, category, price, discountPrice, foodType, tags, addons, image } = req.body;
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant profile not found' });
    }

    const menuItem = await Menu.create({
      restaurant: restaurant._id,
      category,
      name,
      description,
      price,
      discountPrice,
      foodType,
      tags,
      addons,
      image
    });

    res.status(201).json({ success: true, menuItem });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Edit a menu item
// @route   PUT /api/restaurant/menu/:id
router.put('/menu/:id', async (req, res) => {
  const { name, description, category, price, discountPrice, foodType, tags, addons, image, inStock } = req.body;
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant profile not found' });
    }

    const menuItem = await Menu.findOneAndUpdate(
      { _id: req.params.id, restaurant: restaurant._id },
      { name, description, category, price, discountPrice, foodType, tags, addons, image, inStock },
      { new: true }
    );

    if (!menuItem) {
      return res.status(404).json({ success: false, error: 'Menu item not found' });
    }

    res.status(200).json({ success: true, menuItem });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Delete a menu item
// @route   DELETE /api/restaurant/menu/:id
router.delete('/menu/:id', async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant profile not found' });
    }

    const menuItem = await Menu.findOneAndDelete({ _id: req.params.id, restaurant: restaurant._id });
    if (!menuItem) {
      return res.status(404).json({ success: false, error: 'Menu item not found' });
    }

    res.status(200).json({ success: true, message: 'Menu item deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Delete category
// @route   DELETE /api/restaurant/categories/:id
router.delete('/categories/:id', async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant profile not found' });
    }

    const category = await Category.findOneAndDelete({ _id: req.params.id, restaurant: restaurant._id });
    if (!category) {
      return res.status(404).json({ success: false, error: 'Category not found' });
    }

    // Set matching menu items' categories to null (or we can keep it as is)
    await Menu.updateMany({ category: req.params.id, restaurant: restaurant._id }, { $unset: { category: "" } });

    res.status(200).json({ success: true, message: 'Category deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Generate table QR code
// @route   POST /api/restaurant/tables/:tableNo/qr
router.post('/tables/:tableNo/qr', async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    const tableNo = req.params.tableNo;
    
    // Determine frontend URL for the QR code:
    // 1. Prioritize targetUrl from request body (sent by the frontend)
    // 2. Extract origin from Origin or Referer header
    // 3. Fallback to backend host request URL
    let tableUrl = req.body.targetUrl;
    
    if (!tableUrl) {
      const originHeader = req.headers.origin || req.headers.referer;
      if (originHeader) {
        try {
          const parsedUrl = new URL(originHeader);
          tableUrl = `${parsedUrl.protocol}//${parsedUrl.host}/restaurant/${restaurant.slug}?table=${tableNo}`;
        } catch (e) {
          // Ignore URL parsing errors
        }
      }
    }
    
    if (!tableUrl) {
      tableUrl = `${req.protocol}://${req.get('host')}/restaurant/${restaurant.slug}?table=${tableNo}`;
    }
    
    // Generate QR base64
    const qrImage = await QRCode.toDataURL(tableUrl);

    // Save table to restaurant array if it doesn't exist, otherwise update the existing one
    const tableIndex = restaurant.tables.findIndex(t => t.tableNo === tableNo);
    if (tableIndex === -1) {
      restaurant.tables.push({ tableNo, qrCodeUrl: qrImage });
    } else {
      restaurant.tables[tableIndex].qrCodeUrl = qrImage;
    }
    await restaurant.save();

    res.status(200).json({
      success: true,
      tableNo,
      qrCodeUrl: qrImage,
      tableUrl
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Get dashboard metrics for Restaurant Admin
// @route   GET /api/restaurant/dashboard/analytics
router.get('/dashboard/analytics', async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) return res.status(404).json({ success: false, error: 'Restaurant profile not found' });

    // 1. Fetch pre-aggregated metrics from DailyAnalytics cache
    const cachedStats = await DailyAnalytics.find({ restaurant: restaurant._id });
    let totalSales = cachedStats.reduce((sum, s) => sum + s.grossRevenue, 0);
    let totalOrders = cachedStats.reduce((sum, s) => sum + s.totalOrders, 0);

    // 2. Fetch today's uncached live orders
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const todayOrders = await Order.find({
      restaurant: restaurant._id,
      createdAt: { $gte: startOfToday }
    });

    const todaySales = todayOrders
      .filter(o => ['paid', 'PAID'].includes(o.paymentStatus))
      .reduce((sum, o) => sum + o.totalAmount, 0);

    totalSales += todaySales;
    totalOrders += todayOrders.length;

    // Fetch reviews
    const reviews = await Review.find({ restaurant: restaurant._id }).sort({ createdAt: -1 }).limit(5);

    res.status(200).json({
      success: true,
      analytics: {
        totalOrders,
        totalSales: Math.round(totalSales * 100) / 100,
        rating: restaurant.rating,
        reviews
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Get coupons for logged in restaurant
// @route   GET /api/restaurant/coupons
router.get('/coupons', async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant profile not found' });
    }

    const coupons = await Coupon.find({ restaurant: restaurant._id });
    res.status(200).json({ success: true, coupons });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Create coupon for logged in restaurant
// @route   POST /api/restaurant/coupons
router.post('/coupons', async (req, res) => {
  const { code, discountType, discountValue, minOrderAmount, maxDiscountAmount, expiryDate } = req.body;
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant profile not found' });
    }

    // Check if coupon code already exists
    const exists = await Coupon.findOne({ code: code.toUpperCase() });
    if (exists) {
      return res.status(400).json({ success: false, error: 'Coupon code already exists.' });
    }

    const coupon = await Coupon.create({
      restaurant: restaurant._id,
      code: code.toUpperCase(),
      discountType,
      discountValue: Number(discountValue),
      minOrderAmount: Number(minOrderAmount || 0),
      maxDiscountAmount: maxDiscountAmount ? Number(maxDiscountAmount) : undefined,
      expiryDate: expiryDate ? new Date(expiryDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });

    res.status(201).json({ success: true, coupon });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Delete coupon for logged in restaurant
// @route   DELETE /api/restaurant/coupons/:id
router.delete('/coupons/:id', async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant profile not found' });
    }

    const coupon = await Coupon.findOneAndDelete({ _id: req.params.id, restaurant: restaurant._id });
    if (!coupon) {
      return res.status(404).json({ success: false, error: 'Coupon not found or unauthorized' });
    }

    res.status(200).json({ success: true, message: 'Coupon deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
