/**
 * Creates or resets the platform super admin (use after DB wipe).
 * Usage: node scripts/ensureSuperAdmin.js
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import User from '../models/User.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const adminEmail = (process.env.SEED_SUPER_ADMIN_EMAIL || 'admin@orderin.com').trim().toLowerCase();
const adminPassword = process.env.SEED_SUPER_ADMIN_PASSWORD || 'admin123';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/Orderin';

try {
  await mongoose.connect(MONGO_URI);
  let user = await User.findOne({ email: adminEmail }).select('+password');

  if (user) {
    user.password = adminPassword;
    user.role = 'super_admin';
    user.status = 'active';
    await user.save();
    console.log(`Updated existing super admin: ${adminEmail}`);
  } else {
    user = await User.create({
      name: 'Main Super Admin',
      email: adminEmail,
      password: adminPassword,
      role: 'super_admin',
      status: 'active',
    });
    console.log(`Created super admin: ${adminEmail}`);
  }

  const verified = await User.findOne({ email: adminEmail }).select('+password');
  const ok = await verified.comparePassword(adminPassword);
  console.log(`Password check: ${ok ? 'OK' : 'FAILED'}`);
  console.log(`Database: ${mongoose.connection.name}`);
  await mongoose.disconnect();
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error('ensureSuperAdmin failed:', err.message);
  process.exit(1);
}
