import Restaurant from '../models/Restaurant.js';
import MarketplaceSettlement from '../models/MarketplaceSettlement.js';
import User from '../models/User.js';
import { paymentClient } from './paymentClient.js';
import {
  buildRestaurantVendorId,
  calculateMarketplaceSplit,
  getPlatformCommissionPercent
} from './cashfreeConfig.js';
import logger from './logger.js';

/**
 * Validates restaurant bank details required for Cashfree vendor onboarding.
 */
export function validateBankDetailsForVendor(bankDetails) {
  const errors = [];
  if (!bankDetails?.accountHolderName?.trim()) errors.push('Account holder name is required');
  if (!bankDetails?.accountNumber?.trim()) errors.push('Account number is required');
  if (!bankDetails?.ifscCode?.trim()) errors.push('IFSC code is required');
  const ifsc = (bankDetails?.ifscCode || '').toUpperCase();
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    errors.push('Invalid IFSC format');
  }
  return errors;
}

function isVendorAlreadyExistsError(message) {
  const m = (message || '').toLowerCase();
  return (
    m.includes('already exists') ||
    m.includes('vendor_id_already') ||
    m.includes('duplicate vendor')
  );
}

function mapCashfreeVendorStatus(cfStatus) {
  const s = (cfStatus || '').toUpperCase();
  if (s === 'ACTIVE') return 'ACTIVE';
  if (s === 'BLOCKED' || s === 'DELETED') return s;
  return 'PENDING';
}

function extractCashfreeErrorMessage(err) {
  const cfData = err.response?.data;
  return (
    cfData?.message ||
    cfData?.error?.message ||
    (Array.isArray(cfData?.details) ? cfData.details.map(d => d.message || d).join('; ') : null) ||
    err.message
  );
}

/**
 * Fetches live vendor status from Cashfree and updates MongoDB.
 */
export async function syncRestaurantVendorFromCashfree(restaurant) {
  const vendorId = restaurant.cashfree?.vendorId || buildRestaurantVendorId(restaurant);
  const cfVendor = await paymentClient.fetchVendor(vendorId);

  restaurant.cashfree = restaurant.cashfree || {};
  restaurant.cashfree.vendorId = cfVendor.vendor_id || vendorId;
  restaurant.cashfree.beneficiaryId = restaurant.cashfree.vendorId;
  restaurant.cashfree.vendorStatus = mapCashfreeVendorStatus(cfVendor.status);
  restaurant.cashfree.vendorError = null;

  if (restaurant.cashfree.vendorStatus === 'ACTIVE') {
    restaurant.cashfree.vendorCreatedAt = restaurant.cashfree.vendorCreatedAt || new Date();
  }

  await restaurant.save();

  logger.info('[Marketplace] Vendor synced from Cashfree', {
    restaurantId: restaurant._id,
    vendorId: restaurant.cashfree.vendorId,
    status: restaurant.cashfree.vendorStatus
  });

  return { restaurant, vendor: cfVendor };
}

/**
 * Creates (or re-fetches) Cashfree Easy Split vendor for a restaurant.
 * Money settles to this vendor's bank — never the platform owner's personal account.
 */
