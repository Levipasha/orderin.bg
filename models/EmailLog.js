import mongoose from 'mongoose';

const EmailLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  emailType: {
    type: String,
    required: true,
    enum: [
      'welcome',
      'login_alert',
      'subscription_purchase',
      'expiry_reminder',
      'expired',
      'payment_success',
      'payment_failed',
      'admin_alert'
    ]
  },
  recipient: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  subject: {
    type: String,
    required: true
  },
  status: {
    type: String,
    required: true,
    enum: ['queued', 'sent', 'failed'],
    default: 'queued'
  },
  attempts: {
    type: Number,
    default: 0
  },
  errorMessage: {
    type: String,
    required: false
  },
  sentAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes for high performance logs search
EmailLogSchema.index({ recipient: 1, emailType: 1 });
EmailLogSchema.index({ status: 1 });
EmailLogSchema.index({ createdAt: -1 });

const EmailLog = mongoose.model('EmailLog', EmailLogSchema);

export default EmailLog;
