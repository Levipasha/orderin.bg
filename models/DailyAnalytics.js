import mongoose from 'mongoose';

const DailyAnalyticsSchema = new mongoose.Schema({
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Restaurant',
    required: true,
    index: true
  },
  date: {
    type: Date,
    required: true,
    index: true // Truncated to start of day
  },
  grossRevenue: {
    type: Number,
    default: 0
  },
  netRevenue: {
    type: Number,
    default: 0
  },
  totalOrders: {
    type: Number,
    default: 0
  },
  successfulOrdersCount: {
    type: Number,
    default: 0
  },
  failedOrdersCount: {
    type: Number,
    default: 0
  },
  cancelledOrdersCount: {
    type: Number,
    default: 0
  },
  averageOrderValue: {
    type: Number,
    default: 0
  },
  topItems: [{
    menuItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Menu'
    },
    name: String,
    quantity: Number,
    revenue: Number
  }]
}, {
  timestamps: true
});

// Unique index to prevent duplicate aggregations per day per restaurant
DailyAnalyticsSchema.index({ restaurant: 1, date: 1 }, { unique: true });

export default mongoose.model('DailyAnalytics', DailyAnalyticsSchema);
