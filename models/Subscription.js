import mongoose from 'mongoose';

const SubscriptionSchema = new mongoose.Schema({
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Restaurant',
    required: true
  },
  plan: {
    type: String,
    enum: ['trial', 'basic', 'premium', 'enterprise'],
    default: 'trial'
  },
  status: {
    type: String,
    enum: ['active', 'expired', 'cancelled', 'pending'],
    default: 'active'
  },
  startDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  endDate: {
    type: Date,
    required: true
  },
  price: {
    type: Number,
    required: true,
    default: 0
  },
  autoRenew: {
    type: Boolean,
    default: true
  },
  paymentId: String, // Razorpay Subscription/Payment ID
  billingCycle: {
    type: String,
    enum: ['monthly', 'yearly'],
    default: 'monthly'
  }
}, {
  timestamps: true
});

export default mongoose.model('Subscription', SubscriptionSchema);
