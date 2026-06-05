import logger from './logger.js';

/**
 * Validates environment configuration.
 * Production requires full Razorpay Route credentials.
 */
export function validateConfig() {
  const isProduction = process.env.NODE_ENV === 'production';

  const baseRequired = ['MONGO_URI', 'JWT_SECRET'];
  const missingBase = baseRequired.filter(key => !process.env[key]);

  if (missingBase.length > 0) {
    const errorMsg = `CRITICAL: Missing required env: [${missingBase.join(', ')}]`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
  const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const isConfigured = !!(razorpayKeyId && razorpayKeySecret);

  if (isProduction) {
    const paymentRequired = [
      ['RAZORPAY_KEY_ID', razorpayKeyId],
      ['RAZORPAY_KEY_SECRET', razorpayKeySecret]
    ];
    const missingPayment = paymentRequired
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missingPayment.length > 0) {
      const errorMsg = `CRITICAL: Production missing Razorpay Route config: [${missingPayment.join(', ')}]`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
    // logger.info('✅ Production Razorpay Route credentials validated.');
  } else if (!isConfigured) {
    logger.warn(
      '⚠️ Razorpay Route running in MOCK mode. Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET for real split settlements.'
    );
  } else {
    // logger.info('✅ Razorpay Route credentials present (sandbox/production).');
  }

  // logger.info('✅ Core configuration checks passed.');
}
