import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { PayoutError, getPayoutSettings, payoutBalance, readPayoutDetails, reviewPayout, savePayoutSettings } from '../services/payoutWallet.service';
import { decrypt } from '../lib/encryption';

/** Superadmin: payout settings and the queue of payout requests. */

const fail = (error: unknown, res: Response, next: NextFunction) =>
  error instanceof PayoutError ? res.status(error.status).json({ error: error.message }) : next(error);

export const getPayoutSettingsHandler = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getPayoutSettings());
  } catch (error) {
    next(error);
  }
};

export const updatePayoutSettingsHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await savePayoutSettings({ holdDays: req.body?.holdDays, feePercent: req.body?.feePercent, minPayout: req.body?.minPayout }));
  } catch (error) {
    fail(error, res, next);
  }
};

export const listPayoutRequests = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const rows = await prisma.payoutRequest.findMany({
      where: status ? { status } : {},
      orderBy: { requestedAt: 'desc' },
      take: 200,
      include: { organization: { select: { id: true, name: true, slug: true } } },
    });
    // Sending money to the wrong place is costly: the reviewer sees the details the organization saved with the request.
    res.json(
      await Promise.all(
        rows.map(async (r) => {
          let details = '';
          try {
            details = r.details ? decrypt(r.details) : '';
          } catch {
            /* unreadable: leave blank */
          }
          const balance = await payoutBalance(r.organizationId, r.currency);
          return {
            id: r.id,
            organization: r.organization,
            amount: Number(r.amount),
            currency: r.currency,
            status: r.status,
            details,
            note: r.note,
            requestedAt: r.requestedAt,
            reviewedAt: r.reviewedAt,
            orgBalance: balance,
          };
        })
      )
    );
  } catch (error) {
    next(error);
  }
};

export const decidePayoutRequest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const action = req.body?.action === 'REJECTED' ? 'REJECTED' : req.body?.action === 'PAID' ? 'PAID' : null;
    if (!action) return res.status(400).json({ error: 'action must be PAID or REJECTED' });
    const updated = await reviewPayout({ id: req.params.id, action, note: req.body?.note, reviewerId: req.user?.userId ?? null });
    res.json({ id: updated?.id, status: updated?.status });
  } catch (error) {
    fail(error, res, next);
  }
};

/** Money the platform holds for one organization: balance, ledger and its saved payout details. */
export const getOrganizationPayouts = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const org = await prisma.organization.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, currency: true, payoutDetails: true } });
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    const [balance, ledger] = await Promise.all([
      payoutBalance(org.id, org.currency),
      prisma.payoutLedgerEntry.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);
    res.json({ currency: org.currency, details: readPayoutDetails(org.payoutDetails), balance, ledger: ledger.map((l) => ({ ...l, amount: Number(l.amount) })) });
  } catch (error) {
    next(error);
  }
};
