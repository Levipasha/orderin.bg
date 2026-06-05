import Razorpay from 'razorpay';
import logger from '../utils/logger.js';
import Restaurant from '../models/Restaurant.js';
import Transfer from '../models/Transfer.js';

// Instantiate Razorpay client
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'mock_key_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'mock_key_secret'
});

// Check if we are running in mock mode
export const isMockMode = !process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID.startsWith('mock');

if (isMockMode) {
  logger.warn('[Razorpay Route Service] running in MOCK mode. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env for production.');
} else {
  logger.info(`[Razorpay Route Service] configured successfully with Key ID: ${process.env.RAZORPAY_KEY_ID.slice(0, 6)}***`);
}

/**
 * Creates a standard Linked Account for a restaurant on Razorpay Route.
 * @param {Object} restaurant - The restaurant database document.
 * @returns {Promise<Object>} The updated restaurant document.
 */
export async function createLinkedAccount(restaurant) {
  if (isMockMode) {
    const mockAccountId = `acc_mock_${Math.random().toString(36).substring(2, 10)}`;
    restaurant.razorpayAccountId = mockAccountId;
    restaurant.razorpayLinkedAccountId = mockAccountId;
    restaurant.kycStatus = 'approved';
    restaurant.settlementStatus = 'active';
    restaurant.kycVerifiedAt = new Date();
    await restaurant.save();
    console.log('[RAZORPAY LINKED ACCOUNT CREATED]', {
      restaurantId: restaurant._id,
      linkedAccountId: mockAccountId
    });
    logger.info(`[Razorpay Service] Mock Linked Account created for restaurant ${restaurant.name}: ${mockAccountId}`);
    return restaurant;
  }

  // Defensive validation checklist
  if (!restaurant.name && !restaurant.businessName) {
    throw new Error('Business name is required.');
  }
  if (!restaurant.ownerName) {
    throw new Error('Owner name is required.');
  }
  if (!restaurant.email) {
    throw new Error('Contact email is required.');
  }
  if (!restaurant.phone) {
    throw new Error('Contact phone is required.');
  }
  if (!restaurant.panNumber) {
    throw new Error('PAN number is required.');
  }
  if (!restaurant.bankDetails?.accountNumber || !restaurant.bankDetails?.ifscCode) {
    throw new Error('Bank account details are missing.');
  }

  // 4. Validate PAN format before API call
  const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
  if (!panRegex.test(restaurant.panNumber)) {
    throw new Error('Invalid PAN number format. Expected format: ABCDE1234F');
  }

  // 5. Validate IFSC format
  const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
  if (!ifscRegex.test(restaurant.bankDetails.ifscCode)) {
    throw new Error('Invalid IFSC code format. Expected format: ABCD0123456');
  }

  // 6. Validate phone format (exactly 10 digits)
  const phoneDigits = restaurant.phone.replace(/[^0-9]/g, '');
  if (phoneDigits.length !== 10) {
    throw new Error('Contact phone must be exactly 10 digits.');
  }

  try {
    // 3. Fix payload structure to official Razorpay format
    const accountPayload = {
      email: restaurant.email,
      phone: phoneDigits,
      type: 'route',
      legal_business_name: restaurant.businessName || restaurant.name,
      business_type: 'individual',
      contact_name: restaurant.ownerName,
      profile: {
        category: 'food',
        subcategory: 'restaurant'
      },
      legal_info: {
        pan: restaurant.panNumber
      },
      funding_accounts: [
        {
          account_type: 'bank_account',
          bank_account: {
            name: restaurant.bankDetails?.accountHolderName || restaurant.ownerName,
            ifsc: restaurant.bankDetails?.ifscCode,
            account_number: restaurant.bankDetails?.accountNumber
          }
        }
      ]
    };

    // 2. Log outgoing payload safely
    console.log('ROUTE PAYLOAD:', {
      email: accountPayload.email,
      phone: accountPayload.phone,
      business_type: accountPayload.business_type,
      legal_business_name: accountPayload.legal_business_name,
      hasPAN: !!accountPayload.legal_info?.pan,
      hasFundingAccount: !!accountPayload.funding_accounts?.length
    });

    console.log('[RAZORPAY API REQUEST STARTED] Calling razorpay.accounts.create...');
    const response = await razorpay.accounts.create(accountPayload);
    console.log('[RAZORPAY API RESPONSE RECEIVED] ID:', response?.id);

    // 7. Save Linked Account ID properly
    restaurant.razorpayAccountId = response.id;
    restaurant.razorpayLinkedAccountId = response.id;
    restaurant.kycStatus = 'approved';
    restaurant.settlementStatus = 'active';
    restaurant.kycVerifiedAt = new Date();
    await restaurant.save();

    // 9. Add verification success logs
    console.log('[RAZORPAY LINKED ACCOUNT CREATED]', {
      restaurantId: restaurant._id,
      linkedAccountId: response.id
    });

    return restaurant;
  } catch (error) {
    // 1. Add full Razorpay API raw and structured error logging
    console.error('RAZORPAY RAW ERROR:', JSON.stringify(error, null, 2));

    if (error.error) {
      console.error('RAZORPAY API ERROR:', {
        code: error.error.code,
        description: error.error.description,
        field: error.error.field,
        source: error.error.source,
        step: error.error.step,
        reason: error.error.reason
      });
    }

    // Reset status defensively
    restaurant.kycStatus = 'submitted';
    await restaurant.save();

    let razorpayErrorDescription = error?.error?.description || error?.description || error?.message || 'Linked account creation failed';
    
    // 8. Add Razorpay Route activation detection
    const isRouteDisabled = /route.*(activat|enabl|not active|not authorized)/i.test(razorpayErrorDescription);
    if (isRouteDisabled) {
      razorpayErrorDescription = "Razorpay Route is not activated on this account. Contact Razorpay support.";
    }

    throw new Error(razorpayErrorDescription);
  }
}