export async function createRestaurantBeneficiary(restaurantId) {
  const restaurant = await Restaurant.findById(restaurantId).populate('owner', 'name email phone');
  if (!restaurant) {
    throw new Error('Restaurant not found');
  }

  const bankErrors = validateBankDetailsForVendor(restaurant.bankDetails);
  if (bankErrors.length > 0) {
    throw new Error(`Bank details incomplete: ${bankErrors.join(', ')}`);
  }

  const vendorId = buildRestaurantVendorId(restaurant);
  const owner = restaurant.owner;
  const phone = (restaurant.contact?.phone || owner?.phone || '9999999999')
    .replace(/\D/g, '')
    .slice(-10);
  const email = restaurant.contact?.email || owner?.email || `vendor+${restaurant.slug}@Orderin.local`;

  const vendorRequest = {
    vendor_id: vendorId,
    status: 'ACTIVE',
    name: (restaurant.bankDetails.accountHolderName || restaurant.name).substring(0, 100),
    email: email.substring(0, 100),
    phone,
    verify_account: true,
    dashboard_access: false,
    schedule_option: 1,
    bank: {
      account_number: restaurant.bankDetails.accountNumber.trim(),
      account_holder: restaurant.bankDetails.accountHolderName.trim(),
      ifsc: restaurant.bankDetails.ifscCode.trim().toUpperCase()
    },
    kyc_details: {
      account_type: process.env.CASHFREE_VENDOR_ACCOUNT_TYPE || 'BUSINESS',
      // Must match Cashfree accepted list exactly (e.g. "Food and Beverages", not underscores)
      business_type: process.env.CASHFREE_VENDOR_BUSINESS_TYPE || 'Food and Beverages',
      pan: process.env.CASHFREE_VENDOR_DEFAULT_PAN || 'AAAPL1234C'
    }
  };

  try {
    const cfVendor = await paymentClient.createVendor(
      vendorRequest,
      `beneficiary_${restaurant._id}`
    );

    restaurant.cashfree = restaurant.cashfree || {};
    restaurant.cashfree.vendorId = cfVendor.vendor_id || vendorId;
    restaurant.cashfree.beneficiaryId = restaurant.cashfree.vendorId;
    restaurant.cashfree.vendorStatus = mapCashfreeVendorStatus(cfVendor.status);
    restaurant.cashfree.vendorCreatedAt = new Date();
    restaurant.cashfree.vendorError = null;
    await restaurant.save();

    logger.info('[Marketplace] Cashfree vendor created', {
      restaurantId: restaurant._id,
      vendorId: restaurant.cashfree.vendorId,
      status: restaurant.cashfree.vendorStatus
    });

    // If Cashfree returned PENDING (e.g. bank verification), refresh live status once
    if (restaurant.cashfree.vendorStatus === 'PENDING' && !paymentClient.isMockMode()) {
      try {
        const synced = await syncRestaurantVendorFromCashfree(restaurant);
        return {
          success: true,
          restaurant: synced.restaurant,
          vendor: synced.vendor,
          note: 'Vendor created; status synced from Cashfree.'
        };
      } catch (syncErr) {
        logger.warn('[Marketplace] Post-create vendor sync failed', { error: syncErr.message });
      }
    }

    return { success: true, restaurant, vendor: cfVendor };
  } catch (err) {
    const message = extractCashfreeErrorMessage(err);

    // Vendor was created on a previous attempt — link existing vendor instead of failing
    if (isVendorAlreadyExistsError(message)) {
      restaurant.cashfree = restaurant.cashfree || {};
      restaurant.cashfree.vendorId = vendorId;
      restaurant.cashfree.beneficiaryId = vendorId;
      await restaurant.save();

      try {
        const synced = await syncRestaurantVendorFromCashfree(restaurant);
        logger.info('[Marketplace] Linked existing Cashfree vendor', {
          restaurantId: restaurant._id,
          vendorId,
          status: synced.restaurant.cashfree.vendorStatus
        });
        return {
          success: true,
          restaurant: synced.restaurant,
          vendor: synced.vendor,
          alreadyExisted: true,
          message: 'Vendor already registered with Cashfree. Status synced successfully.'
        };
      } catch (syncErr) {
        const syncMsg = extractCashfreeErrorMessage(syncErr);
        restaurant.cashfree.vendorStatus = 'PENDING';
        restaurant.cashfree.vendorError = `Vendor exists in Cashfree but sync failed: ${syncMsg}`;
        await restaurant.save();
        throw new Error(restaurant.cashfree.vendorError);
      }
    }

    restaurant.cashfree = restaurant.cashfree || {};
    restaurant.cashfree.vendorStatus = 'FAILED';
    restaurant.cashfree.vendorError = message;
    await restaurant.save();

    logger.error('[Marketplace] Vendor creation failed', {
      restaurantId: restaurant._id,
      error: message
    });
    throw new Error(`Cashfree vendor creation failed: ${message}`);
  }
}

/**
 * Ensures restaurant has an active Cashfree vendor before accepting payments.
 */
export async function ensureRestaurantVendor(restaurant) {
  if (restaurant.cashfree?.vendorId && !paymentClient.isMockMode()) {
    try {
      const synced = await syncRestaurantVendorFromCashfree(restaurant);
      restaurant = synced.restaurant;
      if (restaurant.cashfree.vendorStatus === 'ACTIVE') {
        return restaurant;
      }
      if (restaurant.cashfree.vendorStatus === 'PENDING') {
        logger.warn('[Marketplace] Vendor is PENDING in Cashfree — payments may work after bank verification', {
          vendorId: restaurant.cashfree.vendorId
        });
        return restaurant;
      }
    } catch (syncErr) {
      logger.warn('[Marketplace] Vendor sync before payment failed', { error: syncErr.message });
    }
  }

  if (restaurant.cashfree?.vendorStatus === 'ACTIVE' && restaurant.cashfree?.vendorId) {
    return restaurant;
  }

  if (restaurant.cashfree?.vendorStatus === 'PENDING' && restaurant.cashfree?.vendorId) {
    return restaurant;
  }

  const bankErrors = validateBankDetailsForVendor(restaurant.bankDetails);
  if (bankErrors.length > 0) {
    throw new Error(
      'Restaurant must complete bank details before accepting payments. ' + bankErrors.join(', ')
    );
  }

  const result = await createRestaurantBeneficiary(restaurant._id);
  return result.restaurant;
}

/**
 * Build order_splits for PG create order — restaurant share only; platform keeps commission in nodal ledger.
 */
