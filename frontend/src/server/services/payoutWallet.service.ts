import prisma from '../lib/prisma';
import { encrypt, decrypt } from '../lib/encryption';

/**
 * The payout wallet: money the platform collected on an organization's behalf
 * (booking payments made without the organization's own keys). Sales sit as
 * "pending" for a review hold, then become "available"; an organization
 * requests a payout of what is available and the superadmin pays it out.
 * Append-only ledger; see PayoutLedgerEntry.
 */

const SETTINGS_KEY = 'payouts';
const DAY_MS = 86_400_000;

export interface PayoutSettings {
  /** Days a sale stays pending before it can be paid out. */
  holdDays: number;
  /** Percent the platform keeps from each sale. */
  feePercent: number;
  /** Smallest payout an organization may request (in its currency). */
  minPayout: number;
}

export const DEFAULT_PAYOUT_SETTINGS: PayoutSettings = { holdDays: 7, feePercent: 0, minPayout: 0 };

export class PayoutError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: unknown) => (d == null ? 0 : Number(d));

export async function getPayoutSettings(): Promise<PayoutSettings> {
  const row = await prisma.platformSetting.findUnique({ where: { key: SETTINGS_KEY } });
  const v = (row?.value ?? {}) as Partial<PayoutSettings>;
  return {
    holdDays: Number.isFinite(v.holdDays) ? Math.max(0, Number(v.holdDays)) : DEFAULT_PAYOUT_SETTINGS.holdDays,
    feePercent: Number.isFinite(v.feePercent) ? Math.min(100, Math.max(0, Number(v.feePercent))) : DEFAULT_PAYOUT_SETTINGS.feePercent,
    minPayout: Number.isFinite(v.minPayout) ? Math.max(0, Number(v.minPayout)) : DEFAULT_PAYOUT_SETTINGS.minPayout,
  };
}

export async function savePayoutSettings(input: Partial<PayoutSettings>): Promise<PayoutSettings> {
  const next = { ...(await getPayoutSettings()) };
  if (input.holdDays !== undefined) next.holdDays = Math.max(0, Math.min(90, Math.floor(Number(input.holdDays))));
  if (input.feePercent !== undefined) next.feePercent = Math.min(100, Math.max(0, round2(Number(input.feePercent))));
  if (input.minPayout !== undefined) next.minPayout = Math.max(0, round2(Number(input.minPayout)));
  if (Object.values(next).some((v) => !Number.isFinite(v))) throw new PayoutError('Settings must be numbers');
  await prisma.platformSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: next as object }, update: { value: next as object } });
  return next;
}

export interface PayoutBalance {
  currency: string;
  /** Sales still inside the review hold (net of their fees and refunds). */
  pending: number;
  /** What can be paid out now. */
  available: number;
  /** Requested but not yet paid or rejected. */
  inReview: number;
  /** Already paid out. */
  paidOut: number;
}

export async function payoutBalance(organizationId: string, currency: string, now = new Date()): Promise<PayoutBalance> {
  const [avail, pend, requested, paid] = await Promise.all([
    prisma.payoutLedgerEntry.aggregate({ where: { organizationId, currency, availableAt: { lte: now } }, _sum: { amount: true } }),
    prisma.payoutLedgerEntry.aggregate({ where: { organizationId, currency, availableAt: { gt: now } }, _sum: { amount: true } }),
    prisma.payoutRequest.aggregate({ where: { organizationId, currency, status: 'REQUESTED' }, _sum: { amount: true } }),
    prisma.payoutRequest.aggregate({ where: { organizationId, currency, status: 'PAID' }, _sum: { amount: true } }),
  ]);
  return {
    currency,
    pending: round2(num(pend._sum.amount)),
    available: round2(num(avail._sum.amount)),
    inReview: round2(num(requested._sum.amount)),
    paidOut: round2(num(paid._sum.amount)),
  };
}

/** Records a payment the platform collected: the sale (pending for the hold) less the platform's fee. */
export async function recordPlatformSale(input: { organizationId: string; appointmentId: string; amount: number; currency: string; ref: string; now?: Date }) {
  const settings = await getPayoutSettings();
  const now = input.now ?? new Date();
  const availableAt = new Date(now.getTime() + settings.holdDays * DAY_MS);
  const fee = round2((input.amount * settings.feePercent) / 100);
  const base = { organizationId: input.organizationId, currency: input.currency, appointmentId: input.appointmentId, availableAt };
  await prisma.payoutLedgerEntry.createMany({
    data: [
      { ...base, amount: round2(input.amount), kind: 'SALE', reason: 'Booking payment', externalRef: `sale:${input.ref}` },
      ...(fee > 0 ? [{ ...base, amount: -fee, kind: 'FEE', reason: `Platform fee (${settings.feePercent}%)`, externalRef: `fee:${input.ref}` }] : []),
    ],
    skipDuplicates: true,
  });
}

