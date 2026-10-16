import { describe, it, expect, vi } from 'vitest';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(), createTestAccount: vi.fn(async () => { throw new Error('offline'); }) } }));
vi.mock('../lib/verification', () => ({ issueCode: vi.fn() }));
vi.mock('../config/appConfig', () => ({
  APP_NAME: 'Klargy',
  DEFAULT_APP_NAME: 'Klargy',
  buildAppUrl: (path: string) => new URL(path, 'https://klargy.example.com').toString(),
}));

import { inviteEmail, notificationEmail, otpEmail, passwordResetEmail } from './email';

describe('email templates', () => {
  it('puts the Klargy wordmark on product emails only', () => {
    expect(otpEmail('a@b.co', '123456').html).toContain('/brand/klargy-logo-email.png');
    const org = notificationEmail('Now serving C014', 'Your turn.', { brand: { name: 'Nyaho Medical Centre' } }).html;
    expect(org).not.toContain('klargy-logo-email.png');
    expect(org).toContain('Nyaho Medical Centre');
    expect(org).toContain('Powered by');
  });

  it("uses an organisation's logo and colour, and honours hiding Powered by", () => {
    const { html } = notificationEmail('Hi', 'Body', {
      brand: { name: 'Acme', logoUrl: 'https://cdn.example.com/acme.png', primaryColor: '#ffd400', hidePoweredBy: true },
      action: { href: 'https://acme.example.com/status/1', label: 'Track your place' },
    });
    expect(html).toContain('src="https://cdn.example.com/acme.png"');
    expect(html).toContain('background-color:#ffd400');
    // A light brand colour gets dark button text.
    expect(html).toMatch(/color:#0d2a47;text-decoration:none/);
    expect(html).not.toContain('Powered by');
  });

  it('ignores an invalid colour or logo URL rather than injecting it', () => {
    const { html } = notificationEmail('Hi', 'Body', {
      brand: { name: 'Acme', logoUrl: 'javascript:alert(1)', primaryColor: 'red;background:url(x)' },
    });
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('url(x)');
  });

  it('escapes names and messages', () => {
    const { html, subject } = inviteEmail('a@b.co', {
      inviteUrl: 'https://x.example.com/register?invite=1&a=2',
      orgName: '<Clinic>',
      inviterName: 'Ama "A" Owusu',
      roleLabel: 'Staff',
    });
    expect(subject).toBe('Ama "A" Owusu invited you to <Clinic>');
    expect(html).not.toContain('<Clinic>');
    expect(html).toContain('&lt;Clinic&gt;');
    expect(html).toContain('invite=1&amp;a=2');
    expect(notificationEmail('x', '<script>alert(1)</script>').html).not.toContain('<script>');
  });

  it('formats digest text into paragraphs and lists, and keeps the link in the plain text', () => {
    const { html, text } = notificationEmail('Digest', 'Busy day.\n\n- **142** served\n- Lab was slowest', {
      action: { href: 'https://klargy.example.com/analytics', label: 'Open analytics' },
    });
    expect(html).toContain('<li');
    expect(html).toContain('<strong');
    expect(text).toContain('Open analytics: https://klargy.example.com/analytics');
  });

  it('keeps the code and link in plain-text versions', () => {
    expect(otpEmail('a@b.co', '482913').text).toContain('482913');
    expect(passwordResetEmail('a@b.co', 'https://k.example.com/r?t=1').text).toContain('https://k.example.com/r?t=1');
  });
});