export function buildOrderSplitPayload(restaurant, orderAmount) {
  const commissionPercent = getPlatformCommissionPercent(restaurant);
  const split = calculateMarketplaceSplit(orderAmount, commissionPercent);
  const vendorId = restaurant.cashfree?.vendorId;

  if (!vendorId) {
    throw new Error('Restaurant Cashfree vendor not configured');
  }

  return {
    splitAmounts: split,
    order_splits: [
      {
        vendor_id: vendorId,
        percentage: split.restaurantSharePercent
      }
    ],
    splitAfterPaymentFallback: {
      split: [
        {
          vendor_id: vendorId,
          percentage: split.restaurantSharePercent
        }
      ],
      disable_split: true
    }
  };
}

/**
 * Create or update marketplace settlement record for an order.
 */
export async function upsertMarketplaceSettlement({
  order,
  restaurant,
  cashfreeOrderId,
  splitAmounts,
  order_splits,
  splitType = 'order_splits'
}) {
  const vendorId = restaurant.cashfree?.vendorId;
  return MarketplaceSettlement.findOneAndUpdate(
    { order: order._id },
    {
      order: order._id,
      restaurant: restaurant._id,
      cashfreeOrderId,
      orderAmount: splitAmounts.orderAmount,
      platformCommissionPercent: splitAmounts.platformCommissionPercent,
      platformCommission: splitAmounts.platformCommission,
      restaurantAmount: splitAmounts.restaurantAmount,
      cashfreeVendorId: vendorId,
      splitType,
      paymentStatus: 'CREATED',
      settlementStatus: 'PENDING',
      splitDetails: { order_splits: order_splits || [] }
    },
    { upsert: true, new: true }
  );
}

/**
 * Initiate split-after-payment (call ~2 min after PAYMENT_SUCCESS if needed).
 */
export async function initiateSplitAfterPayment(marketplaceSettlement) {
  const { cashfreeOrderId, restaurantAmount, orderAmount, cashfreeVendorId } = marketplaceSettlement;
  const restaurant = await Restaurant.findById(marketplaceSettlement.restaurant);
  if (!restaurant?.cashfree?.vendorId) {
    throw new Error('Vendor ID missing for split-after-payment');
  }

  const splitRequest = {
    split: [
      {
        vendor_id: cashfreeVendorId || restaurant.cashfree.vendorId,
        amount: restaurantAmount
      }
    ],
    disable_split: true
  };

  const result = await paymentClient.splitAfterPayment(
    cashfreeOrderId,
    splitRequest,
    `split_${marketplaceSettlement.order}`
  );

  marketplaceSettlement.settlementStatus = 'SPLIT_INITIATED';
  marketplaceSettlement.splitInitiatedAt = new Date();
  marketplaceSettlement.splitType = 'split_after_payment';
  marketplaceSettlement.splitDetails = result;
  await marketplaceSettlement.save();

  logger.info('[Marketplace] Split-after-payment initiated', { cashfreeOrderId });
  return result;
}

/**
 * Fetch settlement status from Cashfree and sync to MongoDB.
 */
export async function syncSettlementStatus(orderId) {
  const settlement = await MarketplaceSettlement.findOne({ order: orderId });
  if (!settlement) {
    throw new Error('Marketplace settlement record not found');
  }

  if (!settlement.cashfreeOrderId) {
    return { settlement, cashfreeRecon: null };
  }

  if (paymentClient.isMockMode()) {
    if (settlement.paymentStatus === 'PAID' && settlement.settlementStatus === 'PENDING') {
      settlement.settlementStatus = 'SETTLED';
      settlement.settledAt = new Date();
      settlement.settlementDetails = { mock: true, settled: 'YES' };
      await settlement.save();
    }
    return { settlement, cashfreeRecon: settlement.settlementDetails };
  }

  const recon = await paymentClient.fetchSplitSettlement(settlement.cashfreeOrderId);
  settlement.settlementDetails = recon;

  const settledFlag = recon?.settled === 'YES' || recon?.settled === true;
  if (settledFlag && settlement.settlementStatus !== 'SETTLED') {
    settlement.settlementStatus = 'SETTLED';
    settlement.settledAt = new Date();
  }

  await settlement.save();
  return { settlement, cashfreeRecon: recon };
}

/**
 * Auto-onboard vendor when bank details are saved (non-blocking).
 */
export async function tryAutoCreateBeneficiary(restaurantId) {
  try {
    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) return;
    if (restaurant.cashfree?.vendorStatus === 'ACTIVE') return;

    const bankErrors = validateBankDetailsForVendor(restaurant.bankDetails);
    if (bankErrors.length > 0) return;

    await createRestaurantBeneficiary(restaurantId);
  } catch (err) {
    logger.warn('[Marketplace] Auto beneficiary creation skipped', { restaurantId, error: err.message });
  }
}
