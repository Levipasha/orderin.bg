import mongoose from 'mongoose';

const TransferSchema = new mongoose.Schema({
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true
  },
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Restaurant',
    required: true
  },
  razorpayTransferId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  amount: {
    type: Number,
    required: true
  },
  recipientAccount: {
    type: String,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'processed', 'failed', 'reversed'],
    default: 'pending',
    index: true
  },
  error: {
    type: String,
    default: ''
  },
  attempts: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

TransferSchema.index({ restaurant: 1, createdAt: -1 });
TransferSchema.index({ order: 1 });

export default mongoose.model('Transfer', TransferSchema);
