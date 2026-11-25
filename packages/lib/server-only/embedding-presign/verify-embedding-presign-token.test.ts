import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { createEmbeddingPresignToken } from './create-embedding-presign-token';
import { verifyEmbeddingPresignToken } from './verify-embedding-presign-token';

// DEV-20496: edit loaders and embed update mutations pass `requireScope`, so a
// presign token minted without a scope no longer opens them. Create flows do
// not pass it and keep accepting unscoped tokens.

const { apiTokenFindFirstMock, getApiTokenByTokenMock } = vi.hoisted(() => ({
  apiTokenFindFirstMock: vi.fn(),
  getApiTokenByTokenMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: { apiToken: { findFirst: apiTokenFindFirstMock } } }));
vi.mock('../public-api/get-api-token-by-token', () => ({ getApiTokenByToken: getApiTokenByTokenMock }));

const API_TOKEN = {
  id: 5,
  token: 'api_secret_for_signing',
  teamId: 101,
  userId: 900,
  user: { id: 900, name: 'Reeve System', email: 'reeve-system@reeve.test' },
};

const mint = async (scope?: string) => (await createEmbeddingPresignToken({ apiToken: API_TOKEN.token, scope })).token;

const expectUnauthorized = async (promise: Promise<unknown>, message: string) => {
  const err = await promise.catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(AppErrorCode.UNAUTHORIZED);
  expect((err as AppError).message).toBe(message);
};

describe('verifyEmbeddingPresignToken scope enforcement', () => {
  beforeEach(() => {
    apiTokenFindFirstMock.mockReset();
    apiTokenFindFirstMock.mockResolvedValue(API_TOKEN);
    getApiTokenByTokenMock.mockReset();
    getApiTokenByTokenMock.mockResolvedValue(API_TOKEN);
  });

  it('refuses an unscoped token when the scope is required', async () => {
    const token = await mint();

    await expectUnauthorized(
      verifyEmbeddingPresignToken({ token, scope: 'documentId:7', requireScope: true }),
      'Presign token scope required',
    );
  });

  it('accepts a token scoped to its own id when the scope is required', async () => {
    const token = await mint('documentId:7');

    const result = await verifyEmbeddingPresignToken({ token, scope: 'documentId:7', requireScope: true });

    expect(result.userId).toBe(API_TOKEN.userId);
    expect(result.teamId).toBe(API_TOKEN.teamId);
  });

  it('refuses a token scoped to another id', async () => {
    const token = await mint('documentId:8');

    await expectUnauthorized(
      verifyEmbeddingPresignToken({ token, scope: 'documentId:7', requireScope: true }),
      'Presign token scope not matched',
    );
  });

  it('fails closed when a caller requires a scope but passes none', async () => {
    const token = await mint('documentId:7');

    await expectUnauthorized(
      verifyEmbeddingPresignToken({ token, requireScope: true }),
      'Presign token scope required',
    );
  });

  it('keeps accepting an unscoped token where the scope is not required (create flows)', async () => {
    const token = await mint();

    await expect(verifyEmbeddingPresignToken({ token })).resolves.toMatchObject({ userId: API_TOKEN.userId });
    await expect(verifyEmbeddingPresignToken({ token, scope: 'documentId:7' })).resolves.toMatchObject({
      userId: API_TOKEN.userId,
    });
  });

  it('still verifies the signature of a scoped token', async () => {
    const token = await mint('documentId:7');

    apiTokenFindFirstMock.mockResolvedValue({ ...API_TOKEN, token: 'api_a_different_secret' });

    await expectUnauthorized(
      verifyEmbeddingPresignToken({ token, scope: 'documentId:7', requireScope: true }),
      'Failed to verify presign token',
    );
  });
});
