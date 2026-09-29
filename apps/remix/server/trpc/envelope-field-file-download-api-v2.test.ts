import { getApiTokenByToken } from '@documenso/lib/server-only/public-api/get-api-token-by-token';
import { toFileUploadCustomText } from '@documenso/lib/types/field-file-upload';
import { getPresignGetUrl } from '@documenso/lib/universal/upload/server-actions';
import { buildTeamWhereQuery } from '@documenso/lib/utils/teams';
import { prisma } from '@documenso/prisma';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HonoEnv } from '../router';
import { openApiTrpcServerHandler } from './hono-trpc-open-api';

/**
 * DEV-12256: drives the REAL public API v2 handler (trpc-to-openapi routing,
 * query coercion, `authenticatedMiddleware` API-token resolution, the
 * route's team-scoped lookup) over HTTP. Only the DB, the API-token lookup
 * and S3 presigning are stubbed. The routes' earlier tests went through tRPC
 * directly, which skips the OpenAPI router and is how the route-order bug
 * shipped.
 */

vi.mock('@documenso/lib/server-only/public-api/get-api-token-by-token', () => ({
  getApiTokenByToken: vi.fn(),
}));

vi.mock('@documenso/lib/universal/upload/server-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@documenso/lib/universal/upload/server-actions')>()),
  getPresignGetUrl: vi.fn(),
}));

vi.mock('@documenso/prisma', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@documenso/prisma')>()),
  prisma: {
    field: { findFirst: vi.fn() },
    recipient: { findFirst: vi.fn() },
  },
}));

const API_TOKEN = 'api_test_token';
const TEAM_ID = 7;
const USER_ID = 3;
const FIELD_ID = 102;

const uploadedFile = {
  key: 'field-uploads/envelope_test/102/abc123/receipt.pdf',
  fileName: 'receipt.pdf',
  size: 1024,
  mimeType: 'application/pdf',
};

const app = new Hono<HonoEnv>();

app.use('*', async (c, next) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  c.set('context', {
    requestMetadata: { ipAddress: '127.0.0.1', userAgent: 'vitest' },
  } as HonoEnv['Variables']['context']);

  await next();
});

app.use('/api/v2/*', async (c) => openApiTrpcServerHandler(c, { isBeta: false }));

const get = async (path: string, headers: Record<string, string> = {}) =>
  await app.request(`http://localhost:3000/api/v2${path}`, { method: 'GET', headers });

const authHeaders = { Authorization: `Bearer ${API_TOKEN}` };

describe('GET /api/v2/envelope/field/get-file-download-url', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // `createTrpcContext` reads the (absent) session cookie, which needs the
    // cookie-signing secret configured even when there is no cookie.
    vi.stubEnv('NEXTAUTH_SECRET', 'vitest-secret');

    vi.mocked(getApiTokenByToken).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      {
        id: 1,
        teamId: TEAM_ID,
        team: { name: 'Test Team' },
        user: { id: USER_ID, name: 'Owner', email: 'owner@example.com', disabled: false },
      } as unknown as Awaited<ReturnType<typeof getApiTokenByToken>>,
    );

    vi.mocked(getPresignGetUrl).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      { key: uploadedFile.key, url: 'https://s3.example.com/presigned' } as Awaited<
        ReturnType<typeof getPresignGetUrl>
      >,
    );
  });

  it('mints a download URL for a team API token, with fieldId coerced from the query string', async () => {
    vi.mocked(prisma.field.findFirst).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      {
        id: FIELD_ID,
        type: 'FILE_UPLOAD',
        inserted: true,
        customText: toFileUploadCustomText(uploadedFile),
        envelope: { id: 'envelope_test', deletedAt: null },
      } as unknown as Awaited<ReturnType<typeof prisma.field.findFirst>>,
    );

    const res = await get(`/envelope/field/get-file-download-url?fieldId=${FIELD_ID}`, authHeaders);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://s3.example.com/presigned', fileName: 'receipt.pdf' });

    expect(getApiTokenByToken).toHaveBeenCalledWith({ token: API_TOKEN });
    expect(prisma.field.findFirst).toHaveBeenCalledWith({
      where: {
        id: FIELD_ID,
        envelope: { team: buildTeamWhereQuery({ teamId: TEAM_ID, userId: USER_ID }) },
      },
      include: { envelope: true },
    });
    expect(getPresignGetUrl).toHaveBeenCalledWith(
      uploadedFile.key,
      expect.objectContaining({ responseContentType: 'application/octet-stream' }),
    );
  });

  it("404s a field outside the token's team (team-scoped lookup finds nothing)", async () => {
    vi.mocked(prisma.field.findFirst).mockResolvedValue(null);

    const res = await get(`/envelope/field/get-file-download-url?fieldId=${FIELD_ID}`, authHeaders);

    expect(res.status).toBe(404);
    expect(getPresignGetUrl).not.toHaveBeenCalled();
  });

  it('401s without an API token and never touches the DB', async () => {
    const res = await get(`/envelope/field/get-file-download-url?fieldId=${FIELD_ID}`);

    expect(res.status).toBe(401);
    expect(prisma.field.findFirst).not.toHaveBeenCalled();
    expect(getPresignGetUrl).not.toHaveBeenCalled();
  });

  it('does not expose the recipient-token download route on the public API', async () => {
    const res = await get(`/envelope/field/get-file-download-url-by-token?token=recipient_token&fieldId=${FIELD_ID}`);

    expect(res.status).not.toBe(200);
    expect(prisma.recipient.findFirst).not.toHaveBeenCalled();
    expect(getPresignGetUrl).not.toHaveBeenCalled();
  });
});
