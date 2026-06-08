import mongoose from 'mongoose';

const RestaurantSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: {
    type: String,
    required: [true, 'Please provide restaurant name'],
    trim: true
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  logo: {
    type: String,
    default: 'https://img.icons8.com/fluency/196/hamburger.png'
  },
  banner: {
    type: String,
    default: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?q=80&w=1200&auto=format&fit=crop'
  },
  tagline: {
    type: String,
    default: 'Post foods, custom timings settings, table QRs, and track local customer orders'
  },
  theme: {
    primaryColor: { type: String, default: '#ff385c' },
    secondaryColor: { type: String, default: '#08090c' },
    textColor: { type: String, default: '#ffffff' },
    styleType: { type: String, enum: ['glassmorphism', 'minimalist', 'neo-brutalism'], default: 'glassmorphism' }
  },
  timings: {
    open: { type: String, default: '09:00' },
    close: { type: String, default: '22:00' }
  },
  contact: {
    phone: String,
    email: String,
    address: String,
    socialLinks: {
      instagram: String,
      facebook: String,
      whatsapp: String
    }
  },
  settings: {
    gstPercentage: { type: Number, default: 5 },
    cgstPercentage: { type: Number, default: 2.5 },
    sgstPercentage: { type: Number, default: 2.5 },
    deliveryCharge: { type: Number, default: 30 },
    minimumOrderAmount: { type: Number, default: 99 }
  },
  tables: [{
    tableNo: { type: String, required: true },
    qrCodeUrl: String
  }],
  isApproved: {
    type: Boolean,
    default: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  rating: {
    type: Number,
    default: 4.5
  },
  featured: {
    type: Boolean,
    default: false
  },
  ownerName: {
    type: String,
    default: ''
  },
  email: {
    type: String,
    default: ''
  },
  phone: {
    type: String,
    default: ''
  },
  panNumber: {
    type: String,
    default: ''
  },
  gstNumber: {
    type: String,
    default: '' // Optional GST number
  },
  fssaiNumber: {
    type: String,
    default: '' // FSSAI Food License Number
  },
  address: {
    type: String,
    default: ''
  },
  pinCode: {
    type: String,
    default: ''
  },
  bankDetails: {
    bankName: { type: String, default: '' },
    accountHolderName: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    ifscCode: { type: String, default: '' }
  },
  razorpayAccountId: {
    type: String,
    default: null,
    index: true
  },
  kycStatus: {
    type: String,
    enum: ['pending', 'submitted', 'verified', 'rejected'],
    default: 'pending'
  },
  settlementStatus: {
    type: String,
    enum: ['active', 'suspended'],
    default: 'suspended'
  },
  commissionPercent: {
    type: Number,
    default: 10,
    min: 0,
    max: 99
  },
  subscriptionPlan: {
    type: String,
    enum: ['free', 'basic', 'premium', 'trial'],
    default: 'free'
  },
  subscriptionExpiry: {
    type: Date,
    default: function() {
      return new Date(Date.now() + 15 * 24 * 60 * 60 * 1000); // 15 days free trial
    },
    index: true
  },
  subscriptionActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Mask sensitive bank account numbers globally in API responses
const maskAccountNumber = (ret) => {
  if (ret.bankDetails && ret.bankDetails.accountNumber) {
    const num = ret.bankDetails.accountNumber;
    if (num && num.length > 4) {
      ret.bankDetails.accountNumber = '*'.repeat(num.length - 4) + num.slice(-4);
    } else if (num) {
      ret.bankDetails.accountNumber = '****';
    }
  }
  return ret;
};

RestaurantSchema.set('toJSON', {
  transform: function (doc, ret, options) {
    return maskAccountNumber(ret);
  }
});

RestaurantSchema.set('toObject', {
  transform: function (doc, ret, options) {
    return maskAccountNumber(ret);
  }
});

export default mongoose.model('Restaurant', RestaurantSchema);
