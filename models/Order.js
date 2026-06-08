import mongoose from 'mongoose';

const OrderItemSchema = new mongoose.Schema({
  menuItem: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Menu',
    required: true
  },
  name: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true },
  selectedAddons: [{
    name: String,
    price: Number
  }]
});

const OrderSchema = new mongoose.Schema({
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Restaurant',
    required: true
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null // null if ordered anonymously via table QR scan
  },
  customerName: {
    type: String,
    required: true,
    default: 'Guest Customer'
  },
  customerPhone: String,
  items: [OrderItemSchema],
  tableNo: {
    type: String,
    default: '' // empty if normal delivery
  },
  subTotal: {
    type: Number,
    required: true
  },
  gstAmount: {
    type: Number,
    required: true,
    default: 0
  },
  cgstAmount: {
    type: Number,
    default: 0
  },
  sgstAmount: {
    type: Number,
    default: 0
  },
  deliveryCharge: {
    type: Number,
    required: true,
    default: 0
  },
  discountAmount: {
    type: Number,
    default: 0
  },
  totalAmount: {
    type: Number,
    required: true
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'cashfree', 'online', 'razorpay'],
    default: 'razorpay'
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded', 'CREATED', 'PROCESSING', 'PAID', 'FAILED', 'REFUNDED'],
    default: 'CREATED'
  },
  orderStatus: {
    type: String,
    enum: ['placed', 'preparing', 'ready', 'completed', 'cancelled', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'PAID', 'ACKNOWLEDGED', 'PREPARING', 'READY', 'COMPLETED', 'FAILED', 'CANCELLED'],
    default: 'PENDING_PAYMENT'
  },
  cashfreeOrderId: {
    type: String,
    default: null
  },
  razorpayOrderId: {
    type: String,
    default: null
  },
  razorpayPaymentId: {
    type: String,
    default: null
  },
  idempotencyKey: {
    type: String,
    default: null
  },
  notes: String,
  whatsappNotified: {
    type: Boolean,
    default: false
  },
  orderType: {
    type: String,
    enum: ['table', 'route', 'scheduled'],
    default: 'table'
  },
  pickupTime: {
    type: String,
    default: ''
  },
  pickupCode: {
    type: String,
    default: ''
  },
  preparationStatus: {
    type: String,
    enum: ['Pending', 'Preparing', 'Ready for Pickup', 'Picked Up'],
    default: 'Pending'
  },
  routeFrom: {
    type: String,
    default: ''
  },
  routeTo: {
    type: String,
    default: ''
  },
  routeETA: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

OrderSchema.index({ idempotencyKey: 1 }, { sparse: true });

// Add compound indexes for quick queries in multi-tenant system
OrderSchema.index({ restaurant: 1, createdAt: -1 });
OrderSchema.index({ cashfreeOrderId: 1 }, { sparse: true });
OrderSchema.index({ razorpayOrderId: 1 }, { sparse: true });

export default mongoose.model('Order', OrderSchema);
