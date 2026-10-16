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

// Brand palette, mirrored from globals.css. Inline hex because mail clients
// ignore CSS variables.
const C = {
  page: '#f1f5f4',
  card: '#ffffff',
  border: '#dfe4e8',
  rule: '#eef1f3',
  ink: '#0d2a47',
  body: '#4b5866',
  muted: '#677483',
  faint: '#97a3af',
  teal: '#0f9fa4',
  button: '#0b7f84',
  tint: '#edf8f8',
  tintInk: '#0a676c',
  panel: '#f6f8f7',
};
const FONT_BODY = "'Public Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_DISPLAY = "'Bricolage Grotesque','Public Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_MONO = "'JetBrains Mono',SFMono-Regular,Menlo,Consolas,'Courier New',monospace";
// --gradient-ticket, with a solid fallback for clients that drop gradients.
const TICKET_BACKGROUND = `background-color:${C.button};background-image:linear-gradient(135deg,#0f9fa4 0%,#0b7f84 45%,#004c90 100%);`;

/** Who an email is from: the product itself, or an organisation's own
 * branding (logo, colour, "Powered by"), as set in its admin settings. */
export interface EmailBrand {
  name: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
  hidePoweredBy?: boolean | null;
}

interface ResolvedBrand {
  name: string;
  isProduct: boolean;
  logoUrl: string | null;
  /** Organisation colour, when it set a valid one. */
  color: string | null;
  /** Readable text on `color` (or on the default teal). */
  onColor: string;
  poweredBy: boolean;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** White text unless the colour is too light for it, then ink. */
const textOn = (hex: string) => {
  const full = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, (d) => d + d) : hex;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (luminance + 0.05) >= 3 ? '#ffffff' : C.ink;
};

const resolveBrand = (brand: string | EmailBrand = APP_NAME): ResolvedBrand => {
  const b = typeof brand === 'string' ? { name: brand } : brand;
  const name = b.name?.trim() || APP_NAME;
  const isProduct = name.toLowerCase() === APP_NAME.toLowerCase() && !b.logoUrl && !b.primaryColor;
  const color = b.primaryColor && HEX.test(b.primaryColor.trim()) ? b.primaryColor.trim() : null;
  return {
    name,
    isProduct,
    logoUrl: b.logoUrl && /^https?:\/\//i.test(b.logoUrl) ? b.logoUrl : null,
    color,
    onColor: color ? textOn(color) : '#ffffff',
    poweredBy: !isProduct && !b.hidePoweredBy,
  };
};

/** The header mark. The Klargy wordmark only under the default product name,
 * since a renamed deployment or an organisation's own branding isn't ours to
 * put a Klargy mark on. PNG, as most mail clients drop SVG. */
const brandHeader = (brand: ResolvedBrand) => {
  if (brand.logoUrl) {
    return `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" height="40" style="display:block;height:40px;width:auto;max-width:200px;border:0;outline:none;">`;
  }
  if (brand.isProduct && brand.name.toLowerCase() === DEFAULT_APP_NAME.toLowerCase()) {
    return `<img src="${buildAppUrl('/brand/klargy-logo-email.png')}" alt="${escapeHtml(DEFAULT_APP_NAME)}" width="122" height="28" style="display:block;width:122px;height:28px;border:0;outline:none;">`;
  }
  return `<p style="margin:0;font-family:${FONT_DISPLAY};font-size:20px;line-height:28px;font-weight:700;color:${C.ink};letter-spacing:-0.2px;">${escapeHtml(brand.name)}</p>`;
};

const accentBar = (brand: ResolvedBrand) =>
  brand.color ? `background-color:${brand.color};` : TICKET_BACKGROUND;

interface LayoutOptions {
  brand?: string | EmailBrand;
  /** Inbox preview line shown after the subject. */
  preheader?: string;
  /** Why the recipient got this email, in the footer. */
  reason?: string;
}

