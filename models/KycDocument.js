import mongoose from 'mongoose';

const KycDocumentSchema = new mongoose.Schema({
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Restaurant',
    required: true,
    unique: true
  },
  panCardUrl: {
    type: String,
    required: [true, 'PAN card proof is required']
  },
  gstCertificateUrl: {
    type: String,
    default: '' // Optional GST certificate
  },
  bankProofUrl: {
    type: String,
    required: [true, 'Bank proof (cancelled cheque or statement) is required']
  },
  aadhaarUrl: {
    type: String,
    default: '' // Optional Aadhaar card proof
  },
  status: {
    type: String,
    enum: ['pending', 'submitted', 'verified', 'rejected'],
    default: 'pending',
    index: true
  },
  rejectionReason: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

export default mongoose.model('KycDocument', KycDocumentSchema);
