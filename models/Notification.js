import mongoose from 'mongoose';

const NotificationSchema = new mongoose.Schema({
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Restaurant',
    required: true,
    index: true
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['customer', 'kitchen', 'admin', 'payment'],
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['unread', 'read'],
    default: 'unread',
    index: true
  },
  recipient: {
    type: String,
    required: true,
    index: true // e.g. "kitchen", "admin", "customer_${orderId}"
  }
}, {
  timestamps: true
});

NotificationSchema.index({ restaurant: 1, recipient: 1, status: 1 });

export default mongoose.model('Notification', NotificationSchema);
