import mongoose from 'mongoose';

/**
 * Records marketplace (Easy Split) payment + nodal settlement lifecycle per order.
 * Funds flow: Customer → Cashfree nodal/escrow → split → restaurant vendor + platform commission.
 */
const MarketplaceSettlementSchema = new mongoose.Schema({
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
    unique: true
  },
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Restaurant',
    required: true
  },
  cashfreeOrderId: {
    type: String,
    index: true
  },
  cashfreePaymentId: String,
  paymentStatus: {
    type: String,
    enum: ['CREATED', 'PENDING', 'PAID', 'FAILED', 'REFUNDED'],
    default: 'CREATED'
  },
  settlementStatus: {
    type: String,
    enum: ['PENDING', 'SPLIT_INITIATED', 'SETTLED', 'SETTLEMENT_FAILED', 'NOT_REQUIRED'],
    default: 'PENDING'
  },
  orderAmount: {
    type: Number,
    required: true
  },
  platformCommissionPercent: {
    type: Number,
    required: true,
    default: 10
  },
  platformCommission: {
    type: Number,
    required: true,
    default: 0
  },
  restaurantAmount: {
    type: Number,
    required: true,
    default: 0
  },
  cashfreeVendorId: String,
  splitType: {
    type: String,
    enum: ['order_splits', 'split_after_payment', 'mock'],
    default: 'order_splits'
  },
  splitDetails: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  settlementDetails: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  settlementFailureReason: String,
  webhookEvents: [{
    type: { type: String },
    eventId: String,
    payload: mongoose.Schema.Types.Mixed,
    receivedAt: { type: Date, default: Date.now }
  }],
  splitInitiatedAt: Date,
  settledAt: Date,
  failedAt: Date
}, {
  timestamps: true
});

MarketplaceSettlementSchema.index({ restaurant: 1, createdAt: -1 });
MarketplaceSettlementSchema.index({ settlementStatus: 1 });

export default mongoose.model('MarketplaceSettlement', MarketplaceSettlementSchema);
