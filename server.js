import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import http from 'http';
import { Server } from 'socket.io';

// Routes imports
import authRoutes from './routes/authRoutes.js';
import User from './models/User.js';
import Restaurant from './models/Restaurant.js';
import Category from './models/Category.js';
import Menu from './models/Menu.js';
import superAdminRoutes from './routes/superAdminRoutes.js';
import restaurantRoutes from './routes/restaurantRoutes.js';
import kycRoutes from './routes/kycRoutes.js';
import orderRoutes from './routes/orderRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import marketplaceRoutes from './routes/marketplaceRoutes.js';
import mediaRoutes from './routes/mediaRoutes.js';
import { validateConfig } from './utils/configValidator.js';
// import { startReconciliationWorker } from './utils/reconciliationWorker.js';
import { startWebhookQueueWorker } from './utils/webhookQueueProcessor.js';
import { startAnalyticsScheduler } from './utils/analyticsAggregator.js';
import { traceabilityMiddleware } from './utils/traceability.js';
import { getRedisClient, checkRedisAvailability } from './utils/redisClient.js';
import { createAdapter } from '@socket.io/redis-adapter';
import { initBullQueues } from './utils/bullQueues.js';
import emailRoutes from './routes/emailRoutes.js';
import { startEmailScheduler } from './utils/emailScheduler.js';

const app = express();
const PORT = process.env.PORT || 5000;
const httpServer = http.createServer(app);

// Initialize Socket.IO with connectionStateRecovery for network resilience
const io = new Server(httpServer, {
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true
  },
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  }
});

// Connect Socket.IO Redis Adapter for horizontal scalability
if (checkRedisAvailability()) {
  const pubClient = getRedisClient().duplicate();
  const subClient = getRedisClient().duplicate();
  io.adapter(createAdapter(pubClient, subClient));
  console.log('🔌 Socket.IO Redis Adapter configured successfully for cluster synchronization.');
}

app.set('io', io);

