import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-12502 (C1): optional `X-Reeve-Sign-On-Behalf-Of` on the v1
// document-creating routes. A member of the token's team becomes the
// envelope owner; anyone else is a 403 with nothing created; no header keeps
// today's behaviour (the token user owns it).

const {
  getApiTokenByTokenMock,
  userFindFirstMock,
  teamFindFirstMock,
  createEnvelopeMock,
  createDocumentDataMock,
  getPresignPostUrlMock,
  setDocumentRecipientsMock,
  createDocumentFromTemplateMock,
} = vi.hoisted(() => ({
  getApiTokenByTokenMock: vi.fn(),
  userFindFirstMock: vi.fn(),
  teamFindFirstMock: vi.fn(),
  createEnvelopeMock: vi.fn(),
  createDocumentDataMock: vi.fn(),
  getPresignPostUrlMock: vi.fn(),
  setDocumentRecipientsMock: vi.fn(),
  createDocumentFromTemplateMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: { findFirst: userFindFirstMock },
    team: { findFirst: teamFindFirstMock },
    envelope: { update: vi.fn() },
  },
}));
vi.mock('@documenso/lib/server-only/public-api/get-api-token-by-token', () => ({
  getApiTokenByToken: getApiTokenByTokenMock,
}));
vi.mock('@documenso/ee/server-only/limits/server', () => ({
  getServerLimits: vi.fn(async () => ({ remaining: { documents: 100 } })),
}));
vi.mock('@documenso/lib/server-only/envelope/create-envelope', () => ({ createEnvelope: createEnvelopeMock }));
vi.mock('@documenso/lib/server-only/document-data/create-document-data', () => ({
  createDocumentData: createDocumentDataMock,
}));
vi.mock('@documenso/lib/universal/upload/server-actions', () => ({
  getPresignPostUrl: getPresignPostUrlMock,
  getPresignGetUrl: vi.fn(),
}));
vi.mock('@documenso/lib/server-only/recipient/set-document-recipients', () => ({
  setDocumentRecipients: setDocumentRecipientsMock,
}));
vi.mock('@documenso/lib/server-only/template/create-document-from-template', () => ({
  createDocumentFromTemplate: createDocumentFromTemplateMock,
}));

// Compiled translation catalogs are a build artefact; not needed here.
vi.mock('@documenso/lib/client-only/providers/i18n-server', () => ({ getI18nInstance: vi.fn() }));

const { ApiContractV1Implementation } = await import('./implementation');

const ON_BEHALF_OF = 'X-Reeve-Sign-On-Behalf-Of';
const SYSTEM_USER = { id: 999, email: 'reeve-provisioner@meetreeve.com', name: 'Reeve Provisioner', disabled: false };
const TEAM = { id: 7, name: 'MindFortress' };
const MEMBER_ID = 77;

type RouteFn = (args: unknown, ctx: { request: Request; responseHeaders: Headers }) => Promise<{ status: number }>;

