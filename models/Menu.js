import mongoose from 'mongoose';

const AddonSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true, default: 0 }
});

const MenuSchema = new mongoose.Schema({
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Restaurant',
    required: true
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    required: true
  },
  name: {
    type: String,
    required: [true, 'Please provide dish name'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  discountPrice: {
    type: Number,
    min: 0
  },
  image: {
    type: String,
    default: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=600&auto=format&fit=crop'
  },
  foodType: {
    type: String,
    enum: ['veg', 'non-veg', 'vegan'],
    required: true,
    default: 'veg'
  },
  tags: {
    isSpicy: { type: Boolean, default: false },
    isBestseller: { type: Boolean, default: false },
    isTodaySpecial: { type: Boolean, default: false }
  },
  inStock: {
    type: Boolean,
    default: true
  },
  addons: [AddonSchema],
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

export default mongoose.model('Menu', MenuSchema);
