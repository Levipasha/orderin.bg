import mongoose from 'mongoose';

const PaymentAuditLedgerSchema = new mongoose.Schema({
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
  correlationId: {
    type: String,
    required: true
  },
  traceId: {
    type: String,
    required: true
  },
  event: {
    type: String,
    required: true
  },
  stateTransition: {
    fromState: { type: String },
    toState: { type: String }
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Enforce append-only constraints using schema hooks
PaymentAuditLedgerSchema.pre('save', function (next) {
  if (!this.isNew) {
    return next(new Error('Cannot modify an immutable payment audit ledger entry.'));
  }
  next();
});

const blockMutation = function (next) {
  next(new Error('Mutation operations are strictly blocked on the immutable payment audit ledger.'));
};

PaymentAuditLedgerSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'replaceOne'], blockMutation);
PaymentAuditLedgerSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete', 'findByIdAndDelete', 'remove'], blockMutation);

export default mongoose.model('PaymentAuditLedger', PaymentAuditLedgerSchema);
