import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

// Configure Cloudinary if credentials exist
const isCloudinaryConfigured = 
  process.env.CLOUDINARY_CLOUD_NAME && 
  process.env.CLOUDINARY_API_KEY && 
  process.env.CLOUDINARY_API_SECRET;

let storage;

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
      const folderName = 'Orderin_kyc_documents';
      // Determine file extension and format
      const ext = path.extname(file.originalname).toLowerCase();
      let format = 'png';
      if (ext === '.pdf') format = 'pdf';
      else if (ext === '.jpg' || ext === '.jpeg') format = 'jpg';

      return {
        folder: folderName,
        format: format,
        public_id: `${file.fieldname}_${req.user?._id || 'guest'}_${Date.now()}`,
        resource_type: format === 'pdf' ? 'raw' : 'image'
      };
    }
  });
  logger.info('[Upload Middleware] Cloudinary storage configured successfully.');
} else {
  // Local storage fallback
  const uploadDir = path.resolve('uploads/kyc');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    logger.info(`[Upload Middleware] Created local upload directory: ${uploadDir}`);
  }

  storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${file.fieldname}-${req.user?._id || 'guest'}-${uniqueSuffix}${ext}`);
    }
  });
  logger.warn('[Upload Middleware] Cloudinary not configured. Falling back to secure LOCAL STORAGE.');
}

// File filter to restrict uploads to images (JPG/PNG) and PDFs
const fileFilter = (req, file, cb) => {
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf'];
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type. Only JPG, JPEG, PNG, and PDF files are allowed. Got ${ext}`), false);
  }
};

// Multer upload configurations
export const uploadKycFields = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: fileFilter
}).fields([
  { name: 'panCard', maxCount: 1 },
  { name: 'gstCertificate', maxCount: 1 },
  { name: 'bankProof', maxCount: 1 },
  { name: 'aadhaar', maxCount: 1 }
]);

/**
 * Utility to parse uploaded file URL path based on local fallback vs Cloudinary.
 * @param {Object} file - Multer file object
 * @returns {string} The public accessible file URL or path
 */
export function getUploadedFileUrl(file) {
  if (!file) return '';
  // If stored in Cloudinary, return the path or secure_url
  if (file.path && (file.path.startsWith('http://') || file.path.startsWith('https://'))) {
    return file.path;
  }
  // Otherwise, return local serving path
  return `/uploads/kyc/${file.filename}`;
}
