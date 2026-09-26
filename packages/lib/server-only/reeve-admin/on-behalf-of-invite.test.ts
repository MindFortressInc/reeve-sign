import { setupI18n } from '@lingui/core';
import {
  DocumentSigningOrder,
  DocumentSource,
  DocumentStatus,
  FieldType,
  OrganisationType,
  RecipientRole,
  SendStatus,
  SigningStatus,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-12502 (C1 amendment): an envelope created with
// `X-Reeve-Sign-On-Behalf-Of` is owned by the real sender, but every later
// call (distribute, redistribute) is made with the org's system-user API
// token. The signing invite must name the envelope OWNER, not that caller,
// so it reads `Matt Rhodes on behalf of "MindFortress"`. These tests run the
// real sendDocument -> send-signing-email job handler -> email render chain,
// and the real resendDocument render, with only I/O mocked.

const { prismaMock, transactionTxMock, triggerJobMock, sendMailMock, getEmailContextMock } = vi.hoisted(() => {
  const transactionTxMock = {
    documentAuditLog: { create: vi.fn() },
    recipient: { updateMany: vi.fn() },
    envelope: { update: vi.fn() },
    field: { update: vi.fn() },
  };

  return {
    transactionTxMock,
    prismaMock: {
      envelope: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn() },
      user: { findFirstOrThrow: vi.fn() },
      recipient: { findFirstOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
      documentAuditLog: { create: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: typeof transactionTxMock) => unknown) => await fn(transactionTxMock)),
    },
    triggerJobMock: vi.fn(),
    sendMailMock: vi.fn(),
    getEmailContextMock: vi.fn(),
  };
});