/** Shared email shell: brand stripe and logo, white card, quiet footer. */
export const emailLayout = (heading: string, bodyHtml: string, options: LayoutOptions = {}) => {
  const brand = resolveBrand(options.brand);
  const year = new Date().getFullYear();
  const footer = [
    options.reason ? escapeHtml(options.reason) : '',
    brand.poweredBy
      ? `Powered by <a href="${escapeHtml(buildAppUrl('/'))}" style="color:${C.muted};text-decoration:underline;">${escapeHtml(APP_NAME)}</a>`
      : `&copy; ${year} ${escapeHtml(brand.name)}${brand.isProduct ? ' &middot; Queue management for clinics and service counters' : ''}`,
  ].filter(Boolean);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(heading)}</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Public+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
  body { margin:0 !important; padding:0 !important; width:100% !important; }
  a { color:${C.button}; }
  @media (max-width:520px) {
    .k-outer { padding:24px 12px !important; }
    .k-pad { padding-left:24px !important; padding-right:24px !important; }
    .k-h1 { font-size:22px !important; line-height:30px !important; }
    .k-btn a { display:block !important; text-align:center !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.page};font-family:${FONT_BODY};-webkit-font-smoothing:antialiased;">
  ${options.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(options.preheader)}${'&#847;&zwnj;&nbsp;'.repeat(60)}</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.page};">
    <tr><td align="center" class="k-outer" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:${C.card};border:1px solid ${C.border};border-radius:16px;overflow:hidden;">
        <tr><td style="${accentBar(brand)}height:6px;line-height:6px;font-size:0;">&nbsp;</td></tr>
        <tr><td class="k-pad" style="padding:32px 40px 0;">${brandHeader(brand)}</td></tr>
        <tr><td class="k-pad" style="padding:28px 40px 36px;">
          <h1 class="k-h1" style="margin:0 0 16px;font-family:${FONT_DISPLAY};color:${C.ink};font-size:26px;line-height:34px;font-weight:700;letter-spacing:-0.3px;">${escapeHtml(heading)}</h1>
          ${bodyHtml}
        </td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr><td class="k-pad" style="padding:24px 40px 0;text-align:center;">
          ${footer.map((line) => `<p style="margin:0 0 6px;color:${C.faint};font-size:12px;line-height:18px;">${line}</p>`).join('')}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
};

// Building blocks. Callers escape their own text before passing it in.
const paragraph = (html: string) =>
  `<p style="margin:0 0 16px;color:${C.body};font-size:16px;line-height:26px;">${html}</p>`;
const small = (html: string) =>
  `<p style="margin:0 0 12px;color:${C.muted};font-size:14px;line-height:22px;">${html}</p>`;

