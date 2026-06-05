/**
 * Drops the entire MongoDB database configured in MONGO_URI.
 * Usage: node scripts/wipeDatabase.js --confirm
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const confirmed =
  process.argv.includes('--confirm') || process.env.CONFIRM_WIPE === 'yes';

if (!confirmed) {
  console.error('Refusing to wipe: pass --confirm or set CONFIRM_WIPE=yes');
  process.exit(1);
}

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/Orderin';

try {
  await mongoose.connect(MONGO_URI);
  const dbName = mongoose.connection.name;
  await mongoose.connection.dropDatabase();
  console.log(`Dropped MongoDB database "${dbName}" at ${MONGO_URI}`);
  await mongoose.disconnect();
  process.exit(0);
} catch (err) {
  console.error('Database wipe failed:', err.message);
  process.exit(1);
}
