import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { createEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/create-embedding-presign-token';
import { setupI18n } from '@lingui/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-20496: the three embed update mutations only accept a presign token
// minted for the resource they update. The presign verification is the real
// one; only its database and the writes it would hand off to are stubbed, and
// the first write is a sentinel so a test can tell it got past the token.

const { apiTokenFindFirstMock, getApiTokenByTokenMock, updateEnvelopeMock, getEnvelopeWhereInputMock } = vi.hoisted(
  () => ({
    apiTokenFindFirstMock: vi.fn(),
    getApiTokenByTokenMock: vi.fn(),
    updateEnvelopeMock: vi.fn(),
    getEnvelopeWhereInputMock: vi.fn(),
  }),
);

vi.mock('@documenso/prisma', () => ({
  prisma: { apiToken: { findFirst: apiTokenFindFirstMock }, envelope: { findFirst: vi.fn() } },
}));
vi.mock('@documenso/lib/server-only/public-api/get-api-token-by-token', () => ({
  getApiTokenByToken: getApiTokenByTokenMock,
}));
vi.mock('@documenso/lib/server-only/envelope/update-envelope', () => ({ updateEnvelope: updateEnvelopeMock }));
vi.mock('@documenso/lib/server-only/envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: getEnvelopeWhereInputMock,
}));
// Compiled translation catalogs are a build artefact (same stub as
// ../on-behalf-of.test.ts).
vi.mock('@documenso/lib/client-only/providers/i18n-server', () => ({
  getI18nInstance: () => {
    const i18n = setupI18n({ locale: 'en', messages: { en: {} } });
    i18n.activate('en');

    return Promise.resolve(i18n);
  },
}));

const { createCallerFactory, router } = await import('../trpc');
const { updateEmbeddingDocumentRoute } = await import('./update-embedding-document');
const { updateEmbeddingTemplateRoute } = await import('./update-embedding-template');
const { updateEmbeddingEnvelopeRoute } = await import('./update-embedding-envelope');

const API_TOKEN = {
  id: 5,
  token: 'api_org_a_secret',
  teamId: 101,
  userId: 900,
  user: { id: 900, name: 'Reeve System', email: 'reeve-system@reeve.test' },
};

const SENTINEL = 'reached the first write';

const createCaller = createCallerFactory(
  router({
    updateDocument: updateEmbeddingDocumentRoute,
    updateTemplate: updateEmbeddingTemplateRoute,
    updateEnvelope: updateEmbeddingEnvelopeRoute,
  }),
);

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: () => logger };

const callerWith = (presignToken: string) =>
  createCaller({
    logger: logger as never,
    session: null,
    user: null,
    teamId: undefined,
    req: new Request('http://localhost/api/trpc', { headers: { authorization: `Bearer ${presignToken}` } }),
    res: new Response(),
    metadata: { requestMetadata: {}, source: 'app', auth: null },
  });

const mint = async (scope?: string) => (await createEmbeddingPresignToken({ apiToken: API_TOKEN.token, scope })).token;

const envelopeForm = (envelopeId: string) => {
  const form = new FormData();

  form.append('payload', JSON.stringify({ envelopeId, data: { envelopeItems: [], recipients: [], attachments: [] } }));

  return form;
};

type MutationCase = {
  name: string;
  scopeKey: string;
  id: number | string;
  otherId: number | string;
  call: (token: string, id: number | string) => Promise<unknown>;
  firstWrite: ReturnType<typeof vi.fn>;
};

const cases: MutationCase[] = [
  {
    name: 'updateEmbeddingDocument',
    scopeKey: 'documentId',
    id: 7,
    otherId: 8,
    call: async (token, id) =>
      await callerWith(token).updateDocument({ documentId: Number(id), title: 'NDA', recipients: [] }),
    firstWrite: updateEnvelopeMock,
  },
  {
    name: 'updateEmbeddingTemplate',
    scopeKey: 'templateId',
    id: 7,
    otherId: 8,
    call: async (token, id) =>
      await callerWith(token).updateTemplate({ templateId: Number(id), title: 'NDA', recipients: [] }),
    firstWrite: updateEnvelopeMock,
  },
  {
    name: 'updateEmbeddingEnvelope',
    scopeKey: 'envelopeId',
    id: 'envelope_org_a',
    otherId: 'envelope_org_b',
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    call: async (token, id) => await callerWith(token).updateEnvelope(envelopeForm(String(id)) as never),
    firstWrite: getEnvelopeWhereInputMock,
  },
];

const errorOf = async (promise: Promise<unknown>) => {
  const err = await promise.catch((e: unknown) => e);

  return AppError.parseError((err as { cause?: unknown }).cause ?? err);
};

describe.each(cases)('$name', (testCase) => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiTokenFindFirstMock.mockResolvedValue(API_TOKEN);
    getApiTokenByTokenMock.mockResolvedValue(API_TOKEN);
    testCase.firstWrite.mockRejectedValue(new AppError(AppErrorCode.NOT_FOUND, { message: SENTINEL }));
  });

  it('refuses an unscoped presign token before any write', async () => {
    const err = await errorOf(testCase.call(await mint(), testCase.id));

    expect(err.code).toBe(AppErrorCode.UNAUTHORIZED);
    expect(err.message).toBe('Presign token scope required');
    expect(testCase.firstWrite).not.toHaveBeenCalled();
  });

  it('refuses a token scoped to another id before any write', async () => {
    const err = await errorOf(testCase.call(await mint(`${testCase.scopeKey}:${testCase.otherId}`), testCase.id));

    expect(err.code).toBe(AppErrorCode.UNAUTHORIZED);
    expect(err.message).toBe('Presign token scope not matched');
    expect(testCase.firstWrite).not.toHaveBeenCalled();
  });

  it("accepts a token scoped to its own id and writes as the token's user and team", async () => {
    const err = await errorOf(testCase.call(await mint(`${testCase.scopeKey}:${testCase.id}`), testCase.id));

    expect(err.message).toBe(SENTINEL);
    expect(testCase.firstWrite).toHaveBeenCalledWith(
      expect.objectContaining({ userId: API_TOKEN.userId, teamId: API_TOKEN.teamId }),
    );
  });
});
