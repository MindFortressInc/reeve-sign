import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ZCreateDocumentMutationSchema } from './schema';

// DEV-15771: POST /api/v1/documents forced `Etc/UTC` and the default date
// format whenever the body omitted them. `meta.timezone` beats the team/org
// setting in createEnvelope, so every API-created document stamped its DATE
// fields in UTC. An omitted value must now reach createEnvelope as undefined.

const { createEnvelopeMock, getApiTokenByTokenMock } = vi.hoisted(() => ({
  createEnvelopeMock: vi.fn(),
  getApiTokenByTokenMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: { envelope: { update: vi.fn() } } }));
vi.mock('@documenso/lib/server-only/public-api/get-api-token-by-token', () => ({
  getApiTokenByToken: getApiTokenByTokenMock,
}));
vi.mock('@documenso/ee/server-only/limits/server', () => ({
  getServerLimits: vi.fn(async () => ({ remaining: { documents: 100 } })),
}));
vi.mock('@documenso/lib/server-only/envelope/create-envelope', () => ({ createEnvelope: createEnvelopeMock }));
vi.mock('@documenso/lib/server-only/document-data/create-document-data', () => ({
  createDocumentData: vi.fn(async () => ({ id: 'data_1' })),
}));
vi.mock('@documenso/lib/universal/upload/server-actions', () => ({
  getPresignPostUrl: vi.fn(async () => ({ url: 'https://s3/upload', key: 'key' })),
  getPresignGetUrl: vi.fn(),
}));
vi.mock('@documenso/lib/server-only/recipient/set-document-recipients', () => ({
  setDocumentRecipients: vi.fn(async () => ({ recipients: [] })),
}));
vi.mock('@documenso/lib/client-only/providers/i18n-server', () => ({ getI18nInstance: vi.fn() }));

const { ApiContractV1Implementation } = await import('./implementation');

type RouteFn = (args: unknown, ctx: { request: Request; responseHeaders: Headers }) => Promise<{ status: number }>;

const createDocument = async (meta: Record<string, unknown>) =>
  await (ApiContractV1Implementation.createDocument as unknown as RouteFn)(
    {
      headers: { authorization: 'api_org_token' },
      // Parsed exactly as ts-rest would before the handler sees it.
      body: ZCreateDocumentMutationSchema.parse({
        title: 'Court form',
        recipients: [{ name: 'Signer', email: 'signer@example.com' }],
        meta,
      }),
    },
    { request: new Request('http://localhost/api/v1/documents', { method: 'POST' }), responseHeaders: new Headers() },
  );

const passedMeta = () => createEnvelopeMock.mock.calls[0][0].meta;

describe('POST /api/v1/documents meta.timezone / meta.dateFormat (DEV-15771)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT = 's3';
    getApiTokenByTokenMock.mockResolvedValue({
      id: 1,
      user: { id: 9, email: 'api@example.com', name: 'API', disabled: false },
      team: { id: 7, name: 'Team' },
      teamId: 7,
    });
    createEnvelopeMock.mockResolvedValue({ id: 'envelope_1', secondaryId: 'document_44' });
  });

  it('omitted -> undefined, so the team/org setting (else UTC) applies downstream', async () => {
    const response = await createDocument({});

    expect(response.status).toBe(200);
    expect(passedMeta().timezone).toBeUndefined();
    expect(passedMeta().dateFormat).toBeUndefined();
  });

  it('supplied -> passed through unchanged', async () => {
    const response = await createDocument({ timezone: 'America/Los_Angeles', dateFormat: 'MM/dd/yyyy hh:mm a' });

    expect(response.status).toBe(200);
    expect(passedMeta().timezone).toBe('America/Los_Angeles');
    expect(passedMeta().dateFormat).toBe('MM/dd/yyyy hh:mm a');
  });

  it('unknown timezone -> 400 and nothing is created', async () => {
    const response = await createDocument({ timezone: 'Mars/Olympus_Mons' });

    expect(response.status).toBe(400);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it('unknown dateFormat -> 400 and nothing is created', async () => {
    const response = await createDocument({ dateFormat: 'not-a-format' });

    expect(response.status).toBe(400);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });
});