/** Takes a refund back out of the wallet. Inside the hold it nets against the pending sale; after it, it reduces what is available. */
export async function recordPlatformRefund(input: { organizationId: string; appointmentId: string; amount: number; currency: string; ref: string; now?: Date }) {
  const now = input.now ?? new Date();
  const [sale, fee] = await Promise.all([
    prisma.payoutLedgerEntry.findFirst({ where: { appointmentId: input.appointmentId, kind: 'SALE' }, orderBy: { createdAt: 'asc' } }),
    prisma.payoutLedgerEntry.findFirst({ where: { appointmentId: input.appointmentId, kind: 'FEE' }, orderBy: { createdAt: 'asc' } }),
  ]);
  // Refunded in the hold: the entry takes the sale's own release date so pending nets down.
  const availableAt = sale && sale.availableAt > now ? sale.availableAt : now;
  const share = sale ? Math.min(1, input.amount / Number(sale.amount)) : 0;
  const feeBack = fee ? round2(Math.abs(Number(fee.amount)) * share) : 0;
  await prisma.payoutLedgerEntry.createMany({
    data: [
      { organizationId: input.organizationId, currency: input.currency, appointmentId: input.appointmentId, availableAt, amount: -round2(input.amount), kind: 'REFUND', reason: 'Booking refunded', externalRef: `refund:${input.ref}` },
      ...(feeBack > 0 ? [{ organizationId: input.organizationId, currency: input.currency, appointmentId: input.appointmentId, availableAt, amount: feeBack, kind: 'FEE', reason: 'Platform fee returned on refund', externalRef: `feeback:${input.ref}` }] : []),
    ],
    skipDuplicates: true,
  });
}

export const savePayoutDetails = (details: string) => encrypt(details.trim());
export const readPayoutDetails = (stored: string | null | undefined): string => {
  if (!stored) return '';
  try {
    return decrypt(stored);
  } catch {
    return '';
  }
};

/** An organization asks for the money it can have now. */
export async function requestPayout(input: { organizationId: string; currency: string; amount?: number; requestedBy?: string | null }) {
  const org = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { payoutDetails: true } });
  const details = readPayoutDetails(org?.payoutDetails);
  if (!details) throw new PayoutError('Add your payout details first, so we know where to send the money.');
  const settings = await getPayoutSettings();

  return prisma.$transaction(async (tx) => {
    // One request at a time per organization, so two clicks can't spend the same money.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.organizationId}))`;
    const now = new Date();
    const sum = await tx.payoutLedgerEntry.aggregate({
      where: { organizationId: input.organizationId, currency: input.currency, availableAt: { lte: now } },
      _sum: { amount: true },
    });
    const available = round2(num(sum._sum.amount));
    const amount = round2(input.amount ?? available);
    if (!(amount > 0)) throw new PayoutError('There is nothing available to pay out yet.');
    if (amount > available) throw new PayoutError('You can only request what is available.');
    if (amount < settings.minPayout) throw new PayoutError(`The smallest payout is ${settings.minPayout} ${input.currency}.`);

    const request = await tx.payoutRequest.create({
      data: { organizationId: input.organizationId, amount, currency: input.currency, details: encrypt(details), requestedBy: input.requestedBy ?? null },
    });
    await tx.payoutLedgerEntry.create({
      data: { organizationId: input.organizationId, currency: input.currency, amount: -amount, kind: 'PAYOUT', reason: 'Payout requested', payoutRequestId: request.id, availableAt: now, externalRef: `payout:${request.id}` },
    });
    return request;
  });
}

/** Superadmin's decision on a request: mark it paid (money sent) or reject it (money returns to available). */
export async function reviewPayout(input: { id: string; action: 'PAID' | 'REJECTED'; note?: string; reviewerId?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.payoutRequest.findUnique({ where: { id: input.id } });
    if (!request) throw new PayoutError('Payout request not found', 404);
    const { count } = await tx.payoutRequest.updateMany({
      where: { id: input.id, status: 'REQUESTED' },
      data: { status: input.action, note: input.note?.trim() || null, reviewedBy: input.reviewerId ?? null, reviewedAt: new Date() },
    });
    if (count === 0) throw new PayoutError(`This request is already ${request.status.toLowerCase()}`, 409);
    if (input.action === 'REJECTED') {
      await tx.payoutLedgerEntry.create({
        data: {
          organizationId: request.organizationId,
          currency: request.currency,
          amount: request.amount,
          kind: 'PAYOUT_REVERSAL',
          reason: 'Payout request rejected',
          payoutRequestId: request.id,
          availableAt: new Date(),
          externalRef: `payout-reversal:${request.id}`,
        },
      });
    }
    return tx.payoutRequest.findUnique({ where: { id: input.id } });
  });
}
