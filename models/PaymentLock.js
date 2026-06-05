import mongoose from 'mongoose';

const PaymentLockSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true
  },
  acquiredAt: {
    type: Date,
    default: Date.now,
    expires: 30 // TTL index: Automatically deletes document after 30 seconds to prevent deadlocks
  },
  owner: {
    type: String,
    required: true
  }
});

export default mongoose.model('PaymentLock', PaymentLockSchema);