// Socket.IO Connection Handler
io.on('connection', (socket) => {
  console.log(`🔌 Realtime client connected: ${socket.id}`);

  socket.on('join', (roomName) => {
    socket.join(roomName);
    console.log(`👤 Client ${socket.id} joined room: ${roomName}`);
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Realtime client disconnected: ${socket.id}`);
  });
});

// Enable Global Trace ID Context Propagation
app.use(traceabilityMiddleware);

// Enable CORS
app.use(cors({
  origin: '*', // Set specific origins in production
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Express limits and parser - capture raw body for secure signature verification
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting to protect endpoints
const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000; // Default: 15 minutes
const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX) || 2000; // Default: 2000 requests per window to accommodate developers & multi-user restaurant Wi-Fi

const limiter = rateLimit({
  windowMs: rateLimitWindowMs,
  max: rateLimitMax,
  message: { error: `Too many requests from this IP, please try again after ${Math.ceil(rateLimitWindowMs / 60000)} minutes.` }
});
app.use('/api', limiter);

// Basic health check route
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Orderin API Server is running smoothly.' });
});

// Configure API Routing
app.use('/api/auth', authRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/restaurant', restaurantRoutes);
app.use('/api/restaurant/kyc', kycRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api', paymentRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/emails', emailRoutes);
app.use('/uploads', express.static('uploads'));

// Global Error Handler Middleware
app.use((err, req, res, next) => {
  console.error('[GLOBAL ERROR ENCOUNTERED]', err.stack || err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    error: err.message || 'Internal server error'
  });
});

// MongoDB Connection & Server Launch
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/Orderin';

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('🔮 Connected to MongoDB successfully.');
    startEmailScheduler();
    
    // Seed default Super Admin & Demo Restaurant profiles
    try {
      // 1. Seed Super Admin
      const adminEmail = (process.env.SEED_SUPER_ADMIN_EMAIL || 'admin@orderin.com').trim().toLowerCase();
      const adminPassword = process.env.SEED_SUPER_ADMIN_PASSWORD || 'admin123';
      const adminExists = await User.findOne({ email: adminEmail });
      if (!adminExists) {
        await User.create({
          name: 'Main Super Admin',
          email: adminEmail,
          password: adminPassword,
          role: 'super_admin',
          status: 'active'
        });
        console.log(`👑 Super Admin seeded: ${adminEmail}`);
      }

      // 2. Optional demo restaurants (off by default — set SEED_DEMO_DATA=true to enable)
      if (process.env.SEED_DEMO_DATA === 'true') {
      const demoUsersData = [
        {
          name: 'Pizza Hub Owner',
          email: 'pizza@pizzahub.com',
          password: 'pizza123',
          role: 'restaurant_admin',
          restaurantName: 'Pizza Hub',
          slug: 'pizza-hub',
          logo: 'https://img.icons8.com/fluency/196/hamburger.png',
          banner: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?q=80&w=1200&auto=format&fit=crop',
          address: 'Khairatabad, Hyderabad, India',
          tagline: '70% OFF UPTO ₹140'
        },
        {
          name: 'Curry Palace Owner',
          email: 'curry@currypalace.com',
          password: 'curry123',
          role: 'restaurant_admin',
          restaurantName: 'Curry Palace',
          slug: 'curry-palace',
          logo: 'https://img.icons8.com/color/196/curry.png',
          banner: 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?q=80&w=1200&auto=format&fit=crop',
          address: 'Banjara Hills, Hyderabad, India',
          tagline: '50% OFF UPTO ₹100'
        },
        {
          name: 'Green Garden Owner',
          email: 'green@greengarden.com',
          password: 'green123',
          role: 'restaurant_admin',
          restaurantName: 'Green Garden',
          slug: 'green-garden',
          logo: 'https://img.icons8.com/fluency/196/salad.png',
          banner: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?q=80&w=1200&auto=format&fit=crop',
          address: 'Abids, Hyderabad, India',
          tagline: 'FREE ITEM'
        }
      ];

      for (const d of demoUsersData) {
        let u = await User.findOne({ email: d.email });
        if (!u) {
          u = await User.create({
            name: d.name,
            email: d.email,
            password: d.password,
            role: d.role,
            status: 'active'
          });
          // console.log(`👤 Seeded demo user: ${d.email}`);
        }

        let r = await Restaurant.findOne({ owner: u._id });
        if (!r) {
          r = await Restaurant.create({
            owner: u._id,
            name: d.restaurantName,
            slug: d.slug,
            logo: d.logo,
            banner: d.banner,
            theme: { primaryColor: '#bd3838', secondaryColor: '#0f172a', textColor: '#ffffff', styleType: 'glassmorphism' },
            timings: { open: '09:00', close: '22:00' },
            contact: {
              phone: '+91 9999988888',
              email: d.email,
              address: d.address,
              socialLinks: { instagram: '', facebook: '', whatsapp: '+91 9999988888' },
            },
            settings: { gstPercentage: 5, deliveryCharge: 30, minimumOrderAmount: 99 },
            tables: [{ tableNo: 'T1', qrCodeUrl: '' }],
            isApproved: true,
            isActive: true,
            rating: 4.8,
            kycStatus: 'verified',
            settlementStatus: 'active',
            bankDetails: {
              bankName: 'State Bank of India',
              accountHolderName: d.name,
              accountNumber: '123456789012',
              ifscCode: 'SBIN0001234'
            },
            tagline: d.tagline
          });
          // console.log(`🏪 Seeded demo restaurant profile for: ${d.restaurantName}`);
        } else {
          // Update address and tagline to migrate existing database records instantly!
          r.contact.address = d.address;
          r.tagline = d.tagline;
          await r.save();
          // console.log(`🏪 Updated demo restaurant: ${d.restaurantName} to real address & tagline.`);
        }

        // 3. Seed Categories and Dishes for this Restaurant
        let rCategories = [];
        if (d.restaurantName === 'Pizza Hub') {
          rCategories = [
            { name: 'Pizzas', image: 'https://img.icons8.com/fluency/96/pizza.png' },
            { name: 'Sides', image: 'https://img.icons8.com/fluency/96/french-fries.png' },
            { name: 'Desserts', image: 'https://img.icons8.com/fluency/96/cupcake.png' }
          ];
        } else if (d.restaurantName === 'Curry Palace') {
          rCategories = [
            { name: 'Biryani', image: 'https://img.icons8.com/fluency/96/biryani.png' },
            { name: 'Curries', image: 'https://img.icons8.com/fluency/96/curry.png' },
            { name: 'Breads', image: 'https://img.icons8.com/fluency/96/bread.png' }
          ];
        } else if (d.restaurantName === 'Green Garden') {
          rCategories = [
            { name: 'Salads', image: 'https://img.icons8.com/fluency/96/salad.png' },
            { name: 'Healthy Bowls', image: 'https://img.icons8.com/fluency/96/salad.png' },
            { name: 'Smoothies', image: 'https://img.icons8.com/fluency/96/smoothie.png' }
          ];
        }

        const catMap = {};
        for (const catData of rCategories) {
          let cat = await Category.findOne({ name: catData.name, restaurant: r._id });
          if (!cat) {
            cat = await Category.create({
              name: catData.name,
              image: catData.image,
              restaurant: r._id,
              isActive: true
            });
            // console.log(`📂 Seeded category: ${catData.name} for ${d.restaurantName}`);
          }
          catMap[catData.name] = cat._id;
        }

        let rMenus = [];
        if (d.restaurantName === 'Pizza Hub') {
          rMenus = [
            {
              name: 'Classic Margherita Pizza',
              description: 'Fresh mozzarella cheese, heirloom tomatoes, and freshly plucked garden basil on our signature crust.',
              category: catMap['Pizzas'],
              price: 249,
              discountPrice: 199,
              foodType: 'veg',
              tags: { isBestseller: true, isSpicy: false, isTodaySpecial: false },
              image: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?q=80&w=600&auto=format&fit=crop'
            },
            {
              name: 'Double Cheese Margherita',
              description: 'Double the cheese, double the happiness. Authentic Italian mozzarella melted over aromatic herb sauce.',
              category: catMap['Pizzas'],
              price: 349,
              discountPrice: 299,
              foodType: 'veg',
              tags: { isBestseller: false, isSpicy: false, isTodaySpecial: true },
              image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?q=80&w=600&auto=format&fit=crop'
            },
            {
              name: 'Pepperoni Feast Pizza',
              description: 'Loaded with spicy beef pepperoni slices and gooey imported mozzarella on a crispy sourdough crust.',
              category: catMap['Pizzas'],
              price: 449,
              foodType: 'non-veg',
              tags: { isBestseller: true, isSpicy: true, isTodaySpecial: false },
              image: 'https://images.unsplash.com/photo-1628840042765-356cda07504e?q=80&w=600&auto=format&fit=crop'
            },
            {
              name: 'Garlic Breadsticks',
              description: 'Freshly baked sourdough breadsticks brushed with compound garlic butter and garden herbs.',
              category: catMap['Sides'],
              price: 129,
              foodType: 'veg',
              tags: { isBestseller: false, isSpicy: false, isTodaySpecial: false },
              image: 'https://images.unsplash.com/photo-1544982503-9f984c14501a?q=80&w=600&auto=format&fit=crop'
            },
            {
              name: 'Choco Lava Cake',
              description: 'Freshly baked chocolate cake with a gooey, molten dark chocolate core. Served hot.',
              category: catMap['Desserts'],
              price: 99,
              foodType: 'veg',
              tags: { isBestseller: true, isSpicy: false, isTodaySpecial: false },
              image: 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?q=80&w=600&auto=format&fit=crop'
            }
          ];
        } else if (d.restaurantName === 'Curry Palace') {
          rMenus = [
            {
              name: 'Hyderabadi Chicken Biryani',
              description: 'Slow-cooked aromatic basmati rice layered with tender marinated chicken, saffron, and house spices.',
              category: catMap['Biryani'],
              price: 299,
              discountPrice: 249,
              foodType: 'non-veg',
              tags: { isBestseller: true, isSpicy: true, isTodaySpecial: true },
              image: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?q=80&w=600&auto=format&fit=crop'
            },
            {
              name: 'Paneer Butter Masala',
              description: 'Soft cottage cheese cubes cooked in a rich, buttery, mildly sweet tomato and cashew cream gravy.',
              category: catMap['Curries'],
              price: 220,
              discountPrice: 189,
              foodType: 'veg',
              tags: { isBestseller: true, isSpicy: false, isTodaySpecial: false },
              image: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?q=80&w=600&auto=format&fit=crop'
            },
            {
              name: 'Mutton Rogan Josh',
              description: 'Classic Kashmiri slow-cooked mutton curry flavored with alkanet root and premium spices.',
              category: catMap['Curries'],
              price: 399,
              foodType: 'non-veg',
              tags: { isBestseller: false, isSpicy: true, isTodaySpecial: false },
              image: 'https://images.unsplash.com/photo-1545247181-516ee7043a55?q=80&w=600&auto=format&fit=crop'
            },
            {
              name: 'Butter Naan',
              description: 'Fluffy clay-oven baked leavened flatbread brushed with pure clarified butter.',
              category: catMap['Breads'],
              price: 49,
              foodType: 'veg',
              tags: { isBestseller: false, isSpicy: false, isTodaySpecial: false },
              image: 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78?q=80&w=600&auto=format&fit=crop'
            },
            {
              name: 'Garlic Naan',
              description: 'Freshly baked flatbread topped with minced garlic, fresh cilantro, and pure butter.',
              category: catMap['Breads'],
              price: 59,
              foodType: 'veg',
              tags: { isBestseller: true, isSpicy: false, isTodaySpecial: false },
              image: 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78?q=80&w=600&auto=format&fit=crop'
            }
          ];
        } else if (d.restaurantName === 'Green Garden') {
          rMenus = [
            {
              name: 'Avocado Quinoa Salad',
              description: 'Organic white quinoa tossed with diced hass avocado, cherry tomatoes, cucumbers, and lemon-herb vinaigrette.',
              category: catMap['Salads'],
              price: 189,
              foodType: 'vegan',
              tags: { isBestseller: true, isSpicy: false, isTodaySpecial: false },
              image: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?q=80&w=600&auto=format&fit=crop'
            },
            {
              name: 'Greek Feta Bowl',
              description: 'Traditional greek salad loaded with crisp bell peppers, kalamata olives, cucumbers, and blocks of imported feta.',
              category: catMap['Healthy Bowls'],
              price: 209,
              foodType: 'veg',
              tags: { isBestseller: false, isSpicy: false, isTodaySpecial: true },
              image: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?q=80&w=600&auto=format&fit=crop'
            },
            {
              name: 'Protein Power Salad',
              description: 'Tofu cubes, chickpeas, baby spinach, sprouted lentils, and toasted pumpkin seeds with ginger-tahini dressing.',
              category: catMap['Salads'],
              price: 229,
              discountPrice: 199,
              foodType: 'veg',
              tags: { isBestseller: true, isSpicy: false, isTodaySpecial: false },
              image: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=600&auto=format&fit=crop'
            },
            {
              name: 'Acai Berry Smoothie',
              description: 'Blend of pure acai berries, blueberries, bananas, and unsweetened almond milk. Extremely refreshing.',
              category: catMap['Smoothies'],
              price: 149,
              foodType: 'vegan',
              tags: { isBestseller: false, isSpicy: false, isTodaySpecial: false },
              image: 'https://images.unsplash.com/photo-1553530666-ba11a7da3888?q=80&w=600&auto=format&fit=crop'
            }
          ];
        }

        for (const menuData of rMenus) {
          let mItem = await Menu.findOne({ name: menuData.name, restaurant: r._id });
          if (!mItem) {
            mItem = await Menu.create({
              ...menuData,
              restaurant: r._id,
              isActive: true,
              inStock: true
            });
            // console.log(`🍳 Seeded menu item: ${menuData.name} for ${d.restaurantName}`);
          }
        }
      }
      }
    } catch (seedErr) {
      console.error('⚠️ Failed to seed default Super Admin and demo restaurant users:', seedErr.message);
    }

    // Validate config and launch background processes
    validateConfig();
    initBullQueues(io);
    // startReconciliationWorker(io); // Deemed redundant for standard/direct webhook setups
    startWebhookQueueWorker(io);
    startAnalyticsScheduler();

    httpServer.listen(PORT, () => {
      console.log(`🚀 Orderin API server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
  });
