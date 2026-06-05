import express from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { protect } from '../middleware/auth.js';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger.js';

const router = express.Router();

// Apply auth protection
router.use(protect);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Only image files (.jpg, .jpeg, .png, .webp) are allowed. Got ${ext}`), false);
    }
  }
});

// @desc    Upload single image
// @route   POST /api/media/upload
router.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Please upload an image file.' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const isCloudinaryConfigured = 
      process.env.CLOUDINARY_CLOUD_NAME && 
      process.env.CLOUDINARY_API_KEY && 
      process.env.CLOUDINARY_API_SECRET;

    if (isCloudinaryConfigured) {
      try {
        cloudinary.config({
          cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
          api_key: process.env.CLOUDINARY_API_KEY,
          api_secret: process.env.CLOUDINARY_API_SECRET
        });

        // Upload to Cloudinary using stream
        const result = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            {
              folder: 'Orderin_media',
              public_id: `media_${req.user?._id || 'guest'}_${Date.now()}`
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          uploadStream.end(req.file.buffer);
        });

        return res.status(200).json({
          success: true,
          url: result.secure_url,
          filename: result.public_id
        });
      } catch (cloudinaryErr) {
        logger.warn('[Media Upload] Cloudinary upload failed, falling back to local storage:', cloudinaryErr.message);
      }
    }

    // Local fallback: save buffer to local uploads/media
    const uploadDir = path.resolve('uploads/media');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const filename = `media-${req.user?._id || 'guest'}-${uniqueSuffix}${ext}`;
    const filePath = path.join(uploadDir, filename);

    fs.writeFileSync(filePath, req.file.buffer);

    const host = req.get('host');
    const protocol = req.protocol;
    const absoluteUrl = `${protocol}://${host}/uploads/media/${filename}`;

    res.status(200).json({
      success: true,
      url: absoluteUrl,
      filename
    });
  } catch (err) {
    logger.error('[Media Upload] Error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
