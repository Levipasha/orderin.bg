import logger from './logger.js';

/**
 * Resolves Cashfree credentials from env (supports new + legacy variable names).
 */
export function getCashfreeCredentials() {
  const appId = process.env.CASHFREE_APP_ID || process.env.CASHFREE_CLIENT_ID || '';
  const secretKey = process.env.CASHFREE_SECRET_KEY || process.env.CASHFREE_CLIENT_SECRET || '';
  const envRaw = (process.env.CASHFREE_ENV || process.env.CASHFREE_ENVIRONMENT || 'SANDBOX').toUpperCase();
  const webhookSecret = process.env.CASHFREE_WEBHOOK_SECRET || '';

  return {
    appId,
    secretKey,
    isProduction: envRaw === 'PRODUCTION' || envRaw === 'PROD',
    webhookSecret,
    isConfigured: Boolean(appId && secretKey)
  };
}

export function getPlatformCommissionPercent(restaurant) {
  const fromRestaurant = restaurant?.cashfree?.commissionPercent;
  if (typeof fromRestaurant === 'number' && fromRestaurant >= 0 && fromRestaurant <= 99) {
    return fromRestaurant;
  }
  const fromEnv = parseFloat(process.env.PLATFORM_COMMISSION_PERCENT);
  if (!Number.isNaN(fromEnv) && fromEnv >= 0 && fromEnv <= 99) {
    return fromEnv;
  }
  return 10;
}

export function calculateMarketplaceSplit(orderAmount, commissionPercent) {
  const amount = Math.round(orderAmount * 100) / 100;
  const pct = Math.min(99, Math.max(0, commissionPercent));
  const platformCommission = Math.round((amount * pct / 100) * 100) / 100;
  const restaurantAmount = Math.round((amount - platformCommission) * 100) / 100;
  return {
    orderAmount: amount,
    platformCommissionPercent: pct,
    platformCommission,
    restaurantAmount,
    restaurantSharePercent: 100 - pct
  };
}

export function buildRestaurantVendorId(restaurant) {
  if (restaurant.cashfree?.vendorId) return restaurant.cashfree.vendorId;
  const slug = (restaurant.slug || restaurant._id.toString()).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
  return `Orderin_${slug}_${restaurant._id.toString().slice(-8)}`;
}

export function logCashfreeConfigStatus() {
  const { appId, isProduction, isConfigured } = getCashfreeCredentials();
  if (!isConfigured) {
    logger.warn('[Cashfree] Marketplace running in MOCK mode — set CASHFREE_APP_ID and CASHFREE_SECRET_KEY.');
    return;
  }
  logger.info(`[Cashfree] Marketplace configured (${isProduction ? 'PRODUCTION' : 'SANDBOX'}) appId=${appId.slice(0, 6)}***`);
}
