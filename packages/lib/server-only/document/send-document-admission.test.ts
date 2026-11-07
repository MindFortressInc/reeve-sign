import { DocumentStatus, FieldType, RecipientRole, SigningStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors/app-error';

// DEV-18278: sendDocument asks reeve-services' fair-use admission BEFORE the
// credits meter (and so before any mail), and a refusal stops the send with
// nothing metered. Runs the real sendDocument with only I/O mocked.

const { prismaMock, meterDocumentSendMock, admitSignSendMock } = vi.hoisted(() => ({
  prismaMock: { envelope: { findFirst: vi.fn() } },
  meterDocumentSendMock: vi.fn(),
  admitSignSendMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: prismaMock }));
vi.mock('../credits/meter-send', () => ({ meterDocumentSend: meterDocumentSendMock }));
vi.mock('../sign-admission/admit-send', () => ({ admitSignSend: admitSignSendMock }));
vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: vi.fn(async () => ({ envelopeWhereInput: { id: 'envelope_abc' } })),
}));
vi.mock('../../jobs/client', () => ({ jobs: { triggerJob: vi.fn() } }));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));
vi.mock('../pdf/insert-form-values-in-pdf', () => ({ insertFormValuesInPdf: vi.fn() }));
vi.mock('../../universal/upload/get-file.server', () => ({ getFileServerSide: vi.fn() }));
vi.mock('../../universal/upload/put-file.server', () => ({ putNormalizedPdfFileServerSide: vi.fn() }));

const { sendDocument } = await import('./send-document');

const ORG_URL = 'reeve-ext-0123abcd';

const ENVELOPE = {
  id: 'envelope_abc',
  secondaryId: 'document_42',
  status: DocumentStatus.DRAFT,
  authOptions: null,
  formValues: null,
  documentMeta: null,
  team: { organisation: { url: ORG_URL } },
  recipients: [
    {
      id: 1,
      email: 'signer@example.com',
      name: 'Signer',
      role: RecipientRole.SIGNER,
      signingStatus: SigningStatus.NOT_SIGNED,
      authOptions: null,
    },
  ],
  fields: [{ id: 10, recipientId: 1, type: FieldType.SIGNATURE }],
  envelopeItems: [{ id: 'item_1', documentData: { id: 'dd_1', type: 'BYTES_64', data: '', initialData: '' } }],
};

const OPTIONS = {
  id: { type: 'envelopeId' as const, id: 'envelope_abc' },
  userId: 5,
  teamId: 7,
  requestMetadata: {} as never,
};

beforeEach(() => {
  prismaMock.envelope.findFirst.mockReset().mockResolvedValue(ENVELOPE);
  meterDocumentSendMock.mockReset().mockResolvedValue('sent');
  admitSignSendMock.mockReset().mockResolvedValue({ enforced: true, account: 'org_1', consumed: false, replay: true });
});

describe('sendDocument fair-use admission (DEV-18278)', () => {
  it('admits the send (v2 envelope id + legacy document id + org url, attempt "send") BEFORE metering', async () => {
    const order: string[] = [];
    admitSignSendMock.mockImplementation(async () => {
      order.push('admit');
      return { enforced: true, account: 'org_1', consumed: false, replay: true };
    });
    meterDocumentSendMock.mockImplementation(async () => {
      order.push('meter');
      return 'sent';
    });

    await expect(sendDocument(OPTIONS)).resolves.toBe('sent');

    expect(order).toEqual(['admit', 'meter']);
    expect(admitSignSendMock).toHaveBeenCalledWith({
      envelopeId: 'envelope_abc',
      legacyDocumentId: 42,
      organisationUrl: ORG_URL,
      attempt: 'send',
    });
  });

  it('loads the envelope organisation url with the envelope', async () => {
    await sendDocument(OPTIONS);

    const [query] = prismaMock.envelope.findFirst.mock.calls[0] as [{ include: Record<string, unknown> }];

    expect(query.include.team).toEqual({ select: { organisation: { select: { url: true } } } });
  });

  it('a refusal propagates and nothing is metered or sent', async () => {
    const refusal = new AppError('SIGN_SEND_RATE_LIMITED', { message: 'slow down', statusCode: 429 });
    admitSignSendMock.mockRejectedValue(refusal);

    await expect(sendDocument(OPTIONS)).rejects.toBe(refusal);
    expect(meterDocumentSendMock).not.toHaveBeenCalled();
  });

  it('validation failures still throw before admission (a rejected send spends no slot)', async () => {
    prismaMock.envelope.findFirst.mockResolvedValue({ ...ENVELOPE, fields: [] });

    await expect(sendDocument(OPTIONS)).rejects.toThrow(/missing required fields/);
    expect(admitSignSendMock).not.toHaveBeenCalled();
    expect(meterDocumentSendMock).not.toHaveBeenCalled();
  });
});
