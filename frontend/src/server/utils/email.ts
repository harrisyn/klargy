import nodemailer from 'nodemailer';
import { APP_NAME, DEFAULT_APP_NAME, buildAppUrl } from '../config/appConfig';
import { issueCode } from '../lib/verification';

// In development, we use Ethereal (fake SMTP) or console logging
// In production, configure real SMTP settings via environment variables

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

// Create transporter based on environment variables.
// If SMTP_HOST is present we will use those values (this makes it easy to point at Mailpit or another local SMTP server).
// Otherwise in development we attempt to create a nodemailer test account (ethereal) so getTestMessageUrl() works.
const createTransporter = async () => {
  if (process.env.SMTP_HOST) {
    // Use explicit SMTP config (works for Mailpit at mailpit:1025, real SMTP servers, etc.)
    const opts: any = {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
    };

    if (process.env.SMTP_USER || process.env.SMTP_PASS) {
      opts.auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
    }

    return nodemailer.createTransport(opts);
  }

  // No SMTP configured — for development create an ethereal test account so emails can be previewed
  try {
    const testAccount = await nodemailer.createTestAccount();
    return nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
  } catch (err) {
    // If we cannot create a test account for any reason, fall back to null which will cause console logging
    console.warn('Could not create test SMTP account, emails will be logged instead.', err);
    return null;
  }
};

let transporter: any = null;

// Initialize transporter asynchronously so createTransporter can await createTestAccount if needed
(async () => {
  transporter = await createTransporter();
})();

export const sendEmail = async (options: EmailOptions): Promise<{ success: boolean; messageId?: string; previewUrl?: string }> => {
  const { to, subject, html, text } = options;
  // Ensure transporter exists — it's initialized asynchronously on startup but may not be ready on first send
  if (!transporter) {
    transporter = await createTransporter();
  }

  // In development without SMTP or test account, just log the email
  if (!transporter) {
    console.log('\n📧 ═══════════════════════════════════════════════════════');
    console.log('   EMAIL (Development Mode - Not Actually Sent)');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`   To: ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log('───────────────────────────────────────────────────────────');
    console.log(text || html.replace(/<[^>]*>/g, ''));
    console.log('═══════════════════════════════════════════════════════════\n');
    return { success: true, messageId: 'dev-' + Date.now() };
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || `"${APP_NAME}" <noreply@${APP_NAME.toLowerCase().replace(/\s+/g, '')}.local>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ''),
    });

    return { 
      success: true, 
      messageId: info.messageId,
      previewUrl: nodemailer.getTestMessageUrl(info) || undefined
    };
  } catch (error) {
    console.error('Failed to send email:', error);
    return { success: false };
  }
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The product's app icon before its name in the header - only under the
 * default name, since a renamed deployment or an organisation's own branding
 * isn't ours to put a Klargy mark on. PNG, as most mail clients drop SVG. */
const brandIcon = (brandName: string) =>
  brandName.trim().toLowerCase() === DEFAULT_APP_NAME.toLowerCase()
    ? `<img src="${buildAppUrl('/icon-192.png')}" width="32" height="32" alt="" style="display:inline-block;vertical-align:middle;margin:-4px 10px 0 0;border:0;border-radius:8px;">`
    : '';

/** Shared email shell: flat teal header, white card, muted footer. */
export const emailLayout = (heading: string, bodyHtml: string, brandName: string = APP_NAME) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
        <tr><td style="background-color:#0a655a;padding:24px 32px;">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:600;">${brandIcon(brandName)}${escapeHtml(brandName)}</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 16px;color:#18181b;font-size:20px;font-weight:600;">${escapeHtml(heading)}</h1>
          ${bodyHtml}
        </td></tr>
        <tr><td style="background-color:#fafafa;padding:20px 32px;border-top:1px solid #e4e4e7;">
          <p style="margin:0;color:#a1a1aa;font-size:12px;">&copy; ${new Date().getFullYear()} ${escapeHtml(brandName)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

const paragraph = (text: string) =>
  `<p style="margin:0 0 16px;color:#52525b;font-size:15px;line-height:1.6;">${text}</p>`;
const button = (href: string, label: string) =>
  `<p style="margin:24px 0;"><a href="${href}" style="display:inline-block;background-color:#0a655a;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px;">${escapeHtml(label)}</a></p>`;

// Send OTP email
export const sendOTPEmail = async (email: string): Promise<{ success: boolean; error?: string }> => {
  const code = await issueCode('EMAIL_VERIFY', email);

  const html = emailLayout(
    'Verify your email',
    paragraph('Use this code to finish creating your account. It expires in 10 minutes.') +
      `<p style="margin:0 0 24px;padding:20px;background-color:#f0fdfa;border-radius:8px;text-align:center;color:#0a655a;font-size:32px;font-weight:700;letter-spacing:8px;font-family:'Courier New',monospace;">${code}</p>` +
      paragraph("If you didn't request this code, you can ignore this email.")
  );

  return sendEmail({
    to: email,
    subject: `${code} is your ${APP_NAME} verification code`,
    html,
    text: `Your ${APP_NAME} verification code is: ${code}

This code will expire in 10 minutes.

If you didn't request this code, you can safely ignore this email.`,
  });
};

export const sendPasswordResetEmail = async (email: string, resetUrl: string) => {
  const html = emailLayout(
    'Reset your password',
    paragraph('Someone asked to reset the password for this account. The link below works once and expires in 1 hour.') +
      button(resetUrl, 'Choose a new password') +
      paragraph("If this wasn't you, you can ignore this email. Your password won't change.")
  );
  return sendEmail({
    to: email,
    subject: `Reset your ${APP_NAME} password`,
    html,
    text: `Reset your ${APP_NAME} password: ${resetUrl}

This link works once and expires in 1 hour. If this wasn't you, ignore this email.`,
  });
};

export const sendNotificationEmail = async (email: string, heading: string, message: string, brandName?: string) => {
  return sendEmail({
    to: email,
    subject: heading,
    html: emailLayout(heading, paragraph(escapeHtml(message)), brandName),
    text: message,
  });
};

export const sendInviteEmail = async (email: string, opts: { inviteUrl: string; orgName: string; inviterName: string; roleLabel: string }) => {
  const heading = `Join ${opts.orgName}`;
  const html = emailLayout(
    heading,
    paragraph(`${escapeHtml(opts.inviterName)} has invited you to ${escapeHtml(opts.orgName)} as ${escapeHtml(opts.roleLabel)}.`) +
      button(opts.inviteUrl, 'Accept the invite') +
      paragraph('The link expires in 7 days. If you weren’t expecting this, you can ignore it.'),
    opts.orgName
  );
  return sendEmail({
    to: email,
    subject: `${opts.inviterName} invited you to ${opts.orgName}`,
    html,
    text: `${opts.inviterName} has invited you to ${opts.orgName} as ${opts.roleLabel}.

Accept: ${opts.inviteUrl}

The link expires in 7 days.`,
  });
};