const call = async (route: unknown, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
  await (route as RouteFn)(
    { headers: { authorization: 'api_org_token' }, ...args },
    {
      request: new Request('http://localhost/api/v1/documents', { method: 'POST', headers }) as never,
      responseHeaders: new Headers(),
    },
  );

const createDocument = async (headers?: Record<string, string>) =>
  await call(
    ApiContractV1Implementation.createDocument,
    { body: { title: 'NDA', recipients: [{ name: 'Signer', email: 'signer@example.com' }], meta: {} } },
    headers,
  );

const generateFromTemplate = async (headers?: Record<string, string>) =>
  await call(
    ApiContractV1Implementation.generateDocumentFromTemplate,
    { params: { templateId: '5' }, body: { recipients: [] } },
    headers,
  );

describe('v1 X-Reeve-Sign-On-Behalf-Of', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The resolver only honours orgs owned by this system user.
    vi.stubEnv('REEVE_SIGN_SYSTEM_USER_EMAIL', SYSTEM_USER.email);
    process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT = 's3';
    getApiTokenByTokenMock.mockResolvedValue({ id: 1, user: SYSTEM_USER, team: TEAM, teamId: TEAM.id });
    getPresignPostUrlMock.mockResolvedValue({ url: 'https://s3/upload', key: 'key' });
    createDocumentDataMock.mockResolvedValue({ id: 'data_1' });
    createEnvelopeMock.mockResolvedValue({ id: 'envelope_1', secondaryId: 'document_42' });
    setDocumentRecipientsMock.mockResolvedValue({ recipients: [] });
    createDocumentFromTemplateMock.mockResolvedValue({ id: 'envelope_2', secondaryId: 'document_43', recipients: [] });
  });

  const asMember = () => {
    userFindFirstMock.mockResolvedValue({ id: MEMBER_ID });
    teamFindFirstMock.mockResolvedValue({ id: TEAM.id });
  };

  const asNonMember = () => {
    userFindFirstMock.mockResolvedValue({ id: 88 });
    teamFindFirstMock.mockResolvedValue(null);
  };

  describe('POST /api/v1/documents', () => {
    it('member -> the envelope is owned by that member, in the token team', async () => {
      asMember();

      const response = await createDocument({ [ON_BEHALF_OF]: 'matt@mindfortress.com' });

      expect(response.status).toBe(200);
      expect(createEnvelopeMock).toHaveBeenCalledWith(expect.objectContaining({ userId: MEMBER_ID, teamId: TEAM.id }));
    });

    it('non-member -> 403 and nothing is created', async () => {
      asNonMember();

      const response = await createDocument({ [ON_BEHALF_OF]: 'other-org@example.com' });

      expect(response.status).toBe(403);
      expect(getPresignPostUrlMock).not.toHaveBeenCalled();
      expect(createDocumentDataMock).not.toHaveBeenCalled();
      expect(createEnvelopeMock).not.toHaveBeenCalled();
    });

    it('resolver DB error -> declared 500 and nothing is created', async () => {
      userFindFirstMock.mockRejectedValue(new Error('db down'));

      const response = await createDocument({ [ON_BEHALF_OF]: 'matt@mindfortress.com' });

      expect(response.status).toBe(500);
      expect(createEnvelopeMock).not.toHaveBeenCalled();
    });

    it('header absent -> unchanged: the token user owns the envelope', async () => {
      const response = await createDocument();

      expect(response.status).toBe(200);
      expect(userFindFirstMock).not.toHaveBeenCalled();
      expect(createEnvelopeMock).toHaveBeenCalledWith(expect.objectContaining({ userId: SYSTEM_USER.id }));
    });
  });

  describe('POST /api/v1/templates/:templateId/generate-document', () => {
    it('member -> the generated envelope is owned by that member', async () => {
      asMember();

      const response = await generateFromTemplate({ [ON_BEHALF_OF]: 'matt@mindfortress.com' });

      expect(response.status).toBe(200);
      expect(createDocumentFromTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: MEMBER_ID, teamId: TEAM.id }),
      );
    });

    it('non-member -> 403 and nothing is created', async () => {
      asNonMember();

      const response = await generateFromTemplate({ [ON_BEHALF_OF]: 'other-org@example.com' });

      expect(response.status).toBe(403);
      expect(createDocumentFromTemplateMock).not.toHaveBeenCalled();
    });

    it('resolver DB error -> declared 500 and nothing is created', async () => {
      userFindFirstMock.mockRejectedValue(new Error('db down'));

      const response = await generateFromTemplate({ [ON_BEHALF_OF]: 'matt@mindfortress.com' });

      expect(response.status).toBe(500);
      expect(createDocumentFromTemplateMock).not.toHaveBeenCalled();
    });

    it('header absent -> unchanged', async () => {
      const response = await generateFromTemplate();

      expect(response.status).toBe(200);
      expect(createDocumentFromTemplateMock).toHaveBeenCalledWith(expect.objectContaining({ userId: SYSTEM_USER.id }));
    });
  });
});
