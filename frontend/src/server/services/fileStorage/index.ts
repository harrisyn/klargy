import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import { FileStorageProvider, FileStorageProviderName, FileStorageProviderNotActiveError } from './types';
import { UploadcareProvider } from './uploadcare.provider';
import { S3Provider, parseS3Settings } from './s3.provider';

export * from './types';

export async function getFileStorageProvider(name: FileStorageProviderName): Promise<FileStorageProvider> {
  const config = await prisma.fileStorageProviderConfig.findUnique({ where: { provider: name } });
  if (!config || !config.isActive) {
    throw new FileStorageProviderNotActiveError(name);
  }

  const secretKey = decrypt(config.secretKey);

  switch (name) {
    case 'uploadcare':
      return new UploadcareProvider(config.publicKey || '', secretKey);
    case 's3': {
      const { settings } = parseS3Settings(config.settings);
      if (!settings) throw new FileStorageProviderNotActiveError(name);
      return new S3Provider(config.publicKey || '', secretKey, settings);
    }
    default:
      throw new FileStorageProviderNotActiveError(name);
  }
}

export async function getActiveFileStorageProvider(): Promise<FileStorageProvider | null> {
  const config = await prisma.fileStorageProviderConfig.findFirst({ where: { isActive: true } });
  if (!config) return null;
  return getFileStorageProvider(config.provider as FileStorageProviderName);
}
