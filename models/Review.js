import mongoose from 'mongoose';

const ReviewSchema = new mongoose.Schema({
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Restaurant',
    required: true
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  customerName: {
    type: String,
    required: true
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5
  },
  comment: {
    type: String,
    required: true
  },
  reply: String, // Restaurant owner reply
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Update restaurant average rating when review is added
ReviewSchema.post('save', async function() {
  const Review = this.constructor;
  const stats = await Review.aggregate([
    { $match: { restaurant: this.restaurant } },
    { $group: { _id: '$restaurant', avgRating: { $avg: '$rating' } } }
  ]);
  
  if (stats.length > 0) {
    await mongoose.model('Restaurant').findByIdAndUpdate(this.restaurant, {
      rating: Math.round(stats[0].avgRating * 10) / 10
    });
  }
});

export default mongoose.model('Review', ReviewSchema);
