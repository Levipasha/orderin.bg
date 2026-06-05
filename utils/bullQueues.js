import { Queue, Worker } from 'bullmq';
import { getRedisClient, checkRedisAvailability } from './redisClient.js';
import logger from './logger.js';
import { processWebhookJob } from './webhookProcessorHelper.js';

const host = process.env.REDIS_HOST || '127.0.0.1';
const port = parseInt(process.env.REDIS_PORT) || 6379;
const password = process.env.REDIS_PASSWORD || null;

const connectionConfig = {
  host,
  port,
  password: password || undefined
};

// Queue Singletons
let webhookQueue = null;
let reconciliationQueue = null;
let paymentRetryQueue = null;
let notificationQueue = null;

// Workers
let webhookWorker = null;
let notificationWorker = null;

/**
 * Initializes BullMQ queues and workers if Redis is available.
 */
export function initBullQueues(io) {
  if (!checkRedisAvailability()) {
    logger.warn('[BullMQ Queues] Redis connection is offline. Skipping BullMQ initialization. DB Queue fallbacks active.');
    return;
  }

  try {
    logger.info('[BullMQ Queues] Initializing BullMQ queues and workers...');

    // 1. Initialize Queues
    webhookQueue = new Queue('webhookQueue', { connection: connectionConfig });
    reconciliationQueue = new Queue('reconciliationQueue', { connection: connectionConfig });
    paymentRetryQueue = new Queue('paymentRetryQueue', { connection: connectionConfig });
    notificationQueue = new Queue('notificationQueue', { connection: connectionConfig });

    // 2. Initialize Workers
    // Webhook Queue Worker
    webhookWorker = new Worker('webhookQueue', async (job) => {
      logger.info(`[BullMQ Worker] Processing job ${job.id} of type ${job.name}`);
      await processWebhookJob(io, job.data);
    }, {
      connection: connectionConfig,
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 1000
      }
    });

    webhookWorker.on('failed', (job, err) => {
      logger.error(`[BullMQ Worker Error] Job ${job?.id} failed: ${err.message}`);
    });

    webhookWorker.on('completed', (job) => {
      logger.info(`[BullMQ Worker Success] Job ${job.id} completed.`);
    });

    // Notification Queue Worker
    notificationWorker = new Worker('notificationQueue', async (job) => {
      const { createAndSendNotification } = await import('./notifier.js');
      await createAndSendNotification(io, job.data);
    }, { connection: connectionConfig });

    logger.info('[BullMQ Queues] Queues and workers are successfully initialized and running.');
  } catch (err) {
    logger.error(`[BullMQ Queues Error] Queue boot crashed: ${err.message}`);
  }
}

/**
 * Enqueues webhook task to Redis, fallback to MongoDB Queue if unavailable
 */
export async function addWebhookJob(eventId, event, payload) {
  if (checkRedisAvailability() && webhookQueue) {
    try {
      const job = await webhookQueue.add(event, { eventId, event, payload }, {
        jobId: eventId, // Unique ID prevents duplicate jobs
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 10000 // Retry starting at 10s
        },
        removeOnComplete: { age: 3600 }, // Clean after 1 hour to save memory
        removeOnFail: { age: 86400 } // Keep fail logs for 24h
      });
      logger.info(`[BullMQ Webhook] Successfully enqueued job: ${job.id}`);
      return { source: 'redis', jobId: job.id };
    } catch (err) {
      logger.error(`[BullMQ Enqueue Error] Webhook queue failed: ${err.message}. Routing to MongoDB...`);
    }
  }

  // Fallback to MongoDB-backed queue
  const { enqueueWebhookEvent } = await import('./webhookQueueProcessor.js');
  const dbJob = await enqueueWebhookEvent(eventId, event, payload);
  return { source: 'mongodb', jobId: dbJob._id };
}

/**
 * Enqueues notification task
 */
export async function addNotificationJob(data) {
  if (checkRedisAvailability() && notificationQueue) {
    try {
      await notificationQueue.add('send_notification', data, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 }
      });
      return true;
    } catch (err) {
      logger.warn(`[BullMQ Notification Error] Notification queue failed: ${err.message}`);
    }
  }
  return false;
}

/**
 * Scans and replays failed jobs in the BullMQ queue
 */
export async function replayFailedQueueJobs() {
  if (!checkRedisAvailability() || !webhookQueue) return 0;
  try {
    const failedJobs = await webhookQueue.getFailed(0, 100);
    for (const job of failedJobs) {
      logger.info(`[Queue Recovery] Retrying failed BullMQ job ${job.id}`);
      await job.retry();
    }
    return failedJobs.length;
  } catch (err) {
    logger.error(`[Queue Recovery Error] Failed to replay jobs: ${err.message}`);
    return 0;
  }
}

export function getQueueMetrics() {
  return {
    redisOnline: checkRedisAvailability(),
    webhookQueueActive: !!webhookQueue,
    notificationQueueActive: !!notificationQueue
  };
}
