import { createEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/create-embedding-presign-token';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-20496: the three embed edit loaders only open for a presign token minted
// for that exact resource. An unscoped token (what a create flow mints) and a
// token scoped to another id are both refused before any envelope is read.
// The presign verification below is the real one; only its database and the
// envelope getters it would hand off to are stubbed.

const { apiTokenFindFirstMock, getApiTokenByTokenMock, getDocumentMock, getTemplateMock, getEnvelopeMock } = vi.hoisted(
  () => ({
    apiTokenFindFirstMock: vi.fn(),
    getApiTokenByTokenMock: vi.fn(),
    getDocumentMock: vi.fn(),
    getTemplateMock: vi.fn(),
    getEnvelopeMock: vi.fn(),
  }),
);

vi.mock('@documenso/prisma', () => ({
  prisma: {
    apiToken: { findFirst: apiTokenFindFirstMock },
    organisationEmail: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock('@documenso/lib/server-only/public-api/get-api-token-by-token', () => ({
  getApiTokenByToken: getApiTokenByTokenMock,
}));
vi.mock('@documenso/lib/server-only/document/get-document-with-details-by-id', () => ({
  getDocumentWithDetailsById: getDocumentMock,
}));
vi.mock('@documenso/lib/server-only/template/get-template-by-id', () => ({ getTemplateById: getTemplateMock }));
vi.mock('@documenso/lib/server-only/envelope/get-editor-envelope-by-id', () => ({
  getEditorEnvelopeById: getEnvelopeMock,
}));
vi.mock('@documenso/lib/server-only/team/get-team-settings', () => ({
  getTeamSettings: vi.fn(async () => ({ brandingEnabled: false })),
}));

const { loader: documentEditLoader } = await import('./v1+/authoring+/document.edit.$id');
const { loader: templateEditLoader } = await import('./v1+/authoring+/template.edit.$id');
const { loader: envelopeEditLoader } = await import('./v2+/authoring+/envelope.edit.$id');

const API_TOKEN = {
  id: 5,
  token: 'api_org_a_secret',
  teamId: 101,
  userId: 900,
  user: { id: 900, name: 'Reeve System', email: 'reeve-system@reeve.test' },
};

const mint = async (scope?: string) => (await createEmbeddingPresignToken({ apiToken: API_TOKEN.token, scope })).token;

type LoaderCase = {
  name: string;
  path: string;
  id: string;
  otherId: string;
  scopeKey: string;
  run: (url: string, id: string) => Promise<unknown>;
  getter: ReturnType<typeof vi.fn>;
};

const cases: LoaderCase[] = [
  {
    name: 'v1 document edit',
    path: '/embed/v1/authoring/document/edit',
    id: '7',
    otherId: '8',
    scopeKey: 'documentId',
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    run: async (url, id) => await documentEditLoader({ request: new Request(url), params: { id } } as never),
    getter: getDocumentMock,
  },
  {
    name: 'v1 template edit',
    path: '/embed/v1/authoring/template/edit',
    id: '7',
    otherId: '8',
    scopeKey: 'templateId',
    run: async (url, id) => await templateEditLoader({ request: new Request(url), params: { id } } as never),
    getter: getTemplateMock,
  },
  {
    name: 'v2 envelope edit',
    path: '/embed/v2/authoring/envelope/edit',
    id: 'envelope_org_a',
    otherId: 'envelope_org_b',
    scopeKey: 'envelopeId',
    run: async (url, id) => await envelopeEditLoader({ request: new Request(url), params: { id } } as never),
    getter: getEnvelopeMock,
  },
];

const urlFor = (testCase: LoaderCase, token: string) =>
  `http://localhost${testCase.path}/${testCase.id}?token=${encodeURIComponent(token)}`;

describe.each(cases)('$name loader', (testCase) => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiTokenFindFirstMock.mockResolvedValue(API_TOKEN);
    getApiTokenByTokenMock.mockResolvedValue(API_TOKEN);
    // A sentinel so a test that gets past the token can tell it did.
    testCase.getter.mockRejectedValue(new Error('reached envelope getter'));
  });

  it('refuses an unscoped presign token', async () => {
    const token = await mint();

    await expect(testCase.run(urlFor(testCase, token), testCase.id)).rejects.toThrow('Invalid token');
    expect(testCase.getter).not.toHaveBeenCalled();
  });

  it('refuses a token scoped to another id', async () => {
    const token = await mint(`${testCase.scopeKey}:${testCase.otherId}`);

    await expect(testCase.run(urlFor(testCase, token), testCase.id)).rejects.toThrow('Invalid token');
    expect(testCase.getter).not.toHaveBeenCalled();
  });

  it("opens for a token scoped to its own id, with the token's user and team", async () => {
    const token = await mint(`${testCase.scopeKey}:${testCase.id}`);

    // The getter's sentinel rejection is caught by the loader and becomes its
    // not-found redirect, which proves the token was accepted.
    await expect(testCase.run(urlFor(testCase, token), testCase.id)).rejects.toBeInstanceOf(Response);
    expect(testCase.getter).toHaveBeenCalledWith(
      expect.objectContaining({ userId: API_TOKEN.userId, teamId: API_TOKEN.teamId }),
    );
  });
});
