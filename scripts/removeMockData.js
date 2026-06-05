/**
 * Script to remove seeded mock restaurants, owners, categories, menus, coupons, and orders.
 * Usage: node scripts/removeMockData.js
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

// Models
import User from '../models/User.js';
import Restaurant from '../models/Restaurant.js';
import Category from '../models/Category.js';
import Menu from '../models/Menu.js';
import Order from '../models/Order.js';
import Coupon from '../models/Coupon.js';
import Payout from '../models/Payout.js';
import Payment from '../models/Payment.js';
import Subscription from '../models/Subscription.js';
import KycDocument from '../models/KycDocument.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/Orderin';

async function removeMockData() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log(`Connected to database: ${mongoose.connection.name}`);

    // Mock owner emails
    const mockEmails = ['pizza@pizzahub.com', 'curry@currypalace.com', 'green@greengarden.com'];
    
    // Find mock users
    const mockUsers = await User.find({ email: { $in: mockEmails } });
    const mockUserIds = mockUsers.map(u => u._id);

    // Find mock restaurants (either owned by mock users or matching slugs)
    const mockSlugs = ['pizza-hub', 'curry-palace', 'green-garden'];
    const mockRestaurants = await Restaurant.find({
      $or: [
        { owner: { $in: mockUserIds } },
        { slug: { $in: mockSlugs } }
      ]
    });
    
    const mockRestaurantIds = mockRestaurants.map(r => r._id);

    console.log(`Found ${mockUsers.length} mock user(s) and ${mockRestaurants.length} mock restaurant(s).`);

    if (mockRestaurantIds.length > 0) {
      // Delete associated Categories
      const catRes = await Category.deleteMany({ restaurant: { $in: mockRestaurantIds } });
      console.log(`🗑️ Deleted ${catRes.deletedCount} category/categories.`);

      // Delete associated Menu items
      const menuRes = await Menu.deleteMany({ restaurant: { $in: mockRestaurantIds } });
      console.log(`🗑️ Deleted ${menuRes.deletedCount} menu item(s).`);

      // Delete associated Orders
      const orderRes = await Order.deleteMany({ restaurant: { $in: mockRestaurantIds } });
      console.log(`🗑️ Deleted ${orderRes.deletedCount} order(s).`);

      // Delete associated Coupons
      const couponRes = await Coupon.deleteMany({ restaurant: { $in: mockRestaurantIds } });
      console.log(`🗑️ Deleted ${couponRes.deletedCount} coupon(s).`);

      // Delete associated Payouts
      const payoutRes = await Payout.deleteMany({ restaurant: { $in: mockRestaurantIds } });
      console.log(`🗑️ Deleted ${payoutRes.deletedCount} payout(s).`);

      // Delete associated Payments
      const paymentRes = await Payment.deleteMany({ restaurant: { $in: mockRestaurantIds } });
      console.log(`🗑️ Deleted ${paymentRes.deletedCount} payment(s).`);

      // Delete associated Subscriptions
      const subRes = await Subscription.deleteMany({ restaurant: { $in: mockRestaurantIds } });
      console.log(`🗑️ Deleted ${subRes.deletedCount} subscription(s).`);

      // Delete associated KYC Documents
      const kycRes = await KycDocument.deleteMany({ restaurant: { $in: mockRestaurantIds } });
      console.log(`🗑️ Deleted ${kycRes.deletedCount} KYC document(s).`);

      // Delete Restaurants
      const restRes = await Restaurant.deleteMany({ _id: { $in: mockRestaurantIds } });
      console.log(`🗑️ Deleted ${restRes.deletedCount} restaurant(s) [Slugs: ${mockRestaurants.map(r => r.slug).join(', ')}].`);
    }

    if (mockUserIds.length > 0) {
      // Delete Users
      const userRes = await User.deleteMany({ _id: { $in: mockUserIds } });
      console.log(`🗑️ Deleted ${userRes.deletedCount} user(s).`);
    }

    console.log('✅ Mock data removal completed successfully!');
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error removing mock data:', err.message);
    process.exit(1);
  }
}

removeMockData();
