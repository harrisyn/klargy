export type FileStorageProviderName = 'uploadcare' | 's3';

export interface UploadedFile {
  fileId: string;
  url: string;
}

export interface FileStorageProvider {
  name: FileStorageProviderName;
  uploadFile(buffer: Buffer, filename: string, mimeType: string): Promise<UploadedFile>;
  deleteFile(fileId: string): Promise<void>;
  /** For files the browser uploaded directly: check it exists and keep it. */
  confirmDirectUpload?(fileId: string): Promise<{ url: string; mimeType: string | null; size: number | null }>;
  /** What the browser needs to upload directly, if the provider supports it. */
  directUploadConfig?(): { provider: FileStorageProviderName; publicKey: string } | null;
}

export class FileStorageProviderNotActiveError extends Error {
  constructor(provider: string) {
    super(`File storage provider "${provider}" is not configured or not active`);
    this.name = 'FileStorageProviderNotActiveError';
  }
}
