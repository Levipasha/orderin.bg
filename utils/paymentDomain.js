import logger from './logger.js';

// Precedence priority matrix (higher number is more terminal)
export const STATE_PRIORITY = {
  'CREATED': 10,
  'PENDING_PAYMENT': 10,
  'PROCESSING': 20,
  'PAYMENT_PROCESSING': 20,
  'FAILED': 30,
  'EXPIRED': 30,
  'ABANDONED': 30,
  'PAID': 40,
  'REFUNDED': 50
};

/**
 * Asserts if a payment transition from a given state to a target state is valid.
 */
export function canTransition(fromStatus, toStatus) {
  const current = (fromStatus || 'CREATED').toUpperCase();
  const target = (toStatus || 'CREATED').toUpperCase();

  const currentPriority = STATE_PRIORITY[current] || 0;
  const targetPriority = STATE_PRIORITY[target] || 0;

  // Rule: State transitions must be strictly monotonic (equal or higher priority)
  if (targetPriority < currentPriority) {
    logger.warn(`[Payment Domain Matrix] Blocked disallowed priority downgrade transition: ${current} -> ${target}`);
    return false;
  }

  // Double-check terminal state overrides
  if (current === 'PAID' && target !== 'REFUNDED' && target !== 'PAID') {
    logger.warn(`[Payment Domain Matrix] Blocked invalid mutation of PAID state to ${target}`);
    return false;
  }

  if (current === 'REFUNDED' && target !== 'REFUNDED') {
    logger.warn(`[Payment Domain Matrix] Blocked state mutation from terminal REFUNDED state.`);
    return false;
  }

  return true;
}
