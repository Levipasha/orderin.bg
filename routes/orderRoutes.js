import express from 'express';
import { protect } from '../middleware/auth.js';
import Order from '../models/Order.js';
import Restaurant from '../models/Restaurant.js';
import PaymentEventLog from '../models/PaymentEventLog.js';
import { writeAuditLog } from '../utils/auditLogger.js';
import { createAndSendNotification } from '../utils/notifier.js';
import { runInTransaction } from '../utils/transactionHelper.js';

import { redisRateLimiter } from '../utils/redisRateLimiter.js';

const router = express.Router();

// @desc    Create a new order (Public scan QR or authenticated customer)
// @route   POST /api/orders
router.post('/', redisRateLimiter('create-order-session', 15, 60), async (req, res) => {
  const { restaurantId, customerName, customerPhone, items, tableNo, notes, paymentMethod, orderType, pickupTime, pickupCode, preparationStatus, routeFrom, routeTo, routeETA } = req.body;
  try {
    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    // Compute idempotency key
    const crypto = await import('crypto');
    const keyPayload = `${restaurantId}-${tableNo || 'T1'}-${items.map(i => `${i.menuItem}:${i.quantity}`).join(',')}`;
    const idempotencyKey = req.headers['idempotency-key'] || crypto.createHash('md5').update(keyPayload).digest('hex');

    // Check if order exists (created within the last 2 minutes) and is NOT already paid
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    const existingOrder = await Order.findOne({
      idempotencyKey,
      createdAt: { $gte: twoMinutesAgo },
      paymentStatus: { $nin: ['PAID', 'paid'] }
    });

    if (existingOrder) {
      console.log(`[Idempotency Check] Order creation bypassed. Returning existing Order: ${existingOrder._id}`);
      return res.status(201).json({
        success: true,
        message: 'Order retrieved from cache',
        order: existingOrder,
        isIdempotent: true
      });
    }

    // Compute prices
    let subTotal = 0;
    items.forEach(item => {
      let itemPrice = item.price;
      if (item.selectedAddons) {
        item.selectedAddons.forEach(addon => {
          itemPrice += addon.price;
        });
      }
      subTotal += itemPrice * item.quantity;
    });

    const cgstPercent = typeof restaurant.settings.cgstPercentage === 'number' ? restaurant.settings.cgstPercentage : (restaurant.settings.gstPercentage / 2);
    const sgstPercent = typeof restaurant.settings.sgstPercentage === 'number' ? restaurant.settings.sgstPercentage : (restaurant.settings.gstPercentage / 2);
    const cgstAmount = Math.round((subTotal * (cgstPercent / 100)) * 100) / 100;
    const sgstAmount = Math.round((subTotal * (sgstPercent / 100)) * 100) / 100;
    const gstAmount = cgstAmount + sgstAmount;
    
    const deliveryCharge = (tableNo || ['scheduled', 'route', 'table'].includes(orderType)) ? 0 : restaurant.settings.deliveryCharge; // No delivery charge for self-pickups or tables!
    const totalAmount = subTotal + gstAmount + deliveryCharge;

    const order = await Order.create({
      restaurant: restaurantId,
      customer: req.user ? req.user._id : null, // Support anonymous guests via table QR scan
      customerName: customerName || (req.user ? req.user.name : 'Guest Customer'),
      customerPhone,
      items,
      tableNo: tableNo || '',
      subTotal,
      gstAmount,
      cgstAmount,
      sgstAmount,
      deliveryCharge,
      totalAmount,
      paymentMethod: paymentMethod || 'razorpay',
      notes,
      paymentStatus: 'CREATED',
      orderStatus: 'PENDING_PAYMENT',
      idempotencyKey,
      orderType: orderType || 'table',
      pickupTime: pickupTime || '',
      pickupCode: pickupCode || '',
      preparationStatus: preparationStatus || 'Pending',
      routeFrom: routeFrom || '',
      routeTo: routeTo || '',
      routeETA: routeETA || ''
    });

    await PaymentEventLog.create({
      order: order._id,
      event: 'order_created',
      details: { totalAmount, itemsCount: items.length }
    });

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      order
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Get order by ID (For live order tracking)
// @route   GET /api/orders/:id
router.get('/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate('restaurant', 'name logo slug contact theme');
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // Merge buffered Redis transaction states to resolve replication lag
    const { getBufferedPaymentState } = await import('../utils/paymentBuffer.js');
    const buffered = await getBufferedPaymentState(order._id);
    if (buffered) {
      order.paymentStatus = buffered.paymentStatus || order.paymentStatus;
      order.orderStatus = buffered.orderStatus || order.orderStatus;
    }

    res.status(200).json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Get public queue orders for a restaurant by slug (McDonald's screen)
// @route   GET /api/orders/public/queue/:restaurantSlug
router.get('/public/queue/:restaurantSlug', async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ slug: req.params.restaurantSlug });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    // Fetch active queue orders: placed, preparing, ready
    const orders = await Order.find({
      restaurant: restaurant._id,
      orderStatus: { $in: ['placed', 'preparing', 'ready'] }
    }).populate('items.menuItem', 'image').sort({ createdAt: 1 });

    res.status(200).json({
      success: true,
      restaurant: {
        _id: restaurant._id,
        name: restaurant.name,
        logo: restaurant.logo,
        banner: restaurant.banner,
        theme: restaurant.theme,
        isApproved: restaurant.isApproved,
        isActive: restaurant.isActive,
        subscriptionActive: restaurant.subscriptionActive
      },
      orders: orders.map(o => ({
        id: o._id,
        tableNo: o.tableNo,
        orderStatus: o.orderStatus,
        createdAt: o.createdAt,
        items: (o.items || []).map(i => ({ 
          name: i.name, 
          quantity: i.quantity,
          image: i.menuItem ? i.menuItem.image : null
        }))
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Get all orders of a customer by phone number
// @route   GET /api/orders/customer/:phone
router.get('/customer/:phone', async (req, res) => {
  try {
    const orders = await Order.find({ customerPhone: req.params.phone })
      .populate('restaurant', 'name logo slug contact theme')
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Protected routes (Restaurant Admin / Restaurant Owner orders management)
router.use(protect);

// @desc    Get all orders of a specific restaurant
// @route   GET /api/orders/restaurant/all
router.get('/restaurant/all', async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user._id });
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    const orders = await Order.find({ restaurant: restaurant._id }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Update order status
// @route   PUT /api/orders/:id/status
router.put('/:id/status', async (req, res) => {
  const { orderStatus, paymentStatus, preparationStatus } = req.body;
  try {
    const result = await runInTransaction(async (session) => {
      const order = await Order.findById(req.params.id).session(session);
      if (!order) {
        throw new Error('Order not found');
      }

      // Verify ownership
      const restaurant = await Restaurant.findById(order.restaurant).session(session);
      if (restaurant.owner.toString() !== req.user._id.toString() && req.user.role !== 'super_admin') {
        throw new Error('Not authorized to manage this order');
      }

      const oldOrderStatus = order.orderStatus;
      const oldPaymentStatus = order.paymentStatus;
      const oldPreparationStatus = order.preparationStatus;

      if (orderStatus) order.orderStatus = orderStatus;
      if (paymentStatus) order.paymentStatus = paymentStatus;
      if (preparationStatus) order.preparationStatus = preparationStatus;

      await order.save({ session });

      // Create Audit Log
      await writeAuditLog({
        restaurantId: order.restaurant,
        orderId: order._id,
        actor: req.user._id.toString(),
        actorRole: req.user.role || 'restaurant_owner',
        action: 'status_update',
        fromState: { orderStatus: oldOrderStatus, paymentStatus: oldPaymentStatus },
        toState: { orderStatus: order.orderStatus, paymentStatus: order.paymentStatus },
        metadata: { clientIp: req.ip }
      }, session);

      // Create persistent Notification for client based on the transitions
      if (orderStatus && oldOrderStatus !== orderStatus) {
        let title = 'Order Update';
        let message = `Your order status changed to ${orderStatus}`;

        if (orderStatus === 'ACKNOWLEDGED') {
          title = 'Order Acknowledged';
          message = 'The kitchen has accepted your order and will start cooking soon.';
        } else if (orderStatus === 'preparing' || orderStatus === 'PREPARING') {
          title = 'Preparing Your Food';
          message = 'Chef has started cooking your order. Get ready!';
        } else if (orderStatus === 'ready' || orderStatus === 'READY') {
          title = 'Order Ready to Serve';
          message = `Your order is ready! Please collect it from the counter.`;
        } else if (orderStatus === 'completed' || orderStatus === 'COMPLETED') {
          title = 'Order Completed';
          message = 'Hope you enjoyed your meal! Thank you for ordering with us.';
        } else if (orderStatus === 'cancelled' || orderStatus === 'CANCELLED') {
          title = 'Order Cancelled';
          message = 'Your order has been cancelled by the restaurant.';
        }

        // Customer notification
        const io = req.app.get('io');
        await createAndSendNotification(io, {
          restaurantId: order.restaurant,
          orderId: order._id,
          title,
          message,
          type: orderStatus === 'cancelled' ? 'admin' : 'customer',
          recipient: `customer_${order._id}`
        });
      }

      return order;
    });

    // Trigger Socket.IO updates to Customer, Restaurant and Lobby Queue TV
    const io = req.app.get('io');
    if (io) {
      io.to(`order_${result._id}`).emit('payment_update', {
        success: true,
        orderStatus: result.orderStatus,
        paymentStatus: result.paymentStatus,
        order: result
      });

      io.to(`restaurant_${result.restaurant}`).emit('order_status_update', {
        orderId: result._id,
        orderStatus: result.orderStatus,
        paymentStatus: result.paymentStatus,
        order: result
      });

      io.to(`queue_${result.restaurant}`).emit('queue_update', {
        order: result
      });
    }

    res.status(200).json({
      success: true,
      message: 'Order updated successfully',
      order: result
    });
  } catch (err) {
    if (err.message === 'Order not found') {
      return res.status(404).json({ success: false, error: err.message });
    }
    if (err.message === 'Not authorized to manage this order') {
      return res.status(403).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
