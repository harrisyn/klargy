import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  whatsAppConfig: { findUnique: vi.fn() },
  platformWhatsAppConfig: { findUnique: vi.fn() },
}));
vi.mock('../../lib/prisma', () => ({ default: db }));
vi.mock('../../lib/encryption', () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));

import { loadWhatsAppConfig, providerFor } from './config';

const orgRow = (provider: string) => ({
  id: 'c1', organizationId: 'o1', provider, isEnabled: true, settings: {}, secrets: JSON.stringify({}),
  verifyToken: 'v', templates: {}, fallbackToSms: true, consentMode: 'EXPLICIT', defaultCountryCode: '233',
});

describe('shared WhatsApp number', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends with the platform account while keeping the org’s own consent settings', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(orgRow('platform'));
    db.platformWhatsAppConfig.findUnique.mockResolvedValue({
      provider: 'whatsapp_web', isEnabled: true, settings: { baseUrl: 'https://wa.example.com' }, secrets: JSON.stringify({ basicAuth: 'a:b' }),
    });
    const config = await loadWhatsAppConfig('o1');
    expect(config).toMatchObject({ provider: 'whatsapp_web', viaPlatform: true, consentMode: 'EXPLICIT', defaultCountryCode: '233', fallbackToSms: true });
    expect(providerFor(config!)?.name).toBe('whatsapp_web');
  });

  it('has no sender when the platform has switched its number off', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue(orgRow('platform'));
    db.platformWhatsAppConfig.findUnique.mockResolvedValue({ provider: 'whatsapp_web', isEnabled: false, settings: { baseUrl: 'https://wa.example.com' }, secrets: null });
    const config = await loadWhatsAppConfig('o1');
    expect(config?.viaPlatform).toBe(false);
    expect(providerFor(config!)).toBeNull();
  });

  it('leaves an org’s own account untouched', async () => {
    db.whatsAppConfig.findUnique.mockResolvedValue({ ...orgRow('whatsapp_web'), settings: { baseUrl: 'https://own.example.com' } });
    const config = await loadWhatsAppConfig('o1');
    expect(config?.viaPlatform).toBe(false);
    expect(db.platformWhatsAppConfig.findUnique).not.toHaveBeenCalled();
  });
});