vi.mock('@documenso/prisma', () => ({ prisma: prismaMock }));
vi.mock('@documenso/email/mailer', () => ({ mailer: { sendMail: sendMailMock } }));
vi.mock('../../jobs/client', () => ({ jobs: { triggerJob: triggerJobMock } }));
vi.mock('../email/get-email-context', () => ({ getEmailContext: getEmailContextMock }));
vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: vi.fn(async () => ({ envelopeWhereInput: { id: 'envelope_1' } })),
}));
vi.mock('../credits/meter-send', () => ({
  meterDocumentSend: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));
vi.mock('../../types/webhook-payload', () => ({
  mapEnvelopeToWebhookDocumentPayload: vi.fn(),
  ZWebhookDocumentSchema: { parse: vi.fn() },
}));
vi.mock('../recipient/update-recipient-next-reminder', () => ({ updateRecipientNextReminder: vi.fn() }));
// Compiled translation catalogs are a build artefact; the source-language
// message descriptors render identically without them.
vi.mock('../../client-only/providers/i18n-server', () => ({
  getI18nInstance: () => {
    const i18n = setupI18n({ locale: 'en', messages: { en: {} } });
    i18n.activate('en');

    return Promise.resolve(i18n);
  },
}));

const { sendDocument } = await import('../document/send-document');
const { resendDocument } = await import('../document/resend-document');
const { run: runSendSigningEmail } = await import('../../jobs/definitions/emails/send-signing-email.handler');

const SYSTEM_USER = { id: 999, email: 'reeve-provisioner@meetreeve.com', name: 'Reeve Provisioner' };
const MEMBER = { id: 77, email: 'matt@mindfortress.com', name: 'Matt Rhodes' };
const USERS: Record<number, typeof MEMBER> = { [SYSTEM_USER.id]: SYSTEM_USER, [MEMBER.id]: MEMBER };

const RECIPIENT = {
  id: 5,
  email: 'signer@example.com',
  name: 'Signer',
  token: 'recipient-token',
  role: RecipientRole.SIGNER,
  signingStatus: SigningStatus.NOT_SIGNED,
  sendStatus: SendStatus.NOT_SENT,
  authOptions: null,
};

const TEAM = { name: 'MindFortress', teamEmail: null };

const ORG_EMAIL_CONTEXT = {
  branding: undefined,
  emailLanguage: 'en',
  settings: { includeSenderDetails: true },
  organisationType: OrganisationType.ORGANISATION,
  senderEmail: { name: 'Reeve', address: 'noreply@sign.meetreeve.com' },
  replyToEmail: undefined,
};

// Owned by the on-behalf-of member (77), NOT the token's system user (999).
const ENVELOPE = {
  id: 'envelope_1',
  secondaryId: 'document_42',
  userId: MEMBER.id,
  teamId: 7,
  title: 'NDA',
  status: DocumentStatus.DRAFT,
  source: DocumentSource.DOCUMENT,
  internalVersion: 1,
  formValues: null,
  authOptions: null,
  recipients: [RECIPIENT],
  fields: [{ id: 1, recipientId: RECIPIENT.id, type: FieldType.SIGNATURE }],
  envelopeItems: [{ id: 'item_1' }],
  documentMeta: {
    signingOrder: DocumentSigningOrder.PARALLEL,
    emailSettings: null,
    envelopeExpirationPeriod: null,
    message: null,
    subject: null,
  },
};

const REQUEST_METADATA = { requestMetadata: {}, source: 'apiV2', auth: 'api' } as const;

const sentText = () => {
  expect(sendMailMock).toHaveBeenCalledTimes(1);

  return String(sendMailMock.mock.calls[0][0].text);
};

describe('on-behalf-of envelopes: the signing invite names the envelope owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findFirstOrThrow.mockImplementation(({ where }: { where: { id: number } }) => {
      const user = USERS[where.id];

      return user ? Promise.resolve(user) : Promise.reject(new Error('No user'));
    });
    getEmailContextMock.mockResolvedValue(ORG_EMAIL_CONTEXT);
  });

  it('distribute with the system-user token queues the invite for the owner, and it renders `<member> on behalf of "<org>"`', async () => {
    prismaMock.envelope.findFirst.mockResolvedValue(ENVELOPE);
    transactionTxMock.envelope.update.mockResolvedValue({ ...ENVELOPE, status: DocumentStatus.PENDING });

    await sendDocument({
      id: { type: 'envelopeId', id: ENVELOPE.id },
      userId: SYSTEM_USER.id,
      teamId: ENVELOPE.teamId,
      requestMetadata: REQUEST_METADATA,
    });

    const signingJob = triggerJobMock.mock.calls.find(([job]) => job.name === 'send.signing.requested.email');

    if (!signingJob) {
      throw new Error('distribute queued no send.signing.requested.email job');
    }
    expect(signingJob[0].payload.userId).toBe(MEMBER.id);

    // Now run that exact queued job and render the email it sends.
    prismaMock.envelope.findFirstOrThrow.mockResolvedValue({
      ...ENVELOPE,
      status: DocumentStatus.PENDING,
      team: TEAM,
    });
    prismaMock.recipient.findFirstOrThrow.mockResolvedValue(RECIPIENT);

    await runSendSigningEmail({
      payload: signingJob[0].payload,
      io: { runTask: async (_key: string, fn: () => Promise<unknown>) => await fn() } as never,
    });

    const text = sentText();
    expect(text).toContain('Matt Rhodes on behalf of "MindFortress"');
    expect(text).not.toContain(SYSTEM_USER.name);
  });

  it('redistribute (resend) with the system-user token names the owner, not the caller', async () => {
    prismaMock.envelope.findUnique.mockResolvedValue({
      ...ENVELOPE,
      status: DocumentStatus.PENDING,
      team: TEAM,
      user: MEMBER,
    });

    await resendDocument({
      id: { type: 'envelopeId', id: ENVELOPE.id },
      userId: SYSTEM_USER.id,
      teamId: ENVELOPE.teamId,
      recipients: [RECIPIENT.id],
      requestMetadata: REQUEST_METADATA,
    });

    const text = sentText();
    expect(text).toContain('Matt Rhodes on behalf of "MindFortress"');
    expect(text).not.toContain(SYSTEM_USER.name);
  });
});
