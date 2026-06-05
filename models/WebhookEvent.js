import mongoose from 'mongoose';

const WebhookEventSchema = new mongoose.Schema({
  eventId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  event: String,
  processed: {
    type: Boolean,
    default: true
  },
  processedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

export default mongoose.model('WebhookEvent', WebhookEventSchema);
