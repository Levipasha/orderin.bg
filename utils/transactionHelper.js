import mongoose from 'mongoose';

/**
 * Runs the given callback inside a MongoDB transaction if a replica set is active.
 * Otherwise, runs the callback directly.
 * 
 * @param {Function} callback - The operations to run, receiving `session` as its first arg.
 */
export async function runInTransaction(callback) {
  const conn = mongoose.connection;
  
  // Detect if connection supports replica set transactions
  const descriptionType = conn.client?.topology?.description?.type;
  const serversCount = conn.client?.topology?.description?.servers?.size || 0;
  
  const supportsTransactions = (
    descriptionType === 'ReplicaSetNoPrimary' ||
    descriptionType === 'ReplicaSetWithPrimary' ||
    descriptionType === 'Sharded' ||
    serversCount > 1
  );

  if (!supportsTransactions) {
    // Standalone fallback
    return await callback(null);
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const result = await callback(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}
