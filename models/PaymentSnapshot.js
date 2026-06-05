import mongoose from 'mongoose';

const PaymentSnapshotSchema = new mongoose.Schema({
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
  invoiceNumber: {
    type: String,
    required: true
  },
  totals: {
    subTotal: { type: Number, required: true },
    gstAmount: { type: Number, required: true },
    deliveryCharge: { type: Number, required: true },
    totalAmount: { type: Number, required: true }
  },
  items: [{
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'Menu' },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
    selectedAddons: [{
      name: { type: String },
      price: { type: Number }
    }]
  }],
  metadata: {
    customerName: { type: String },
    customerPhone: { type: String },
    tableNo: { type: String },
    paymentMethod: { type: String },
    transactionId: { type: String },
    paymentGateway: { type: String, default: 'cashfree' }
  }
}, {
  timestamps: true
});

// Enforce read-only locks on snapshot updates to keep entries immutable
PaymentSnapshotSchema.pre('save', function (next) {
  if (!this.isNew) {
    return next(new Error('Cannot modify an immutable payment snapshot.'));
  }
  next();
});

export default mongoose.model('PaymentSnapshot', PaymentSnapshotSchema);
