import crypto from 'crypto';
import { FileStorageProvider, UploadedFile } from './types';

// S3 and S3-compatible storage (AWS S3, MinIO, Cloudflare R2, DigitalOcean
// Spaces, Backblaze B2, Wasabi...). Requests are signed with AWS Signature
// Version 4 here rather than pulling in the AWS SDK for two calls.

export interface S3Settings {
  /** Blank for AWS S3. Otherwise the service endpoint, e.g. https://minio.example.com */
  endpoint?: string;
  region: string;
  bucket: string;
  /** Where browsers read files from: the bucket's public URL or a CDN in front of it. */
  publicBaseUrl: string;
  /** /bucket/key addressing. Needed for MinIO and most self-hosted servers. */
  pathStyle?: boolean;
  /** Folder inside the bucket, e.g. "klargy". */
  prefix?: string;
}

const sha256 = (data: crypto.BinaryLike) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding of one path segment, as AWS requires. */
const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (key: string) => key.split('/').map(encodeSegment).join('/');

export interface SignInput {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Headers to sign besides host / x-amz-date / x-amz-content-sha256. */
  headers?: Record<string, string>;
  payloadHash: string;
  now?: Date;
}

/** Returns the headers (including Authorization) to send. */
export function signS3Request(input: SignInput): Record<string, string> {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers || {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: input.url.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encodeSegment(k), encodeSegment(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [input.method, input.url.pathname, query, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, 's3');
  const signingKey = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const { host: _host, ...sendable } = headers;
  return {
    ...sendable,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class S3Provider implements FileStorageProvider {
  name = 's3' as const;

  constructor(private accessKeyId: string, private secretAccessKey: string, private settings: S3Settings) {}

  private objectKey(filename: string) {
    const prefix = (this.settings.prefix || '').replace(/^\/+|\/+$/g, '');
    const safe = filename.replace(/[^\w.\-]+/g, '_').slice(-120) || 'file';
    return `${prefix ? `${prefix}/` : ''}${crypto.randomUUID()}-${safe}`;
  }

  /** The request URL for an object (or the bucket itself when key is empty). */
  private requestUrl(key: string): URL {
    const { endpoint, bucket, region } = this.settings;
    const path = key ? `/${encodePath(key)}` : '/';
    if (!endpoint) {
      // AWS: virtual-hosted style unless path style is forced.
      return this.settings.pathStyle
        ? new URL(`https://s3.${region}.amazonaws.com/${bucket}${path === '/' ? '' : path}`)
        : new URL(`https://${bucket}.s3.${region}.amazonaws.com${path}`);
    }
    const base = endpoint.replace(/\/+$/, '');
    if (this.settings.pathStyle === false) {
      const u = new URL(base);
      return new URL(`${u.protocol}//${bucket}.${u.host}${path}`);
    }
    return new URL(`${base}/${bucket}${path === '/' ? '' : path}`);
  }

  publicUrl(key: string) {
    return `${this.settings.publicBaseUrl.replace(/\/+$/, '')}/${encodePath(key)}`;
  }

  private async send(method: string, key: string, body?: Buffer, contentType?: string) {
    const url = this.requestUrl(key);
    const payload = body ?? Buffer.alloc(0);
    const headers = signS3Request({
      method,
      url,
      region: this.settings.region,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      headers: contentType ? { 'content-type': contentType } : {},
      payloadHash: sha256(payload),
    });
    return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(30_000) });
  }

  async uploadFile(buffer: Buffer, filename: string, mimeType: string): Promise<UploadedFile> {
    const key = this.objectKey(filename);
    const res = await this.send('PUT', key, buffer, mimeType || 'application/octet-stream');
    if (!res.ok) throw new Error(`S3 upload failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return { fileId: key, url: this.publicUrl(key) };
  }

  async deleteFile(fileId: string): Promise<void> {
    const res = await this.send('DELETE', fileId);
    if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  /** Writes and removes a small object: proves the keys, bucket and permissions work. */
  async check(): Promise<{ ok: boolean; message: string }> {
    const key = `${this.objectKey('klargy-connection-test.txt')}`;
    try {
      const put = await this.send('PUT', key, Buffer.from('ok'), 'text/plain');
      if (!put.ok) return { ok: false, message: `The storage service said ${put.status}: ${(await put.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}` };
      await this.send('DELETE', key).catch(() => undefined);
      return { ok: true, message: `Wrote and removed a test file in “${this.settings.bucket}”.` };
    } catch (err) {
      return { ok: false, message: `Couldn’t reach the storage service: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

/** Reads and validates the stored settings, returning an error message when incomplete. */
export function parseS3Settings(raw: unknown): { settings?: S3Settings; error?: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const str = (k: string) => String(r[k] ?? '').trim();
  const endpoint = str('endpoint');
  const region = str('region') || (endpoint ? 'us-east-1' : '');
  const bucket = str('bucket');
  const publicBaseUrl = str('publicBaseUrl');
  if (!region) return { error: 'Enter the region (for AWS, e.g. eu-west-1).' };
  if (!bucket || !/^[a-z0-9][a-z0-9.\-_]{1,62}$/i.test(bucket)) return { error: 'Enter the bucket name.' };
  if (endpoint && !/^https?:\/\/[^\s/]+/i.test(endpoint)) return { error: 'The endpoint must start with http:// or https://.' };
  if (!/^https?:\/\/[^\s/]+/i.test(publicBaseUrl)) return { error: 'Enter the public URL files are served from (the bucket URL or a CDN).' };
  const pathStyleRaw = r.pathStyle;
  const pathStyle = pathStyleRaw === undefined || pathStyleRaw === '' ? Boolean(endpoint) : pathStyleRaw === true || pathStyleRaw === 'true';
  return { settings: { endpoint: endpoint || undefined, region, bucket, publicBaseUrl, pathStyle, prefix: str('prefix') || undefined } };
}
