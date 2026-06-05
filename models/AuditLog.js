import mongoose from 'mongoose';

const AuditLogSchema = new mongoose.Schema({
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Restaurant',
    required: true,
    index: true
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null,
    index: true
  },
  actor: {
    type: String,
    required: true, // "system", "customer", or userId of the actor
    index: true
  },
  actorRole: {
    type: String,
    default: 'guest' // "system", "customer", "restaurant_owner", "kitchen_staff", "super_admin"
  },
  action: {
    type: String,
    required: true, // e.g. "payment_verified", "order_acknowledged", "status_change", "refund"
    index: true
  },
  fromState: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  toState: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

AuditLogSchema.index({ restaurant: 1, createdAt: -1 });

export default mongoose.model('AuditLog', AuditLogSchema);
