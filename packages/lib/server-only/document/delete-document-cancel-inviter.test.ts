import { setupI18n } from '@lingui/core';
import { DocumentStatus, SendStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-12519: an envelope created with `X-Reeve-Sign-On-Behalf-Of` is owned by
// the real sender (an org MEMBER), but reeve-services voids it with the org's
// system-user API token (`DELETE /api/v1/documents/{id}`). The cancellation
// email must name the envelope OWNER, like the signing invite and reminder
// (DEV-12502 C1 amendment) and the reject-path cancellation job already do,
// not the API-token caller. Runs the real deleteDocument -> email render
// chain with only I/O mocked.

const { prismaMock, transactionTxMock, sendMailMock } = vi.hoisted(() => {
  const transactionTxMock = {
    documentAuditLog: { create: vi.fn() },
    envelope: { delete: vi.fn() },
  };

  return {
    transactionTxMock,
    prismaMock: {
      user: { findUnique: vi.fn() },
      envelope: { findUnique: vi.fn() },
      recipient: { update: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: typeof transactionTxMock) => unknown) => await fn(transactionTxMock)),
    },
    sendMailMock: vi.fn(),
  };
});

vi.mock('@documenso/prisma', () => ({ prisma: prismaMock }));
vi.mock('@documenso/email/mailer', () => ({ mailer: { sendMail: sendMailMock } }));
vi.mock('../team/get-member-roles', () => ({ getMemberRoles: vi.fn(async () => ({ teamRole: 'ADMIN' })) }));
vi.mock('../email/get-email-context', () => ({
  getEmailContext: vi.fn(async () => ({
    branding: undefined,
    emailLanguage: 'en',
    senderEmail: { name: 'Reeve', address: 'noreply@sign.meetreeve.com' },
    replyToEmail: undefined,
  })),
}));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));
vi.mock('../../types/webhook-payload', () => ({
  mapEnvelopeToWebhookDocumentPayload: vi.fn(),
  ZWebhookDocumentSchema: { parse: vi.fn() },
}));
// Compiled translation catalogs are a build artefact; the source-language
// message descriptors render identically without them.
vi.mock('../../client-only/providers/i18n-server', () => ({
  getI18nInstance: () => {
    const i18n = setupI18n({ locale: 'en', messages: { en: {} } });
    i18n.activate('en');

    return Promise.resolve(i18n);
  },
}));

const { deleteDocument } = await import('./delete-document');

const SYSTEM_USER = { id: 999, email: 'reeve-provisioner@meetreeve.com', name: 'Reeve Provisioner' };
const MEMBER = { id: 77, email: 'matt@mindfortress.com', name: 'Matt Rhodes' };

// Pending, owned by the on-behalf-of member (77), NOT the token's system user (999).
const ENVELOPE = {
  id: 'envelope_1',
  secondaryId: 'document_42',
  userId: MEMBER.id,
  teamId: 7,
  title: 'NDA',
  status: DocumentStatus.PENDING,
  deletedAt: null,
  recipients: [{ id: 5, email: 'signer@example.com', name: 'Signer', sendStatus: SendStatus.SENT }],
  documentMeta: { emailSettings: null },
};

describe('deleteDocument: the cancellation email names the envelope owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue(SYSTEM_USER);
    // The owner is only on the row when the query asks for it.
    prismaMock.envelope.findUnique.mockImplementation(async ({ include }: { include?: { user?: unknown } }) =>
      include?.user ? { ...ENVELOPE, user: MEMBER } : ENVELOPE,
    );
    transactionTxMock.envelope.delete.mockResolvedValue(ENVELOPE);
  });

  it('names the member owner, not the system-user token caller, when the org token voids it', async () => {
    await deleteDocument({
      id: { type: 'documentId', id: 42 },
      userId: SYSTEM_USER.id,
      teamId: ENVELOPE.teamId,
      requestMetadata: { requestMetadata: {}, source: 'apiV1', auth: 'api' } as never,
    });

    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const { text, html } = sendMailMock.mock.calls[0][0];

    expect(String(text)).toContain('Matt Rhodes has cancelled the document');
    expect(String(html)).toContain('Matt Rhodes');
    expect(`${text}${html}`).not.toContain('Reeve Provisioner');
  });

  it("falls back to the owner's email when the owner has no name", async () => {
    prismaMock.envelope.findUnique.mockImplementation(async ({ include }: { include?: { user?: unknown } }) =>
      include?.user ? { ...ENVELOPE, user: { ...MEMBER, name: null } } : ENVELOPE,
    );

    await deleteDocument({
      id: { type: 'documentId', id: 42 },
      userId: SYSTEM_USER.id,
      teamId: ENVELOPE.teamId,
      requestMetadata: { requestMetadata: {}, source: 'apiV1', auth: 'api' } as never,
    });

    const { text } = sendMailMock.mock.calls[0][0];

    expect(String(text)).toContain(`${MEMBER.email} has cancelled the document`);
    expect(String(text)).not.toContain('Lucas Smith');
  });
});
