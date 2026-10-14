import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';

// Staff a Klargy Connect desk launch registered only reach Klargy through
// their EMR (docs/connect/v1.md section 6): no password sign-in, no reset.

vi.mock('../../lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    organization: { findUnique: vi.fn() },
  },
}));
vi.mock('../../utils/email', () => ({ sendOTPEmail: vi.fn(), sendPasswordResetEmail: vi.fn() }));
vi.mock('../../lib/verification', () => ({
  verifyCode: vi.fn(),
  issueToken: vi.fn().mockResolvedValue('reset-token'),
  consumeToken: vi.fn(),
  normalizeEmail: (e: string) => e.toLowerCase().trim(),
}));

import prisma from '../../lib/prisma';
import { sendPasswordResetEmail } from '../../utils/email';
import { login, forgotPassword } from '../auth.controller';
import { launchOnlyIdentity } from '../../lib/connectStaff';

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

let password: string;
const staff = (identityData: unknown) => ({
  id: 'u1', email: 'ama@example.com', password, firstName: 'Ama', lastName: 'Owusu',
  role: 'SERVICE_STAFF', organizationId: 'org1', isActive: true, identityData,
  organization: { slug: 'nyaho' },
});

beforeEach(async () => {
  vi.clearAllMocks();
  password = await bcrypt.hash('correct horse', 4);
  (prisma.organization.findUnique as any).mockResolvedValue({ id: 'org1' });
});

describe('password sign-in', () => {
  it('works for ordinary staff', async () => {
    (prisma.user.findUnique as any).mockResolvedValue(staff(null));
    const res = makeRes();
    await login({ body: { email: 'ama@example.com', password: 'correct horse', slug: 'nyaho' } } as any, res, vi.fn());
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].token).toBeTruthy();
  });

  it('is refused for staff registered by a desk launch, even with the right password', async () => {
    (prisma.user.findUnique as any).mockResolvedValue(staff(launchOnlyIdentity('int1', 'ama@example.com')));
    const res = makeRes();
    await login({ body: { email: 'ama@example.com', password: 'correct horse', slug: 'nyaho' } } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid credentials' });
  });

  it('sends no reset link to staff registered by a desk launch', async () => {
    (prisma.user.findUnique as any).mockResolvedValue(staff(launchOnlyIdentity('int1', 'ama@example.com')));
    const res = makeRes();
    await forgotPassword({ body: { email: 'ama@example.com' } } as any, res, vi.fn());
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].success).toBe(true);
  });
});
