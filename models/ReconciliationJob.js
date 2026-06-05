import mongoose from 'mongoose';

const ReconciliationJobSchema = new mongoose.Schema({
  runAt: {
    type: Date,
    default: Date.now,
    required: true
  },
  status: {
    type: String,
    enum: ['SUCCESS', 'FAILED'],
    required: true
  },
  scannedCount: {
    type: Number,
    default: 0
  },
  repairedCount: {
    type: Number,
    default: 0
  },
  cleanedCount: {
    type: Number,
    default: 0
  },
  errors: [String],
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true,
  suppressReservedKeysWarning: true
});

export default mongoose.model('ReconciliationJob', ReconciliationJobSchema);