const button = (href: string, label: string, brand: ResolvedBrand = resolveBrand()) => {
  const bg = brand.color || C.button;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="k-btn" style="margin:28px 0 24px;">
  <tr><td style="border-radius:10px;background-color:${bg};">
    <a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 28px;font-family:${FONT_BODY};font-size:16px;line-height:20px;font-weight:600;color:${brand.onColor};text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
  </td></tr>
</table>`;
};

/** The raw link under a button, for clients that block it. */
const linkFallback = (href: string) =>
  `<p style="margin:0 0 16px;color:${C.muted};font-size:13px;line-height:20px;">Button not working? Paste this link into your browser:<br><a href="${escapeHtml(href)}" style="color:${C.button};word-break:break-all;">${escapeHtml(href)}</a></p>`;

const divider = () => `<div style="height:1px;line-height:1px;font-size:0;background-color:${C.rule};margin:24px 0 20px;">&nbsp;</div>`;

const codeBox = (code: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
  <tr><td align="center" style="padding:22px 16px;background-color:${C.tint};border:1px solid #d2eff0;border-radius:12px;">
    <p style="margin:0 0 6px;color:${C.tintInk};font-size:12px;line-height:16px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;">Verification code</p>
    <p style="margin:0;color:${C.ink};font-family:${FONT_MONO};font-size:34px;line-height:42px;font-weight:700;letter-spacing:10px;padding-left:10px;">${escapeHtml(code)}</p>
  </td></tr>
</table>`;

/** The hero ticket number, as on the patient's status page. */
const ticketCard = (ticket: string, service: string, brand: ResolvedBrand) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
  <tr><td align="center" style="${brand.color ? `background-color:${brand.color};` : TICKET_BACKGROUND}border-radius:14px;padding:24px 16px;">
    <p style="margin:0 0 4px;color:${brand.onColor};opacity:0.85;font-size:12px;line-height:16px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;">Your ticket</p>
    <p style="margin:0;color:${brand.onColor};font-family:${FONT_DISPLAY};font-size:44px;line-height:52px;font-weight:700;letter-spacing:1px;">${escapeHtml(ticket)}</p>
    <p style="margin:4px 0 0;color:${brand.onColor};opacity:0.9;font-size:15px;line-height:22px;">${escapeHtml(service)}</p>
  </td></tr>
</table>`;

/** Label and value rows on a soft panel (where, when, which service). */
const detailsPanel = (rows: Array<[string, string]>) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;background-color:${C.panel};border:1px solid ${C.rule};border-radius:12px;">
  ${rows
    .map(
      ([label, value], i) => `<tr>
    <td valign="top" style="padding:${i ? '12px' : '16px'} 8px ${i === rows.length - 1 ? '16px' : '0'} 20px;width:96px;color:${C.muted};font-size:13px;line-height:22px;font-weight:600;">${escapeHtml(label)}</td>
    <td valign="top" style="padding:${i ? '12px' : '16px'} 20px ${i === rows.length - 1 ? '16px' : '0'} 8px;color:${C.ink};font-size:15px;line-height:22px;font-weight:600;">${escapeHtml(value)}</td>
  </tr>`
    )
    .join('')}
</table>`;

/** Plain text (an SMS-style message or an AI digest) as email paragraphs:
 * blank lines split paragraphs, "-"/"*"/"•" lines become a list, **x** is bold. */
const formatText = (text: string) =>
  text
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      const inline = (l: string) => escapeHtml(l).replace(/\*\*(.+?)\*\*/g, '<strong style="color:#0d2a47;">$1</strong>');
      if (lines.length && lines.every((l) => /^([-*•]|\d+[.)])\s+/.test(l))) {
        return `<ul style="margin:0 0 16px;padding:0 0 0 20px;color:${C.body};font-size:16px;line-height:26px;">${lines
          .map((l) => `<li style="margin:0 0 6px;">${inline(l.replace(/^([-*•]|\d+[.)])\s+/, ''))}</li>`)
          .join('')}</ul>`;
      }
      return paragraph(lines.map(inline).join('<br>'));
    })
    .join('');

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export const otpEmail = (email: string, code: string): EmailContent => ({
  subject: `${code} is your ${APP_NAME} verification code`,
  html: emailLayout(
    'Verify your email',
    paragraph(`Enter this code to finish creating your ${escapeHtml(APP_NAME)} account.`) +
      codeBox(code) +
      small('The code expires in 10 minutes. For your security, never share it with anyone.') +
      small("If you didn't try to sign up, you can safely ignore this email."),
    { preheader: `Your verification code is ${code}. It expires in 10 minutes.`, reason: `This email was sent to ${email}.` }
  ),
  text: `Your ${APP_NAME} verification code is: ${code}

This code will expire in 10 minutes. Never share it with anyone.

If you didn't request this code, you can safely ignore this email.`,
});

