import nodemailer from 'nodemailer';
import EmailLog from '../models/EmailLog.js';
import logger from '../utils/logger.js';
import { SUBSCRIPTION_MONTHLY_PRICE_INR } from '../config/subscription.js';

// Simple Email Validation Regex
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates if an email address has a correct format.
 */
export function validateEmailAddress(email) {
  if (!email || typeof email !== 'string') return false;
  return emailRegex.test(email.trim());
}

/**
 * Initializes the Nodemailer SMTP transporter.
 */
function createTransporter() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    // logger.warn('[Email Service] SMTP credentials not fully configured in environment variables. Falling back to dynamic mock/sandbox Ethereal mailer.');
    // Return a mock transport or Ethereal fallback so local server boot doesn't crash
    return nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: {
        user: 'mock_user@ethereal.email',
        pass: 'mock_pass'
      }
    });
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // Use SSL for 465, TLS/STARTTLS for 587
    auth: { user, pass },
    tls: {
      rejectUnauthorized: false // Avoid SSL handshake issues in strict corporate networks
    }
  });
}

const transporter = createTransporter();

// ── ASYNCHRONOUS MEMORY QUEUE LAYER ──
// Operates as a background queue processor to handle massive concurrent traffic smoothly
const emailQueue = [];
let queueProcessing = false;

/**
 * Pushes an email payload to the queue for background processing.
 */
export function enqueueEmail(userId, emailType, recipient, subject, html, attachments = []) {
  if (!validateEmailAddress(recipient)) {
    logger.error(`[Email Service Queue] Blocked malformed email address: ${recipient}`);
    return;
  }

  emailQueue.push({
    userId,
    emailType,
    recipient: recipient.toLowerCase().trim(),
    subject,
    html,
    attachments,
    attempts: 0
  });

  logger.info(`[Email Service Queue] Enqueued '${emailType}' email to ${recipient}. Total queue: ${emailQueue.length}`);
  
  if (!queueProcessing) {
    processQueue();
  }
}

/**
 * Process queue loop. Processes queued emails one by one with rate-limits.
 */
async function processQueue() {
  if (emailQueue.length === 0) {
    queueProcessing = false;
    return;
  }

  queueProcessing = true;
  const job = emailQueue.shift();

  try {
    // 1. Prevent duplicate email spam (block sending the exact same type to the same recipient within a 5-second window)
    const recentDuplicate = await EmailLog.findOne({
      recipient: job.recipient,
      emailType: job.emailType,
      status: 'sent',
      createdAt: { $gte: new Date(Date.now() - 5000) } // Sent in last 5 seconds
    });

    if (recentDuplicate) {
      logger.warn(`[Email Service Duplication Check] Blocked duplicate ${job.emailType} email to ${job.recipient} (sent in last 5s).`);
      
      // Log blocked duplicate to database for complete visibility
      await EmailLog.create({
        userId: job.userId,
        emailType: job.emailType,
        recipient: job.recipient,
        subject: job.subject,
        status: 'failed',
        attempts: 1,
        errorMessage: 'Blocked duplicate email send request in 5s throttle window.'
      });

      // Proceed immediately to next job
      setImmediate(processQueue);
      return;
    }

    // 2. Increment attempts count
    job.attempts += 1;

    // Create database log record in 'queued' state if not exists yet
    let logRecord = await EmailLog.create({
      userId: job.userId,
      emailType: job.emailType,
      recipient: job.recipient,
      subject: job.subject,
      status: 'queued',
      attempts: job.attempts
    });

    // 3. Trigger live SMTP mail send
    const info = await sendMailViaTransporter({
      to: job.recipient,
      subject: job.subject,
      html: job.html,
      attachments: job.attachments
    });

    // Update log to 'sent'
    logRecord.status = 'sent';
    logRecord.sentAt = new Date();
    await logRecord.save();

    logger.info(`[Email Service SUCCESS] Sent '${job.emailType}' to ${job.recipient}. Message ID: ${info?.messageId || 'MOCK_ID'}`);

  } catch (err) {
    logger.error(`[Email Service FAILURE] Failed sending '${job.emailType}' to ${job.recipient} (Attempt ${job.attempts}/3): ${err.message}`);

    if (job.attempts < 3) {
      // Re-queue with exponential backoff delay (attempts * 2 seconds)
      const delayMs = job.attempts * 2000;
      logger.info(`[Email Service Retry] Re-queueing job for ${job.recipient} in ${delayMs}ms...`);
      
      setTimeout(() => {
        emailQueue.push(job);
        if (!queueProcessing) {
          processQueue();
        }
      }, delayMs);
    } else {
      // Log permanent failure in database
      await EmailLog.create({
        userId: job.userId,
        emailType: job.emailType,
        recipient: job.recipient,
        subject: job.subject,
        status: 'failed',
        attempts: job.attempts,
        errorMessage: err.message
      });
      logger.error(`[Email Service Permanent Fail] Exhausted retries for ${job.recipient}. Saved error to DB.`);
    }
  }

  // Rate-limiting delay (300ms) between sends to protect SMTP host connection limits
  setTimeout(processQueue, 300);
}

