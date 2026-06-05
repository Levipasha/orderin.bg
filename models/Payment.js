import mongoose from 'mongoose';

const PaymentSchema = new mongoose.Schema({
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true
  },
  transactionId: {
    type: String,
    required: true,
    unique: true
  },
  paymentId: String, // Cashfree payment ID
  signature: String, // Cashfree signature verification
  amount: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'success', 'failed', 'CREATED', 'PROCESSING', 'PAID', 'FAILED', 'REFUNDED'],
    default: 'CREATED'
  },
  gateway: {
    type: String,
    default: 'cashfree'
  },
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Restaurant'
  },
  cashfreeOrderId: String,
  cashfreeVendorId: String,
  platformCommission: { type: Number, default: 0 },
  restaurantAmount: { type: Number, default: 0 },
  settlementStatus: {
    type: String,
    enum: ['PENDING', 'SPLIT_INITIATED', 'SETTLED', 'SETTLEMENT_FAILED', 'NOT_REQUIRED'],
    default: 'PENDING'
  },
  marketplaceSettlement: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MarketplaceSettlement'
  }
}, {
  timestamps: true
});

export default mongoose.model('Payment', PaymentSchema);
