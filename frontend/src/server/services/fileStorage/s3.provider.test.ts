import { describe, it, expect, vi, afterEach } from 'vitest';
import { S3Provider, parseS3Settings, signS3Request } from './s3.provider';

const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('signS3Request', () => {
  it('matches the AWS documented GET Object example', () => {
    const headers = signS3Request({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      headers: { Range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    );
  });
});

describe('parseS3Settings', () => {
  it('defaults MinIO-style endpoints to path style and a region', () => {
    const { settings } = parseS3Settings({ endpoint: 'https://minio.example.com', bucket: 'klargy', publicBaseUrl: 'https://cdn.example.com' });
    expect(settings).toMatchObject({ region: 'us-east-1', pathStyle: true, bucket: 'klargy' });
  });
  it('requires a public URL and a region for AWS', () => {
    expect(parseS3Settings({ bucket: 'my-bucket', publicBaseUrl: 'https://x.example' }).error).toMatch(/region/);
    expect(parseS3Settings({ region: 'eu-west-1', bucket: 'my-bucket' }).error).toMatch(/public URL/);
  });
});

describe('S3Provider', () => {
  afterEach(() => vi.restoreAllMocks());
  const settings = { endpoint: 'https://minio.example.com', region: 'us-east-1', bucket: 'klargy', publicBaseUrl: 'https://cdn.example.com/klargy/', pathStyle: true, prefix: 'logos' };

  it('uploads with a signed PUT and returns a public URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    const out = await new S3Provider('AK', 'SK', settings).uploadFile(Buffer.from('hi'), 'My Logo.png', 'image/png');
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toMatch(/^https:\/\/minio\.example\.com\/klargy\/logos\/[0-9a-f-]+-My_Logo\.png$/);
    expect((init.headers as Record<string, string>).Authorization).toContain('Credential=AK/');
    expect(out.url).toBe(`https://cdn.example.com/klargy/${out.fileId.split('/').map(encodeURIComponent).join('/')}`);
  });

  it('treats a missing object as already deleted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    await expect(new S3Provider('AK', 'SK', settings).deleteFile('logos/x.png')).resolves.toBeUndefined();
  });

  it('reports a rejected test write', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
    const r = await new S3Provider('AK', 'SK', settings).check();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('403');
  });
});
