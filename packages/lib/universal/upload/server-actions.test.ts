import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPresignPostUrlForKey } from './server-actions';

// Presigning is pure SigV4 math — no request leaves the process, so fake
// credentials and an unreachable endpoint are fine here.
describe('getPresignPostUrlForKey', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_UPLOAD_TRANSPORT', 's3');
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_ENDPOINT', 'https://account.r2.cloudflarestorage.com');
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE', 'true');
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_REGION', 'auto');
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_BUCKET', 'bucket');
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID', 'AKIDEXAMPLE');
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY', 'secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const presign = async (contentLength: number) => {
    const { url } = await getPresignPostUrlForKey('field-uploads-tmp/k/file.pdf', 'application/pdf', contentLength);

    return new URL(url).searchParams;
  };

  // The size ceiling for recipient uploads rests on this: S3, MinIO and R2
  // all reject a PUT whose Content-Length differs from a signed one
  // (403 SignatureDoesNotMatch; measured on live R2, docs/storage-provider.md).
  it('binds the declared size into the signature', async () => {
    const params = await presign(4096);

    expect(params.get('X-Amz-SignedHeaders')?.split(';')).toContain('content-length');
  });

  it('expires in at most 10 minutes, since the URL can be replayed until it expires', async () => {
    const params = await presign(4096);

    expect(Number(params.get('X-Amz-Expires'))).toBeLessThanOrEqual(600);
  });
});
