import mongoose from 'mongoose';

const WebhookQueueSchema = new mongoose.Schema({
  eventId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  event: {
    type: String,
    required: true
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  status: {
    type: String,
    enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DLQ'],
    default: 'PENDING',
    index: true
  },
  attempts: {
    type: Number,
    default: 0
  },
  maxAttempts: {
    type: Number,
    default: 5
  },
  nextRunAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  lastError: {
    type: String,
    default: null
  },
  logs: [String]
}, {
  timestamps: true
});

// Index to find next pending job quickly
WebhookQueueSchema.index({ status: 1, nextRunAt: 1 });

export default mongoose.model('WebhookQueue', WebhookQueueSchema);
