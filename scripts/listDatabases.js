import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/Orderin';

async function listDatabases() {
  try {
    await mongoose.connect(MONGO_URI);
    const adminDb = mongoose.connection.db.admin();
    const dbs = await adminDb.listDatabases();
    console.log('--- DATABASES ---');
    dbs.databases.forEach(db => console.log(`- ${db.name}`));
    await mongoose.disconnect();
  } catch (err) {
    console.error(err);
  }
}

listDatabases();
