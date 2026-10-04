import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT } from '@documenso/lib/constants/app';
import { verifyEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/verify-embedding-presign-token';
import { putNormalizedPdfFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import { getPresignPostUrl } from '@documenso/lib/universal/upload/server-actions';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HonoEnv } from '../../router';
import { filesRoute } from './files';

/**
 * DEV-12801: `/api/files/presigned-post-url` and `/api/files/upload-pdf` are
 * write paths into the prod bucket. Both used to run with no auth at all
 * (only a per-IP rate limit), so an anonymous caller could mint 1h, unbounded
 * presigned PUTs or create DocumentData rows. Drives the real Hono route; only
 * the session lookup, the embed-token check and the storage writes are stubbed.
 */

// Same i18n-server mock as the other server tests: the import graph can reach
// it, and CI never compiles the lingui catalogs it eagerly imports.
vi.mock('@documenso/lib/client-only/providers/i18n-server', () => ({
  loadCatalog: vi.fn(async (lang: string) => ({ [lang]: {} })),
  allI18nInstances: Promise.resolve({}),
  getI18nInstance: vi.fn(async () => ({ _: (message: unknown) => message })),
}));

vi.mock('@documenso/auth/server/lib/utils/get-session', () => ({
  getOptionalSession: vi.fn(),
}));

vi.mock('@documenso/lib/server-only/embedding-presign/verify-embedding-presign-token', () => ({
  verifyEmbeddingPresignToken: vi.fn(),
}));

vi.mock('@documenso/lib/universal/upload/server-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@documenso/lib/universal/upload/server-actions')>()),
  getPresignPostUrl: vi.fn(),
}));

vi.mock('@documenso/lib/universal/upload/put-file.server', () => ({
  putNormalizedPdfFileServerSide: vi.fn(),
}));

const USER_ID = 42;
const MAX_BYTES = APP_DOCUMENT_UPLOAD_SIZE_LIMIT * 1024 * 1024;

const app = new Hono<HonoEnv>().route('/api/files', filesRoute);

const signedIn = () =>
  vi.mocked(getOptionalSession).mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    { isAuthenticated: true, session: {}, user: { id: USER_ID } } as unknown as Awaited<
      ReturnType<typeof getOptionalSession>
    >,
  );

const presign = async (body: unknown, headers: Record<string, string> = {}) =>
  await app.request('http://localhost/api/files/presigned-post-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const uploadPdf = async (headers: Record<string, string> = {}) => {
  const form = new FormData();
  form.append('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'doc.pdf', { type: 'application/pdf' }));

  return await app.request('http://localhost/api/files/upload-pdf', { method: 'POST', headers, body: form });
};

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(getOptionalSession).mockResolvedValue({ isAuthenticated: false, session: null, user: null });
  vi.mocked(verifyEmbeddingPresignToken).mockRejectedValue(new Error('invalid token'));
  vi.mocked(getPresignPostUrl).mockResolvedValue({ key: '42/abc/doc.pdf', url: 'https://r2.example/put' });
  vi.mocked(putNormalizedPdfFileServerSide).mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    { id: 'dd_1', type: 'S3_PATH' } as unknown as Awaited<ReturnType<typeof putNormalizedPdfFileServerSide>>,
  );
});

describe('POST /api/files/presigned-post-url', () => {
  it('rejects an unauthenticated caller with 401 and mints nothing', async () => {
    const res = await presign({ fileName: 'doc.pdf', contentType: 'application/pdf', fileSize: 1024 });

    expect(res.status).toBe(401);
    expect(getPresignPostUrl).not.toHaveBeenCalled();
  });

  it('returns 401 (not a validation 400) for an unauthenticated empty body', async () => {
    const res = await presign({});

    expect(res.status).toBe(401);
  });

  it('does not accept an embedding presign token (no embed caller uses this route)', async () => {
    vi.mocked(verifyEmbeddingPresignToken).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      { userId: USER_ID } as unknown as Awaited<ReturnType<typeof verifyEmbeddingPresignToken>>,
    );

    const res = await presign(
      { fileName: 'doc.pdf', contentType: 'application/pdf', fileSize: 1024 },
      { Authorization: 'Bearer presign_ok' },
    );

    expect(res.status).toBe(401);
    expect(getPresignPostUrl).not.toHaveBeenCalled();
  });

  it('requires fileSize', async () => {
    signedIn();

    const res = await presign({ fileName: 'doc.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(getPresignPostUrl).not.toHaveBeenCalled();
  });

  it('rejects a fileSize over the upload limit', async () => {
    signedIn();

    const res = await presign({ fileName: 'doc.pdf', contentType: 'application/pdf', fileSize: MAX_BYTES + 1 });

    expect(res.status).toBe(400);
    expect(getPresignPostUrl).not.toHaveBeenCalled();
  });

  it('mints a URL bound to the declared size and scoped to the session user', async () => {
    signedIn();

    const res = await presign({ fileName: 'logo.png', contentType: 'image/png', fileSize: 2048 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: '42/abc/doc.pdf', url: 'https://r2.example/put' });
    expect(getPresignPostUrl).toHaveBeenCalledWith('logo.png', 'image/png', USER_ID, 2048);
  });
});

describe('POST /api/files/upload-pdf', () => {
  it('rejects an unauthenticated caller with 401 and stores nothing', async () => {
    const res = await uploadPdf();

    expect(res.status).toBe(401);
    expect(putNormalizedPdfFileServerSide).not.toHaveBeenCalled();
  });

  it('rejects an invalid embedding presign token with 401', async () => {
    const res = await uploadPdf({ Authorization: 'Bearer presign_bad' });

    expect(res.status).toBe(401);
    expect(verifyEmbeddingPresignToken).toHaveBeenCalledWith({ token: 'presign_bad' });
    expect(putNormalizedPdfFileServerSide).not.toHaveBeenCalled();
  });

  it('accepts a session user', async () => {
    signedIn();

    const res = await uploadPdf();

    expect(res.status).toBe(200);
    expect(putNormalizedPdfFileServerSide).toHaveBeenCalledTimes(1);
  });

  it('accepts a valid embedding presign token (sign-embed V1 authoring iframe has no session)', async () => {
    vi.mocked(verifyEmbeddingPresignToken).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      { userId: USER_ID } as unknown as Awaited<ReturnType<typeof verifyEmbeddingPresignToken>>,
    );

    const res = await uploadPdf({ Authorization: 'Bearer presign_ok' });

    expect(res.status).toBe(200);
    expect(verifyEmbeddingPresignToken).toHaveBeenCalledWith({ token: 'presign_ok' });
    expect(putNormalizedPdfFileServerSide).toHaveBeenCalledTimes(1);
  });
});
