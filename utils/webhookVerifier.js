import crypto from 'crypto';
import logger from './logger.js';

/**
 * Validates the Razorpay webhook signature against a list of secrets (supporting rotation).
 */
export function verifyWebhookSignature(rawBody, signature, secretEnv) {
  if (!signature) {
    logger.warn('[Webhook Verifier] Signature header is missing.');
    return false;
  }

  const secrets = (secretEnv || '').split(',').map(s => s.trim()).filter(Boolean);

  if (secrets.length === 0) {
    logger.error('[Webhook Verifier] No webhook secrets available for validation.');
    return false;
  }

  for (let i = 0; i < secrets.length; i++) {
    const secret = secrets[i];
    
    const hmac = crypto.createHmac('sha256', secret).update(rawBody);
    const expectedHex = hmac.copy().digest('hex');
    const expectedBase64 = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

    if (signature === expectedHex || signature === expectedBase64) {
      if (i > 0) {
        logger.info(`[Webhook Verifier] Signature authenticated using backup secret [Index: ${i}]. Secret rotation working.`);
      } else {
        logger.info('[Webhook Verifier] Signature authenticated using primary secret.');
      }
      return true;
    }
  }

  logger.warn('[Webhook Verifier] Webhook signature validation failed against all secrets.');
  return false;
}
