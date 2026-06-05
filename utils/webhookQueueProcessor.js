import WebhookQueue from '../models/WebhookQueue.js';
import Order from '../models/Order.js';
import PaymentEventLog from '../models/PaymentEventLog.js';
import { handlePaymentSuccess, handlePaymentFailure } from './paymentHandler.js';
import { runInTraceContext } from './traceability.js';
import logger from './logger.js';

/**
 * Enqueues a webhook event for background processing
 */
export async function enqueueWebhookEvent(eventId, event, payload) {
  try {
    const exists = await WebhookQueue.findOne({ eventId });
    if (exists) {
      logger.info(`[Webhook Queue] Event ${eventId} already enqueued/processed.`);
      return exists;
    }

    const job = await WebhookQueue.create({
      eventId,
      event,
      payload,
      status: 'PENDING',
      nextRunAt: new Date()
    });

    logger.info(`[Webhook Queue] Enqueued event ${eventId} (${event})`);
    return job;
  } catch (err) {
    logger.error(`[Webhook Queue Error] Failed to enqueue event ${eventId}: ${err.message}`);
    throw err;
  }
}

/**
 * Processes a single queue job
 */
async function processJob(io, job) {
  logger.info(`[Webhook Worker] Processing event ${job.eventId} (Type: ${job.event}), Attempt: ${job.attempts + 1}`);
  
  const payload = job.payload;
  const event = job.event;

  if (event === 'payment.captured') {
    const paymentEntity = payload.payload?.payment?.entity;
    if (!paymentEntity) return;

    const razorpayOrderId = paymentEntity.order_id;
    const paymentId = paymentEntity.id;

    const order = await Order.findOne({ razorpayOrderId });
    if (!order) {
      throw new Error(`Order not found for Razorpay Order ID: ${razorpayOrderId}`);
    }

    if (order.paymentStatus !== 'PAID') {
      await handlePaymentSuccess(io, {
        orderId: order._id,
        transactionId: paymentId,
        signature: null,
        eventId: job.eventId,
        isMock: false
      });
    }
  } 
  else if (event === 'PAYMENT_SUCCESS_WEBHOOK' || event === 'ORDER_PAID') {
    const cfOrderId = payload.data?.order?.order_id;
    const cfPaymentId = payload.data?.payment?.cf_payment_id;

    const order = await Order.findOne({ cashfreeOrderId: cfOrderId });
    if (!order) {
      throw new Error(`Order not found for Cashfree Order ID: ${cfOrderId}`);
    }

    await handlePaymentSuccess(io, {
      orderId: order._id,
      transactionId: cfPaymentId || cfOrderId,
      signature: payload.signature || 'webhook_queue',
      eventId: job.eventId,
      isMock: false
    });
  } 
  else if (event === 'PAYMENT_FAILED_WEBHOOK') {
    const cfOrderId = payload.data?.order?.order_id;
    const cfPaymentId = payload.data?.payment?.cf_payment_id;

    const order = await Order.findOne({ cashfreeOrderId: cfOrderId });
    if (!order) {
      throw new Error(`Order not found for failed Cashfree Order ID: ${cfOrderId}`);
    }

    await handlePaymentFailure(io, {
      orderId: order._id,
      errorDetails: {
        code: payload.data?.payment?.payment_status,
        description: payload.data?.error_details?.error_description || 'Payment failed',
        paymentId: cfPaymentId
      },
      eventId: job.eventId
    });
  } 
  else {
    logger.warn(`[Webhook Worker] Unhandled event in queue: ${event}`);
  }
}

/**
 * Scans queue and runs processing loop
 */
export async function processWebhookQueue(io) {
  let jobsProcessed = 0;
  try {
    const jobs = await WebhookQueue.find({
      status: { $in: ['PENDING', 'FAILED'] },
      nextRunAt: { $lte: new Date() },
      attempts: { $lt: 5 }
    }).sort({ nextRunAt: 1 }).limit(10);

    for (const job of jobs) {
      jobsProcessed++;
      
      job.status = 'PROCESSING';
      await job.save();

      // Extract trace context stored during webhook ingestion
      const traceContext = job.payload?.traceContext || {
        traceId: `tr_job_${job.eventId}`,
        correlationId: `corr_job_${job.eventId}`
      };

      try {
        // Execute the job wrapped in the correct trace context
        await runInTraceContext(traceContext, async () => {
          await processJob(io, job);
        });
        
        job.status = 'COMPLETED';
        job.attempts += 1;
        job.logs.push(`[${new Date().toISOString()}] Successfully completed processing.`);
        await job.save();
        
        logger.info(`[Webhook Worker] Finished job ${job.eventId} successfully.`);
      } catch (jobErr) {
        logger.error(`[Webhook Worker Error] Job ${job.eventId} failed: ${jobErr.message}`);
        
        job.attempts += 1;
        job.lastError = jobErr.message;
        job.logs.push(`[${new Date().toISOString()}] Attempt failed: ${jobErr.message}`);
        
        if (job.attempts >= job.maxAttempts) {
          job.status = 'DLQ';
          logger.warn(`[Webhook Worker] Job ${job.eventId} moved to DLQ (Dead Letter Queue) after ${job.attempts} failures.`);
        } else {
          job.status = 'FAILED';
          const delaySeconds = Math.pow(2, job.attempts) * 10;
          job.nextRunAt = new Date(Date.now() + delaySeconds * 1000);
          logger.info(`[Webhook Worker] Rescheduled job ${job.eventId} in ${delaySeconds}s`);
        }
        await job.save();
      }
    }
  } catch (err) {
    logger.error(`[Webhook Worker Loop Error] Queue processing loop failed: ${err.message}`);
  }
  return jobsProcessed;
}

/**
 * Boots the periodic queue polling worker
 */
export function startWebhookQueueWorker(io, pollIntervalMs = 5000) {
  setInterval(() => processWebhookQueue(io), pollIntervalMs);
  logger.info(`⏰ Webhook Queue background worker started. Poll interval: ${pollIntervalMs / 1000}s`);
}