export const passwordResetEmail = (email: string, resetUrl: string): EmailContent => ({
  subject: `Reset your ${APP_NAME} password`,
  html: emailLayout(
    'Reset your password',
    paragraph(`We received a request to reset the password for <strong style="color:${C.ink};">${escapeHtml(email)}</strong>.`) +
      button(resetUrl, 'Choose a new password') +
      small('This link works once and expires in 1 hour.') +
      small("If you didn't ask for this, you can ignore this email. Your password won't change.") +
      divider() +
      linkFallback(resetUrl),
    { preheader: 'Use this link within the hour to choose a new password.', reason: `This email was sent to ${email}.` }
  ),
  text: `Reset your ${APP_NAME} password: ${resetUrl}

This link works once and expires in 1 hour. If this wasn't you, ignore this email.`,
});

export interface InviteEmailOptions {
  inviteUrl: string;
  orgName: string;
  inviterName: string;
  roleLabel: string;
  brand?: EmailBrand;
}

export const inviteEmail = (email: string, opts: InviteEmailOptions): EmailContent => {
  const brand = resolveBrand(opts.brand ?? opts.orgName);
  return {
    subject: `${opts.inviterName} invited you to ${opts.orgName}`,
    html: emailLayout(
      `Join ${opts.orgName}`,
      paragraph(
        `<strong style="color:${C.ink};">${escapeHtml(opts.inviterName)}</strong> has invited you to join <strong style="color:${C.ink};">${escapeHtml(opts.orgName)}</strong> on ${escapeHtml(APP_NAME)}.`
      ) +
        detailsPanel([
          ['Team', opts.orgName],
          ['Your role', opts.roleLabel],
        ]) +
        button(opts.inviteUrl, 'Accept the invite', brand) +
        small("The invite expires in 7 days. If you weren't expecting it, you can ignore this email.") +
        divider() +
        linkFallback(opts.inviteUrl),
      { brand: opts.brand ?? opts.orgName, preheader: `Join ${opts.orgName} as ${opts.roleLabel}.`, reason: `This invitation was sent to ${email}.` }
    ),
    text: `${opts.inviterName} has invited you to ${opts.orgName} as ${opts.roleLabel}.

Accept: ${opts.inviteUrl}

The link expires in 7 days.`,
  };
};

export interface NotificationEmailOptions {
  brand?: string | EmailBrand;
  /** Shown as the hero ticket number. */
  ticket?: { number: string; service: string };
  details?: Array<[string, string]>;
  action?: { href: string; label: string };
  /** Why the recipient got this email, in the footer. */
  reason?: string;
}

export const notificationEmail = (heading: string, message: string, opts: NotificationEmailOptions = {}): EmailContent => {
  const brand = resolveBrand(opts.brand);
  const body =
    (opts.ticket ? ticketCard(opts.ticket.number, opts.ticket.service, brand) : '') +
    formatText(message) +
    (opts.details?.length ? detailsPanel(opts.details) : '') +
    (opts.action ? button(opts.action.href, opts.action.label, brand) : '');
  const firstLine = message.trim().split('\n')[0] ?? '';
  return {
    subject: heading,
    html: emailLayout(heading, body, { brand: opts.brand, preheader: firstLine.slice(0, 140), reason: opts.reason }),
    text: [message, ...(opts.details ?? []).map(([k, v]) => `${k}: ${v}`), opts.action ? `${opts.action.label}: ${opts.action.href}` : '']
      .filter(Boolean)
      .join('\n\n'),
  };
};

// Send OTP email
export const sendOTPEmail = async (email: string): Promise<{ success: boolean; error?: string }> => {
  const code = await issueCode('EMAIL_VERIFY', email);
  return sendEmail({ to: email, ...otpEmail(email, code) });
};

export const sendPasswordResetEmail = async (email: string, resetUrl: string) =>
  sendEmail({ to: email, ...passwordResetEmail(email, resetUrl) });

export const sendNotificationEmail = async (email: string, heading: string, message: string, opts: NotificationEmailOptions = {}) =>
  sendEmail({ to: email, ...notificationEmail(heading, message, opts) });

export const sendInviteEmail = async (email: string, opts: InviteEmailOptions) =>
  sendEmail({ to: email, ...inviteEmail(email, opts) });
