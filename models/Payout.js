import mongoose from 'mongoose';

const PayoutSchema = new mongoose.Schema({
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Restaurant',
    required: true
  },
  razorpayAccountId: {
    type: String,
    required: false,
    index: true
  },
  razorpaySettlementId: {
    type: String,
    required: false,
    index: true
  },
  payoutMethod: {
    type: String,
    enum: ['razorpay', 'manual'],
    default: 'manual',
    index: true
  },
  referenceId: {
    type: String,
    default: ''
  },
  amount: {
    type: Number,
    required: true
  },
  tax: {
    type: Number,
    default: 0
  },
  fees: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['processed', 'failed'],
    default: 'processed',
    index: true
  },
  settledAt: {
    type: Date,
    required: true
  }
}, {
  timestamps: true
});

PayoutSchema.index({ restaurant: 1, settledAt: -1 });

export default mongoose.model('Payout', PayoutSchema);