/**
 * Executes a split settlement transfer to the restaurant's linked account from a captured payment.
 * @param {Object} params - Transfer details
 * @param {string} params.paymentId - The captured payment ID
 * @param {number} params.amount - Amount in rupees to transfer
 * @param {string} params.recipientAccountId - The restaurant's Razorpay Account ID (acc_XXX)
 * @param {string} params.orderId - Database Order ID reference
 * @param {string} params.restaurantId - Database Restaurant ID reference
 */
export async function createSplitTransfer({ paymentId, amount, recipientAccountId, orderId, restaurantId }) {
  const amountInPaise = Math.round(amount * 100);

  if (isMockMode) {
    const mockTransferId = `trf_mock_${Math.random().toString(36).substring(2, 10)}`;
    const transfer = await Transfer.create({
      order: orderId,
      restaurant: restaurantId,
      razorpayTransferId: mockTransferId,
      amount,
      recipientAccount: recipientAccountId,
      status: 'processed'
    });
    logger.info(`[Razorpay Service] Mock split transfer processed: ${mockTransferId} of INR ${amount} to account ${recipientAccountId}`);
    return transfer;
  }

  try {
    const response = await razorpay.payments.transfer(paymentId, {
      transfers: [
        {
          account: recipientAccountId,
          amount: amountInPaise,
          currency: 'INR',
          notes: {
            orderId: orderId.toString(),
            restaurantId: restaurantId.toString()
          }
        }
      ]
    });

    const transferItem = response.items?.[0] || response;
    const transferId = transferItem.id || `trf_${Date.now()}`;

    const transfer = await Transfer.create({
      order: orderId,
      restaurant: restaurantId,
      razorpayTransferId: transferId,
      amount,
      recipientAccount: recipientAccountId,
      status: 'processed'
    });

    logger.info(`[Razorpay Service] Split transfer successful: ${transferId} (INR ${amount}) for Order ${orderId}`);
    return transfer;
  } catch (err) {
    logger.error(`[Razorpay Service] Split transfer failed for payment ${paymentId}`, { error: err.message });
    const failedTransferId = `trf_fail_${Date.now()}`;
    
    const transfer = await Transfer.create({
      order: orderId,
      restaurant: restaurantId,
      razorpayTransferId: failedTransferId,
      amount,
      recipientAccount: recipientAccountId,
      status: 'failed',
      error: err.message
    });
    
    throw err;
  }
}

/**
 * Reverses a previously processed transfer (useful for order refunds).
 * @param {string} transferId - The Razorpay transfer ID
 * @param {number} amount - Amount in rupees to reverse
 */
export async function reverseTransfer(transferId, amount) {
  const amountInPaise = Math.round(amount * 100);

  if (isMockMode) {
    logger.info(`[Razorpay Service] Mock reversed transfer ${transferId} of INR ${amount}`);
    return { success: true, isMock: true };
  }

  try {
    const response = await razorpay.transfers.reverse(transferId, {
      amount: amountInPaise
    });
    logger.info(`[Razorpay Service] Transfer reversal processed: ${response.id}`);
    
    await Transfer.findOneAndUpdate(
      { razorpayTransferId: transferId },
      { status: 'reversed' }
    );

    return response;
  } catch (err) {
    logger.error(`[Razorpay Service] Transfer reversal failed for transfer ${transferId}`, { error: err.message });
    throw err;
  }
}
