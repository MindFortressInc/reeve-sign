import { createSignAdmissionError } from '@documenso/lib/server-only/sign-admission/admit-send';
import { DocumentStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-18278: a fair-use admission refusal on the v1 send/resend routes keeps
// its status and the server's message, instead of the generic 500.

const { getApiTokenByTokenMock, getEnvelopeByIdMock, sendDocumentMock, resendDocumentMock } = vi.hoisted(() => ({
  getApiTokenByTokenMock: vi.fn(),
  getEnvelopeByIdMock: vi.fn(),
  sendDocumentMock: vi.fn(),
  resendDocumentMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: {} }));
vi.mock('@documenso/lib/server-only/public-api/get-api-token-by-token', () => ({
  getApiTokenByToken: getApiTokenByTokenMock,
}));
vi.mock('@documenso/lib/server-only/envelope/get-envelope-by-id', () => ({ getEnvelopeById: getEnvelopeByIdMock }));
vi.mock('@documenso/lib/server-only/document/send-document', () => ({ sendDocument: sendDocumentMock }));
vi.mock('@documenso/lib/server-only/document/resend-document', () => ({ resendDocument: resendDocumentMock }));
vi.mock('@documenso/lib/client-only/providers/i18n-server', () => ({ getI18nInstance: vi.fn() }));

const { ApiContractV1Implementation } = await import('./implementation');

type RouteFn = (
  args: unknown,
  ctx: { request: Request; responseHeaders: Headers },
) => Promise<{ status: number; body: { message?: string } }>;

const call = async (route: unknown, args: Record<string, unknown>) =>
  await (route as RouteFn)(
    { headers: { authorization: 'api_org_token' }, ...args },
    {
      request: new Request('http://localhost/api/v1/documents/42/send', { method: 'POST' }) as never,
      responseHeaders: new Headers(),
    },
  );

const RATE_LIMITED =
  'Slow down: this Reeve.Sign account can send 1 document per minute. Nothing was sent; try again in 37 seconds.';

beforeEach(() => {
  vi.clearAllMocks();
  getApiTokenByTokenMock.mockResolvedValue({
    id: 1,
    user: { id: 999, email: 'system@example.com', name: 'System', disabled: false },
    team: { id: 7, name: 'Team' },
    teamId: 7,
  });
  getEnvelopeByIdMock.mockResolvedValue({ id: 'envelope_abc', status: DocumentStatus.DRAFT, documentMeta: null });
});

describe('v1 send/resend: fair-use admission refusals (DEV-18278)', () => {
  it('send: 429 with the server message', async () => {
    sendDocumentMock.mockRejectedValue(createSignAdmissionError('SIGN_SEND_RATE_LIMITED', 429, RATE_LIMITED, 37));

    const res = await call(ApiContractV1Implementation.sendDocument, { params: { id: '42' }, body: {} });

    expect(res).toEqual({ status: 429, body: { message: RATE_LIMITED } });
  });

  it('send: 503 when admission is unavailable', async () => {
    sendDocumentMock.mockRejectedValue(createSignAdmissionError('SIGN_ADMISSION_UNAVAILABLE', 503, 'nothing was sent'));

    const res = await call(ApiContractV1Implementation.sendDocument, { params: { id: '42' }, body: {} });

    expect(res.status).toBe(503);
  });

  it('resend: 403 with the server message (not the generic 500)', async () => {
    resendDocumentMock.mockRejectedValue(
      createSignAdmissionError('SIGN_ACCOUNT_SUSPENDED', 403, 'suspended pending review'),
    );

    const res = await call(ApiContractV1Implementation.resendDocument, {
      params: { id: '42' },
      body: { recipients: [1] },
    });

    expect(res).toEqual({ status: 403, body: { message: 'suspended pending review' } });
  });

  it('resend: any other failure keeps the generic 500', async () => {
    resendDocumentMock.mockRejectedValue(new Error('boom'));

    const res = await call(ApiContractV1Implementation.resendDocument, {
      params: { id: '42' },
      body: { recipients: [1] },
    });

    expect(res.status).toBe(500);
  });
});
