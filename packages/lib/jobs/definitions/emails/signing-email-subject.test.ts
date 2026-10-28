import { setupI18n } from '@lingui/core';
import {
  DocumentDistributionMethod,
  DocumentSource,
  DocumentStatus,
  OrganisationType,
  RecipientRole,
  SendStatus,
  SigningStatus,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-17161: with no custom subject, every invite and reminder used to share
// one generic subject ("Sulu invited you to sign a document"), so a recipient
// of several envelopes could not tell them apart in the inbox. The default
// subject must name the document; an explicit subject still wins. These run
// the real send / scheduled-reminder / resend subject builders with only I/O
// mocked.

const { prismaMock, sendMailMock, getEmailContextMock } = vi.hoisted(() => ({
  prismaMock: {
    envelope: { findFirstOrThrow: vi.fn(), findUnique: vi.fn() },
    user: { findFirstOrThrow: vi.fn() },
    recipient: { findFirstOrThrow: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    documentAuditLog: { create: vi.fn() },
  },
  sendMailMock: vi.fn(),
  getEmailContextMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: prismaMock }));
vi.mock('@documenso/email/mailer', () => ({ mailer: { sendMail: sendMailMock } }));
vi.mock('../../../server-only/email/get-email-context', () => ({ getEmailContext: getEmailContextMock }));
vi.mock('../../../server-only/envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: vi.fn(async () => ({ envelopeWhereInput: { id: 'envelope_1' } })),
}));
vi.mock('../../../server-only/webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));
vi.mock('../../../types/webhook-payload', () => ({
  mapEnvelopeToWebhookDocumentPayload: vi.fn(),
  ZWebhookDocumentSchema: { parse: vi.fn() },
}));
vi.mock('../../../server-only/recipient/update-recipient-next-reminder', () => ({
  updateRecipientNextReminder: vi.fn(),
}));
// Compiled translation catalogs are a build artefact; the source-language
// message descriptors render identically without them.
vi.mock('../../../client-only/providers/i18n-server', () => ({
  getI18nInstance: () => {
    const i18n = setupI18n({ locale: 'en', messages: { en: {} } });
    i18n.activate('en');

    return Promise.resolve(i18n);
  },
}));

const { run: runSendSigningEmail } = await import('./send-signing-email.handler');
const { run: runSigningReminder } = await import('../internal/process-signing-reminder.handler');
const { resendDocument } = await import('../../../server-only/document/resend-document');

const SENDER = { id: 77, email: 'matt@mindfortress.com', name: 'Matt Rhodes' };

const RECIPIENT = {
  id: 5,
  email: 'nathan@example.com',
  name: 'Nathan',
  token: 'recipient-token',
  role: RecipientRole.SIGNER,
  signingStatus: SigningStatus.NOT_SIGNED,
  sendStatus: SendStatus.SENT,
  sentAt: null,
  expiresAt: null,
  authOptions: null,
};

const TEAM = { name: 'Sulu', teamEmail: null };

const emailContext = (organisationType: OrganisationType) => ({
  branding: undefined,
  emailLanguage: 'en',
  settings: { includeSenderDetails: true },
  organisationType,
  senderEmail: { name: 'Reeve', address: 'noreply@sign.meetreeve.com' },
  replyToEmail: undefined,
});

const buildEnvelope = ({
  title = 'NDA',
  subject = null as string | null,
  source = DocumentSource.DOCUMENT as DocumentSource,
} = {}) => ({
  id: 'envelope_1',
  secondaryId: 'document_42',
  userId: SENDER.id,
  teamId: 6,
  title,
  status: DocumentStatus.PENDING,
  source,
  internalVersion: 1,
  recipients: [RECIPIENT],
  team: TEAM,
  user: SENDER,
  documentMeta: {
    emailSettings: null,
    distributionMethod: DocumentDistributionMethod.EMAIL,
    message: null,
    subject,
  },
});

const sentSubject = () => {
  expect(sendMailMock).toHaveBeenCalledTimes(1);

  return String(sendMailMock.mock.calls[0][0].subject);
};

const io = {
  runTask: async (_key: string, fn: () => Promise<unknown>) => await fn(),
  logger: { info: vi.fn(), warn: vi.fn() },
} as never;

const sendInvite = async (envelope: ReturnType<typeof buildEnvelope>, recipient = RECIPIENT) => {
  prismaMock.envelope.findFirstOrThrow.mockResolvedValue(envelope);
  prismaMock.recipient.findFirstOrThrow.mockResolvedValue(recipient);

  await runSendSigningEmail({
    payload: { userId: SENDER.id, documentId: 42, recipientId: recipient.id, requestMetadata: undefined } as never,
    io,
  });

  return sentSubject();
};

const sendReminder = async (envelope: ReturnType<typeof buildEnvelope>) => {
  prismaMock.recipient.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.recipient.findFirst.mockResolvedValue({ ...RECIPIENT, envelope });

  await runSigningReminder({ payload: { recipientId: RECIPIENT.id }, io });

  return sentSubject();
};

const resend = async (envelope: ReturnType<typeof buildEnvelope>) => {
  prismaMock.envelope.findUnique.mockResolvedValue(envelope);

  await resendDocument({
    id: { type: 'envelopeId', id: envelope.id },
    userId: SENDER.id,
    teamId: envelope.teamId,
    recipients: [RECIPIENT.id],
    requestMetadata: { requestMetadata: {}, source: 'apiV2', auth: 'api' } as never,
  });

  return sentSubject();
};

describe('signing email default subject names the document (DEV-17161)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findFirstOrThrow.mockResolvedValue(SENDER);
    getEmailContextMock.mockResolvedValue(emailContext(OrganisationType.ORGANISATION));
  });

  describe('initial invite', () => {
    it('organisation default includes the title, so two envelopes are distinguishable', async () => {
      expect(await sendInvite(buildEnvelope({ title: 'Lease 59' }))).toBe(
        'Sulu invited you to sign the document "Lease 59"',
      );

      vi.clearAllMocks();
      prismaMock.user.findFirstOrThrow.mockResolvedValue(SENDER);
      getEmailContextMock.mockResolvedValue(emailContext(OrganisationType.ORGANISATION));

      expect(await sendInvite(buildEnvelope({ title: 'Lease 60' }))).toBe(
        'Sulu invited you to sign the document "Lease 60"',
      );
    });

    it('organisation default wins over the direct-template branch', async () => {
      expect(await sendInvite(buildEnvelope({ source: DocumentSource.TEMPLATE_DIRECT_LINK }))).toBe(
        'Sulu invited you to sign the document "NDA"',
      );
    });

    it('personal defaults include the title', async () => {
      getEmailContextMock.mockResolvedValue(emailContext(OrganisationType.PERSONAL));

      expect(await sendInvite(buildEnvelope())).toBe('Please sign the document "NDA"');
    });

    it('personal self-signer default includes the title', async () => {
      getEmailContextMock.mockResolvedValue(emailContext(OrganisationType.PERSONAL));

      expect(await sendInvite(buildEnvelope(), { ...RECIPIENT, email: SENDER.email })).toBe(
        'Please sign your document "NDA"',
      );
    });

    it('personal direct-template default includes the title', async () => {
      getEmailContextMock.mockResolvedValue(emailContext(OrganisationType.PERSONAL));

      expect(await sendInvite(buildEnvelope({ source: DocumentSource.TEMPLATE_DIRECT_LINK }))).toBe(
        'Please sign the document "NDA" created by your direct template',
      );
    });

    it('a title containing braces is not treated as a template placeholder', async () => {
      expect(await sendInvite(buildEnvelope({ title: 'Offer {v2} for {signer.name}' }))).toBe(
        'Sulu invited you to sign the document "Offer {v2} for {signer.name}"',
      );
    });

    it('an explicit subject still overrides the default and expands placeholders', async () => {
      expect(await sendInvite(buildEnvelope({ subject: 'Sign {document.name}, {signer.name}' }))).toBe(
        'Sign NDA, Nathan',
      );
    });
  });

  describe('scheduled reminder', () => {
    it('organisation default includes the title', async () => {
      expect(await sendReminder(buildEnvelope({ title: 'Lease 59' }))).toBe(
        'Reminder: Sulu invited you to sign the document "Lease 59"',
      );
    });

    it('an explicit subject still overrides the default', async () => {
      expect(await sendReminder(buildEnvelope({ subject: 'Sign {document.name}' }))).toBe('Reminder: Sign NDA');
    });
  });

  describe('manual resend', () => {
    it('organisation default includes the title', async () => {
      expect(await resend(buildEnvelope({ title: 'Lease 59' }))).toBe(
        'Reminder: Sulu invited you to sign the document "Lease 59"',
      );
    });

    it('personal default includes the title', async () => {
      getEmailContextMock.mockResolvedValue(emailContext(OrganisationType.PERSONAL));

      expect(await resend(buildEnvelope())).toBe('Reminder: Please sign the document "NDA"');
    });

    it('an explicit subject still overrides the default', async () => {
      expect(await resend(buildEnvelope({ subject: 'Sign {document.name}' }))).toBe('Reminder: Sign NDA');
    });
  });
});
