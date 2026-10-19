import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { encrypt, decrypt, mask } from '../lib/encryption';
import { getFileStorageProvider, FileStorageProviderNotActiveError } from '../services/fileStorage';
import { FileStorageProviderName } from '../services/fileStorage/types';
import { S3Provider, parseS3Settings } from '../services/fileStorage/s3.provider';

const VALID_PROVIDERS: FileStorageProviderName[] = ['uploadcare', 's3'];

type Row = NonNullable<Awaited<ReturnType<typeof prisma.fileStorageProviderConfig.findUnique>>>;

const view = (provider: string, c: Row | null | undefined) =>
  c
    ? {
        provider,
        configured: true,
        isActive: c.isActive,
        publicKey: c.publicKey,
        secretKeyMasked: mask(decrypt(c.secretKey)),
        settings: c.settings ?? {},
        updatedAt: c.updatedAt,
      }
    : { provider, configured: false, isActive: false, publicKey: null, secretKeyMasked: null, settings: {}, updatedAt: null };

export const listFileStorageProviders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const configs = await prisma.fileStorageProviderConfig.findMany();
    const byProvider = new Map(configs.map(c => [c.provider, c]));
    res.json(VALID_PROVIDERS.map(provider => view(provider, byProvider.get(provider))));
  } catch (error) {
    next(error);
  }
};

export const upsertFileStorageProvider = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { provider } = req.params;
    if (!VALID_PROVIDERS.includes(provider as FileStorageProviderName)) {
      return res.status(400).json({ error: 'Unknown provider' });
    }

    const { publicKey, secretKey, isActive } = req.body;
    const existing = await prisma.fileStorageProviderConfig.findUnique({ where: { provider } });
    if (!secretKey && !existing) {
      return res.status(400).json({ error: provider === 's3' ? 'Enter the secret access key.' : 'secretKey is required' });
    }

    let settings: Record<string, unknown> = {};
    if (provider === 's3') {
      if (!String(publicKey || '').trim()) return res.status(400).json({ error: 'Enter the access key ID.' });
      const parsed = parseS3Settings(req.body.settings);
      if (!parsed.settings) return res.status(400).json({ error: parsed.error });
      settings = { ...parsed.settings };
    }

    const data = {
      publicKey: String(publicKey || '').trim() || null,
      isActive: Boolean(isActive),
      settings: settings as object,
      // Blank keeps the saved secret.
      ...(secretKey ? { secretKey: encrypt(String(secretKey).trim()) } : {}),
    };
    const config = await prisma.$transaction(async (tx) => {
      // Uploads go to one place at a time.
      if (data.isActive) await tx.fileStorageProviderConfig.updateMany({ where: { provider: { not: provider } }, data: { isActive: false } });
      return tx.fileStorageProviderConfig.upsert({
        where: { provider },
        create: { provider, ...data, secretKey: data.secretKey ?? encrypt(String(secretKey)) },
        update: data,
      });
    });

    res.json(view(provider, config));
  } catch (error) {
    next(error);
  }
};

export const testFileStorageProvider = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { provider } = req.params;
    if (!VALID_PROVIDERS.includes(provider as FileStorageProviderName)) {
      return res.status(400).json({ error: 'Unknown provider' });
    }

    try {
      if (provider === 's3') {
        // Tests the saved settings even while the provider is switched off.
        const config = await prisma.fileStorageProviderConfig.findUnique({ where: { provider } });
        if (!config) return res.status(400).json({ ok: false, error: 'Save the settings first.' });
        const { settings, error } = parseS3Settings(config.settings);
        if (!settings) return res.status(400).json({ ok: false, error });
        const result = await new S3Provider(config.publicKey || '', decrypt(config.secretKey), settings).check();
        return res.status(result.ok ? 200 : 400).json(result.ok ? { ok: true, message: result.message } : { ok: false, error: result.message });
      }
      // Constructing the provider (which decrypts the key) is enough to catch a
      // missing/malformed config immediately. A full API round-trip is deferred
      // to real usage, same tradeoff as testPaymentProvider.
      await getFileStorageProvider(provider as FileStorageProviderName);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof FileStorageProviderNotActiveError) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      return res.status(400).json({ ok: false, error: 'Provider key validation failed' });
    }
  } catch (error) {
    next(error);
  }
};