/**
 * Triggers nodemailer deliver.
 */
function sendMailViaTransporter(mailOptions) {
  const fromAddress = process.env.SMTP_USER || 'no-reply@orderin.com';
  
  // Package the brand logo as an inline attachment (CID)
  const logoAttachment = {
    filename: 'logo.png',
    path: 'https://img.icons8.com/fluency/196/hamburger.png',
    cid: 'brandlogo'
  };
  
  const attachments = mailOptions.attachments 
    ? [...mailOptions.attachments, logoAttachment] 
    : [logoAttachment];

  return transporter.sendMail({
    from: `"Orderin" <${fromAddress}>`,
    to: mailOptions.to,
    subject: mailOptions.subject,
    html: mailOptions.html,
    attachments: attachments
  });
}

// ── EMAIL RESPONSIVE HTML LAYOUT WRAPPER ──
// Designed with ultra-premium HSL colors (Crimson, Slate-900, Slate-100) to wow owners and customers alike.
function getHtmlLayout(title, contentHtml) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #0b0c10;
      color: #f3f4f6;
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      background-color: #0b0c10;
      padding: 30px 15px;
      box-sizing: border-box;
    }
    .container {
      max-width: 580px;
      margin: 0 auto;
      background-color: #0f172a;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    .header {
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      padding: 24px 30px;
      text-align: center;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .brand {
      display: inline-block;
      vertical-align: middle;
    }
    .brand-logo {
      display: inline-block;
      vertical-align: middle;
      width: 32px;
      height: 32px;
      margin-right: 8px;
    }
    .brand-title {
      display: inline-block;
      vertical-align: middle;
      font-size: 20px;
      font-weight: 900;
      color: #ffffff;
      letter-spacing: -0.5px;
    }
    .body {
      padding: 35px 30px;
    }
    h1 {
      font-size: 20px;
      font-weight: 800;
      color: #ffffff;
      margin-top: 0;
      margin-bottom: 18px;
    }
    p {
      font-size: 13.5px;
      color: #94a3b8;
      line-height: 1.6;
      margin-top: 0;
      margin-bottom: 15px;
    }
    .info-card {
      background-color: #1e293b;
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 16px 20px;
      margin: 20px 0;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .info-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    .info-row:first-child {
      padding-top: 0;
    }
    .info-label {
      font-size: 11.5px;
      font-weight: 700;
      color: #64748b;
      text-transform: uppercase;
    }
    .info-value {
      font-size: 12.5px;
      font-weight: 700;
      color: #f1f5f9;
      text-align: right;
    }
    .btn-container {
      text-align: center;
      margin: 25px 0 10px;
    }
    .btn {
      display: inline-block;
      padding: 12px 28px;
      background-color: #bd3838;
      color: #ffffff !important;
      font-size: 12.5px;
      font-weight: 800;
      text-decoration: none;
      border-radius: 10px;
      box-shadow: 0 4px 12px rgba(189, 56, 56, 0.25);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      transition: background-color 0.2s;
    }
    .footer {
      background-color: #0b0f19;
      padding: 24px 30px;
      text-align: center;
      border-top: 1px solid rgba(255,255,255,0.05);
    }
    .footer p {
      font-size: 11px;
      color: #475569;
      margin: 0 0 6px;
    }
    .footer a {
      color: #bd3838;
      text-decoration: none;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      
      <!-- Brand Header -->
      <div class="header">
        <div class="brand">
          <img src="cid:brandlogo" class="brand-logo" alt="Orderin" />
          <span class="brand-title">Orderin</span>
        </div>
      </div>
      
      <!-- Mail Core Body -->
      <div class="body">
        ${contentHtml}
      </div>
      
      <!-- Foot Compliance -->
      <div class="footer">
        <p>This is an automated system notification regarding your Orderin SaaS Account.</p>
        <p>© ${new Date().getFullYear()} SkyWeb IT Solutions Private Limited. All rights reserved.</p>
        <p>Hyderabad, Telangana, India. Support: <a href="mailto:support@orderin.com">support@orderin.com</a></p>
      </div>

    </div>
  </div>
</body>
</html>
  `;
}

// ── REUSABLE SEND ACTIONS ──

/**
 * Sends welcome email upon registration.
 */
export function sendWelcomeEmail(recipient, userName, loginUrl = 'https://orderin.com/login') {
  const content = `
    <h1>Welcome to Orderin! 🎉</h1>
    <p>Hey ${userName},</p>
    <p>We are absolutely thrilled to welcome you as a restaurant partner on the Orderin SaaS Marketplace Platform! You are now fully equipped with elite tools to scale your culinary business to absolute new heights.</p>
    <p>Here is what you can do right now inside your owner dashboard:</p>
    <ul style="font-size: 13px; color: #94a3b8; line-height: 1.6; padding-left: 20px;">
      <li>Design custom glassmorphic digital menus</li>
      <li>Download and print tableside QR codes</li>
      <li>Track real-time portions sold and payout summaries</li>
      <li>Enable instant customer pre-orders and pickup scheduling</li>
    </ul>
    
    <div class="info-card">
      <div class="info-row">
        <span class="info-label">Account Owner</span>
        <span class="info-value">${userName}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Support Access</span>
        <span class="info-value">support@orderin.com</span>
      </div>
      <div class="info-row">
        <span class="info-label">Creation Date</span>
        <span class="info-value">${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
      </div>
    </div>

    <div class="btn-container">
      <a href="${loginUrl}" class="btn" target="_blank">Access Your Dashboard</a>
    </div>
    
    <p style="margin-top: 20px; font-size: 12px; color: #64748b;">If you have any questions or require dynamic assistance with table setups, feel free to reach out to our dedicated support managers at support@orderin.com.</p>
  `;

  enqueueEmail(null, 'welcome', recipient, 'Welcome to Orderin', getHtmlLayout('Welcome to Orderin', content));
}

/**
 * Sends a security alert notification when login is detected.
 */
export function sendLoginAlertEmail(recipient, userName, alertDetails) {
  const content = `
    <h1 style="color: #f59e0b;">⚠️ New Login Detected</h1>
    <p>Hey ${userName},</p>
    <p>We noticed a new successful sign-in to your Orderin Restaurant Owner Panel. Please verify the connection details below to secure your business credentials:</p>
    
    <div class="info-card" style="border-left: 3px solid #f59e0b;">
      <div class="info-row">
        <span class="info-label">Account Owner</span>
        <span class="info-value">${userName}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Date & Time</span>
        <span class="info-value">${new Date(alertDetails.loginTime || Date.now()).toLocaleString('en-IN')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">IP Address</span>
        <span class="info-value">${alertDetails.ipAddress || 'Unknown IP'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Device Info</span>
        <span class="info-value">${alertDetails.device || 'Web Browser'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Browser Details</span>
        <span class="info-value">${alertDetails.browser || 'Unknown'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Approx Location</span>
        <span class="info-value">${alertDetails.location || 'India'}</span>
      </div>
    </div>

    <p style="font-size: 12px; color: #ef4444; font-weight: 700; margin-top: 15px;">If this was NOT you, please reset your password immediately or contact our dynamic security response desk at security@orderin.com.</p>
  `;

  enqueueEmail(null, 'login_alert', recipient, 'New Login Detected', getHtmlLayout('Security Alert: New Login', content));
}

/**
 * Sends subscription purchase success confirmation.
 */
export function sendSubscriptionEmail(recipient, userName, data) {
  const content = `
    <h1 style="color: #10b981;">🚀 Subscription Activated Successfully!</h1>
    <p>Hey ${userName},</p>
    <p>Your subscription is active! We have enabled all premium features for your restaurant profile. See your billing cycle details below:</p>
    
    <div class="info-card" style="border-left: 3px solid #10b981;">
      <div class="info-row">
        <span class="info-label">Plan Purchased</span>
        <span class="info-value">${data.planName || 'Premium Pro'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Amount Charged</span>
        <span class="info-value">₹${data.amountPaid}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Billing Terms</span>
        <span class="info-value">${data.billingCycle || 'Monthly'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Activation Date</span>
        <span class="info-value">${new Date(data.startDate || Date.now()).toLocaleDateString('en-IN')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Expiry Date</span>
        <span class="info-value">${new Date(data.expiryDate).toLocaleDateString('en-IN')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Payment Mode</span>
        <span class="info-value">${data.paymentMethod || 'Razorpay Secure'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Transaction ID</span>
        <span class="info-value font-mono" style="font-size: 11px;">${data.transactionId}</span>
      </div>
    </div>

    <div class="btn-container">
      <a href="https://orderin.com/login" class="btn" style="background-color: #10b981; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.25);">Manage Dashboard</a>
    </div>
  `;

  enqueueEmail(null, 'subscription_purchase', recipient, 'Subscription Activated Successfully', getHtmlLayout('Subscription Success', content));
}

/**
 * Sends a warning alert when subscription is nearing expiration.
 */
export function sendExpiryReminderEmail(recipient, userName, data) {
  const content = `
    <h1 style="color: #f59e0b;">⏳ Your Subscription Expires Soon</h1>
    <p>Hey ${userName},</p>
    <p>This is a billing notification that your active restaurant subscription is nearing its expiration date. Renew today to maintain uninterrupted tableside QR orders, live menu access, and sales metrics dashboards.</p>
    
    <div class="info-card" style="border-left: 3px solid #f59e0b;">
      <div class="info-row">
        <span class="info-label">Time Remaining</span>
        <span class="info-value" style="color: #f59e0b;">${data.remainingDays} Days Left</span>
      </div>
      <div class="info-row">
        <span class="info-label">Current Plan</span>
        <span class="info-value">${data.planName || 'Premium Pro'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Renewal Amount</span>
        <span class="info-value">₹${data.renewalAmount ?? SUBSCRIPTION_MONTHLY_PRICE_INR}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Expiration Date</span>
        <span class="info-value">${new Date(data.expiryDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
      </div>
    </div>

    <div class="btn-container">
      <a href="https://orderin.com/login" class="btn" style="background-color: #f59e0b; box-shadow: 0 4px 12px rgba(245, 158, 11, 0.25);">Renew Subscription Now</a>
    </div>
  `;

  enqueueEmail(null, 'expiry_reminder', recipient, 'Your Subscription Expires Soon', getHtmlLayout('Billing Alert: Expiry Warning', content));
}

/**
 * Sends email when subscription has expired and services are on hold.
 */
export function sendExpiredEmail(recipient, userName, planName = 'Premium Pro') {
  const content = `
    <h1 style="color: #ef4444;">❌ Subscription Expired - Services Suspended</h1>
    <p>Hey ${userName},</p>
    <p>We want to inform you that your active billing cycle has completed, and your SaaS subscription has officially expired. Your restaurant is now placed on <strong>Hold</strong> status.</p>
    <p>To avoid disruptions, we have temporarily suspended the following features:</p>
    <ul style="font-size: 13px; color: #94a3b8; line-height: 1.6; padding-left: 20px;">
      <li style="color: #fca5a5;">Live customer digital menu web page loads</li>
      <li style="color: #fca5a5;">Tableside QR order placement integrations</li>
      <li style="color: #fca5a5;">Live order status tracking & sound alert dashboard</li>
    </ul>

    <div class="btn-container">
      <a href="https://orderin.com/login" class="btn" style="background-color: #ef4444; box-shadow: 0 4px 12px rgba(239, 68, 68, 0.25);">Reactivate Store (₹${SUBSCRIPTION_MONTHLY_PRICE_INR})</a>
    </div>

    <p style="margin-top: 15px; font-size: 12px; color: #64748b;">Reactivating takes less than 30 seconds! Simply log in, proceed with the self-serve Razorpay extension, and your digital marketplace will reload instantly.</p>
  `;

  enqueueEmail(null, 'expired', recipient, 'Subscription Expired', getHtmlLayout('Billing Alert: Subscription Expired', content));
}

/**
 * Sends a premium invoice to the user with a PDF attachment.
 */
export function sendPaymentSuccessEmail(recipient, userName, data, pdfBuffer) {
  const content = `
    <h1 style="color: #10b981;">📄 Invoice Issued: Payment Successful</h1>
    <p>Hey ${userName},</p>
    <p>Thank you for your payment! We have successfully processed your transaction. We have generated a professional tax invoice and attached it directly to this email for your audit records.</p>
    
    <div class="info-card" style="border-left: 3px solid #10b981;">
      <div class="info-row">
        <span class="info-label">Customer Name</span>
        <span class="info-value">${userName}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Invoice Number</span>
        <span class="info-value">${data.invoiceNumber || 'INV-MOCK'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Plan Purchased</span>
        <span class="info-value">${data.planName || 'Premium Pro'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Taxable Value</span>
        <span class="info-value">₹${(data.amountPaid - (data.gstAmount || 0)).toFixed(2)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Integrated GST (18%)</span>
        <span class="info-value">₹${parseFloat(data.gstAmount || 0).toFixed(2)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Total Amount Settled</span>
        <span class="info-value" style="font-size: 13.5px; color: #10b981;">₹${parseFloat(data.amountPaid).toFixed(2)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Transaction ID</span>
        <span class="info-value font-mono" style="font-size: 10px;">${data.transactionId}</span>
      </div>
    </div>

    <p style="font-size: 12px; color: #64748b; text-align: center;">Please find your tax invoice PDF attached to this email. If you need any assistance, reach out to billing@orderin.com.</p>
  `;

  const attachmentOptions = [{
    filename: `Invoice_${data.invoiceNumber || 'Orderin'}.pdf`,
    content: pdfBuffer,
    contentType: 'application/pdf'
  }];

  enqueueEmail(null, 'payment_success', recipient, 'Payment Successful & Invoice', getHtmlLayout('Payment Invoice Details', content), attachmentOptions);
}

/**
 * Sends a failed checkout/payment notification.
 */
export function sendPaymentFailedEmail(recipient, userName, data) {
  const content = `
    <h1 style="color: #ef4444;">⚠️ Payment Failed Notification</h1>
    <p>Hey ${userName},</p>
    <p>We were unable to process your payment for the Orderin Premium Pro subscription. Our secure payment gateway returned a transaction failure callback.</p>
    
    <div class="info-card" style="border-left: 3px solid #ef4444;">
      <div class="info-row">
        <span class="info-label">Purchasing Plan</span>
        <span class="info-value">${data.planName || 'Premium Pro'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Attempted Amount</span>
        <span class="info-value">₹${data.amountPaid ?? SUBSCRIPTION_MONTHLY_PRICE_INR}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Failure Reason</span>
        <span class="info-value" style="color: #ef4444; font-weight: 700;">${data.failureReason || 'Insufficient funds or transaction declined by bank.'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Gateway Details</span>
        <span class="info-value">${data.gateway || 'Razorpay Gateway Secure'}</span>
      </div>
    </div>

    <div class="btn-container">
      <a href="${data.retryUrl || 'https://orderin.com/login'}" class="btn" style="background-color: #ef4444; box-shadow: 0 4px 12px rgba(239, 68, 68, 0.25);">Retry Secure Checkout</a>
    </div>

    <p style="font-size: 11.5px; color: #64748b; margin-top: 15px;">No funds have been charged from your accounts. If a debit was processed, a reverse settlement will automatically credit back your source bank card within 3-5 business days.</p>
  `;

  enqueueEmail(null, 'payment_failed', recipient, 'Payment Failed', getHtmlLayout('Billing Alert: Payment Failed', content));
}

/**
 * Sends administrative system notifications.
 */
export function sendAdminAlert(recipient, userName, eventType, data) {
  const content = `
    <h1>🔔 Administrative Alert: ${eventType.replace(/_/g, ' ').toUpperCase()}</h1>
    <p>Hello Admin,</p>
    <p>An administrative system event trigger has executed on the platform cockpit. See the parameters below:</p>
    
    <div class="info-card">
      <div class="info-row">
        <span class="info-label">Alert Type</span>
        <span class="info-value font-black">${eventType}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Affected Recipient</span>
        <span class="info-value">${userName} (${recipient})</span>
      </div>
      <div class="info-row">
        <span class="info-label">Date & Time</span>
        <span class="info-value">${new Date().toLocaleString('en-IN')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Event Parameters</span>
        <span class="info-value" style="font-size: 10px; font-family: monospace;">${JSON.stringify(data)}</span>
      </div>
    </div>
  `;

  enqueueEmail(null, 'admin_alert', 'admin@Orderin.com', `Admin Alert: ${eventType.replace(/_/g, ' ')}`, getHtmlLayout('System Administrative Alert', content));
}
