import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

export const traceStorage = new AsyncLocalStorage();

/**
 * Express middleware setting trace and correlation IDs.
 */
export function traceabilityMiddleware(req, res, next) {
  const traceId = req.headers['x-trace-id'] || `tr_${crypto.randomBytes(8).toString('hex')}`;
  const correlationId = req.headers['x-correlation-id'] || `corr_${crypto.randomBytes(8).toString('hex')}`;

  req.traceId = traceId;
  req.correlationId = correlationId;

  res.setHeader('x-trace-id', traceId);
  res.setHeader('x-correlation-id', correlationId);

  traceStorage.run({ traceId, correlationId }, () => {
    next();
  });
}

/**
 * Helper to retrieve active trace identifiers from context.
 */
export function getTraceContext() {
  const store = traceStorage.getStore();
  if (store) {
    return store;
  }
  return {
    traceId: `tr_sys_${crypto.randomBytes(4).toString('hex')}`,
    correlationId: `corr_sys_${crypto.randomBytes(4).toString('hex')}`
  };
}

/**
 * Wrapper to run any arbitrary callback within a specific trace context
 */
export function runInTraceContext({ traceId, correlationId }, callback) {
  return traceStorage.run({
    traceId: traceId || `tr_job_${crypto.randomBytes(4).toString('hex')}`,
    correlationId: correlationId || `corr_job_${crypto.randomBytes(4).toString('hex')}`
  }, callback);
}
