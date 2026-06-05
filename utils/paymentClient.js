import logger from './logger.js';
import { Cashfree, CFEnvironment } from 'cashfree-pg';
import { getCashfreeCredentials } from './cashfreeConfig.js';

const BREAKER_STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

const breakerConfig = {
  failureThreshold: 5,
  cooldownWindowMs: 30000,
  timeoutMs: 10000
};

let currentState = BREAKER_STATE.CLOSED;
let consecutiveFailures = 0;
let nextAttemptAt = 0;

function timeoutPromise(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Cashfree Gateway request timed out'));
    }, ms);

    promise
      .then(res => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function executeWithRetry(fn, maxRetries = 3, initialDelay = 1000) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) throw err;
      const delay = initialDelay * Math.pow(2, attempt) + Math.random() * 200;
      logger.warn(`[Payment Client Retry] Attempt ${attempt}/${maxRetries} failed: ${err.message}. Retrying in ${Math.round(delay)}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function executeResiliently(fn) {
  const now = Date.now();

  if (currentState === BREAKER_STATE.OPEN) {
    if (now >= nextAttemptAt) {
      currentState = BREAKER_STATE.HALF_OPEN;
    } else {
      throw new Error('Cashfree Payment Gateway is temporarily unavailable (Circuit Breaker Trip)');
    }
  }

  try {
    const result = await executeWithRetry(() => timeoutPromise(fn(), breakerConfig.timeoutMs));
    if (currentState === BREAKER_STATE.HALF_OPEN) currentState = BREAKER_STATE.CLOSED;
    consecutiveFailures = 0;
    return result;
  } catch (err) {
    consecutiveFailures++;
    if (consecutiveFailures >= breakerConfig.failureThreshold) {
      currentState = BREAKER_STATE.OPEN;
      nextAttemptAt = Date.now() + breakerConfig.cooldownWindowMs;
    }
    throw err;
  }
}

function extractResponseData(response) {
  return response?.data ?? response;
}

class ResilientCashfree {
  constructor() {
    this.cashfree = new Cashfree();
    const { appId, secretKey, isProduction, isConfigured } = getCashfreeCredentials();

    if (isConfigured) {
      this.cashfree.XClientId = appId;
      this.cashfree.XClientSecret = secretKey;
      this.cashfree.XEnvironment = isProduction ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX;
      logger.info(`[Payment Client] Cashfree initialized (${isProduction ? 'PRODUCTION' : 'SANDBOX'}).`);
    }
  }

  isMockMode() {
    return !getCashfreeCredentials().isConfigured;
  }

  async createOrder(options) {
    if (this.isMockMode()) {
      logger.info('[Payment Client Mock] Simulating Cashfree order creation.');
      return {
        order_id: `cf_order_${Math.random().toString(36).substring(4)}`,
        order_amount: options.order_amount,
        order_currency: options.order_currency || 'INR',
        payment_session_id: `session_${Date.now()}`
      };
    }
    return await executeResiliently(() =>
      this.cashfree.PGCreateOrder(options).then(extractResponseData)
    );
  }

  /**
   * Create PG order with Easy Split order_splits (nodal → vendor + platform commission).
   */
  async createOrderWithSplit(options) {
    if (this.isMockMode()) {
      logger.info('[Payment Client Mock] Simulating split order creation.', {
        order_splits: options.order_splits
      });
      return {
        order_id: `cf_split_order_${Math.random().toString(36).substring(4)}`,
        order_amount: options.order_amount,
        order_currency: options.order_currency || 'INR',
        payment_session_id: `session_${Date.now()}`,
        order_splits: options.order_splits
      };
    }
    return await executeResiliently(() =>
      this.cashfree.PGCreateOrder(options).then(extractResponseData)
    );
  }

  async fetchOrder(orderId) {
    if (this.isMockMode()) return { order_id: orderId, order_status: 'PAID' };
    return await executeResiliently(() =>
      this.cashfree.PGFetchOrder(orderId).then(extractResponseData)
    );
  }

  /** Create Easy Split vendor (restaurant beneficiary) */
  async createVendor(vendorRequest, idempotencyKey) {
    if (this.isMockMode()) {
      logger.info('[Payment Client Mock] Simulating vendor creation.', { vendor_id: vendorRequest.vendor_id });
      return {
        vendor_id: vendorRequest.vendor_id,
        status: 'ACTIVE',
        name: vendorRequest.name
      };
    }
    return await executeResiliently(() =>
      this.cashfree.PGESCreateVendors(
        undefined,
        idempotencyKey || `vendor_${vendorRequest.vendor_id}`,
        vendorRequest
      ).then(extractResponseData)
    );
  }

  async fetchVendor(vendorId) {
    if (this.isMockMode()) {
      return { vendor_id: vendorId, status: 'ACTIVE' };
    }
    return await executeResiliently(() =>
      this.cashfree.PGESFetchVendors(vendorId).then(extractResponseData)
    );
  }

  /** Split after payment (fallback if order_splits not applied at creation) */
  async splitAfterPayment(cashfreeOrderId, splitRequest, idempotencyKey) {
    if (this.isMockMode()) {
      logger.info('[Payment Client Mock] Simulating split-after-payment.', { cashfreeOrderId });
      return { status: 'SUCCESS', order_id: cashfreeOrderId, split: splitRequest?.split };
    }
    return await executeResiliently(() =>
      this.cashfree.PGOrderSplitAfterPayment(
        cashfreeOrderId,
        undefined,
        idempotencyKey || `split_${cashfreeOrderId}`,
        splitRequest
      ).then(extractResponseData)
    );
  }

  /** Settlement / split recon for an order */
  async fetchSplitSettlement(cashfreeOrderId) {
    if (this.isMockMode()) {
      return {
        order_id: cashfreeOrderId,
        settled: 'YES',
        order_splits: [{ split: [{ merchant_vendor_id: 'mock_vendor', percentage: 90 }] }]
      };
    }
    return await executeResiliently(() =>
      this.cashfree.PGSplitOrderRecon(cashfreeOrderId).then(extractResponseData)
    );
  }
}

export const paymentClient = new ResilientCashfree();
export default paymentClient;
