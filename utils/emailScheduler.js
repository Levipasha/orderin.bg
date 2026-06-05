import cron from 'node-cron';
import Restaurant from '../models/Restaurant.js';
import User from '../models/User.js';
import { sendExpiryReminderEmail, sendExpiredEmail } from '../services/emailService.js';
import logger from './logger.js';
import { SUBSCRIPTION_MONTHLY_PRICE_INR } from '../config/subscription.js';

/**
 * Daily scheduler to scan all tenant billing records and trigger alerts or auto-hold expirations.
 */
export async function runSubscriptionBillingCheck() {
  logger.info('[Email Scheduler] Running daily subscription billing scan...');
  
  try {
    // 1. Fetch all active or newly registered restaurants
    const restaurants = await Restaurant.find({ 
      subscriptionPlan: { $in: ['free', 'basic'] }
    }).populate('owner');

    let reminderCount = 0;
    let expiredCount = 0;

    for (const r of restaurants) {
      if (!r.subscriptionExpiry) continue;

      const expiryDate = new Date(r.subscriptionExpiry);
      const today = new Date();
      
      // Calculate remaining days (difference in time divided by milliseconds in a day)
      const diffTime = expiryDate.getTime() - today.getTime();
      const remainingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      const ownerEmail = r.email || r.contact?.email || r.owner?.email;
      const ownerName = r.ownerName || r.owner?.name || 'Restaurant Partner';

      if (!ownerEmail) {
        logger.warn(`[Email Scheduler] Skipping billing check for restaurant '${r.name}': No owner email found.`);
        continue;
      }

      // Check Expiration Milestones
      if (remainingDays > 0) {
        const warningMilestones = [30, 15, 7, 3, 1];
        
        if (warningMilestones.includes(remainingDays)) {
          logger.info(`[Email Scheduler] Expiry Alert triggered for '${r.name}': ${remainingDays} days remaining.`);
          
          sendExpiryReminderEmail(ownerEmail, ownerName, {
            remainingDays,
            planName: r.subscriptionPlan === 'free' ? 'Free Trial' : 'Premium Pro',
            renewalAmount: SUBSCRIPTION_MONTHLY_PRICE_INR,
            expiryDate: r.subscriptionExpiry
          });
          reminderCount++;
        }
      } else {
        // Expiry has passed! (remainingDays <= 0)
        // If the system hasn't marked it expired yet, trigger hold & notify
        if (r.subscriptionActive !== false || r.isActive !== false) {
          logger.warn(`[Email Scheduler] Subscription EXPIRED for '${r.name}'. Putting store on Hold.`);
          
          r.subscriptionActive = false;
          r.isActive = false; // Suspension of digital menu QR codes
          await r.save();

          sendExpiredEmail(ownerEmail, ownerName, r.subscriptionPlan === 'free' ? 'Free Trial' : 'Premium Pro');
          expiredCount++;
        }
      }
    }

    logger.info(`[Email Scheduler] Billing check complete. Sent ${reminderCount} alerts and auto-expired ${expiredCount} stores.`);
    return { reminderCount, expiredCount };

  } catch (err) {
    logger.error(`[Email Scheduler Error] Daily billing scan crashed: ${err.message}`);
    throw err;
  }
}

/**
 * Initializes the Node-Cron scheduler for billing checks.
 */
export function startEmailScheduler() {
  // logger.info('[Email Scheduler] Initializing billing cron task...');
  
  // Runs every morning at 09:00 AM (standard corporate timing)
  cron.schedule('0 9 * * *', () => {
    logger.info('[Cron Job] Ticker: Running Daily Subscription Billing Job...');
    runSubscriptionBillingCheck().catch(err => {
      logger.error(`[Cron Job Error] Scheduled subscription job crashed: ${err.message}`);
    });
  });
  
  // logger.info('[Email Scheduler] Node-Cron scheduled successfully to trigger at 09:00 AM every day.');
}
