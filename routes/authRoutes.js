import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';
import { sendWelcomeEmail, sendLoginAlertEmail, sendAdminAlert } from '../services/emailService.js';

const router = express.Router();

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'fallback_jwt_secret_token', {
    expiresIn: '30d'
  });
};

// @desc    Register a new user
// @route   POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password, role, phone } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  try {
    const userExists = await User.findOne({ email: normalizedEmail });
    if (userExists) {
      return res.status(400).json({ success: false, error: 'User already exists with this email address' });
    }

    const user = await User.create({
      name,
      email: normalizedEmail,
      password,
      role: role || 'customer',
      phone
    });

    // ── Integrated Welcome Email & Admin Notifications ──
    try {
      sendWelcomeEmail(user.email, user.name);
      sendAdminAlert('admin@Orderin.com', user.name, 'new_user_registration', {
        userId: user._id,
        email: user.email,
        role: user.role
      });
    } catch (mailErr) {
      console.error('[Welcome Mail Error] Failed to enqueue registration alert:', mailErr.message);
    }

    res.status(201).json({
      success: true,
      token: generateToken(user._id),
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Authenticate user & get token
// @route   POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  try {
    const user = await User.findOne({ email: normalizedEmail }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, error: 'Invalid email or password credentials' });
    }

    // ── Integrated Security Login Alert Email ──
    try {
      const userAgent = req.headers['user-agent'] || 'Unknown Device';
      let browser = 'Unknown Browser';
      let device = 'Web Browser';

      if (userAgent.includes('Chrome')) browser = 'Google Chrome';
      else if (userAgent.includes('Firefox')) browser = 'Mozilla Firefox';
      else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) browser = 'Apple Safari';
      else if (userAgent.includes('Edge')) browser = 'Microsoft Edge';

      if (userAgent.includes('Mobile') || userAgent.includes('Android') || userAgent.includes('iPhone')) {
        device = 'Mobile Phone';
      } else if (userAgent.includes('Macintosh') || userAgent.includes('Windows') || userAgent.includes('Linux')) {
        device = 'Desktop/Laptop Computer';
      }

      const alertDetails = {
        loginTime: new Date(),
        ipAddress: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1',
        device,
        browser,
        location: 'Hyderabad, India (IP Geolocation)'
      };

      sendLoginAlertEmail(user.email, user.name, alertDetails);
    } catch (mailErr) {
      console.error('[Login Mail Error] Failed to enqueue security alert:', mailErr.message);
    }

    res.status(200).json({
      success: true,
      token: generateToken(user._id),
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// @desc    Get current user profile
// @route   GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  res.status(200).json({
    success: true,
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      phone: req.user.phone,
      favorites: req.user.favorites
    }
  });
});

// @desc    Sync Google Diner (customer) with MongoDB session
// @route   POST /api/auth/google-diner
router.post('/google-diner', async (req, res) => {
  const { name, email, phone, photoURL } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  try {
    let user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      // Create new customer user on MongoDB
      const crypto = await import('crypto');
      const dummyPassword = crypto.randomBytes(16).toString('hex');
      user = await User.create({
        name,
        email: normalizedEmail,
        password: dummyPassword,
        role: 'customer',
        phone: phone || ''
      });
    } else {
      // Update phone if provided and not set
      if (phone && !user.phone) {
        user.phone = phone;
        await user.save();
      }
    }

    res.status(200).json({
      success: true,
      token: generateToken(user._id),
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        photoURL
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
