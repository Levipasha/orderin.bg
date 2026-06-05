import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

import User from '../models/User.js';
import Restaurant from '../models/Restaurant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/Orderin';

async function listAllData() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log(`Connected to: ${mongoose.connection.name}`);
    
    const users = await User.find({}, 'name email role');
    console.log(`--- USERS (${users.length}) ---`);
    users.forEach(u => console.log(`- ${u.name} (${u.email}) [${u.role}]`));

    const restaurants = await Restaurant.find({}, 'name slug');
    console.log(`--- RESTAURANTS (${restaurants.length}) ---`);
    restaurants.forEach(r => console.log(`- ${r.name} (${r.slug})`));

    await mongoose.disconnect();
  } catch (err) {
    console.error(err);
  }
}

listAllData();
