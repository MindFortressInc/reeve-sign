import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
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

// DEV-12502 (C1 + amendment): `X-Reeve-Sign-On-Behalf-Of` on the v2 routes
// reeve-agents actually calls (POST /api/v2/document/create and
// POST /api/v2/template/use). The last test runs the whole v2 lane with the
// org's system-user token: create on behalf of a member, distribute, then
// render the queued invite. It must read `<member> on behalf of "<org>"`.

const {
  prismaMock,
  txMock,
  getApiTokenByTokenMock,
  createEnvelopeMock,
  createDocumentFromTemplateMock,
  triggerJobMock,
  sendMailMock,
} = vi.hoisted(() => {
  const txMock = {
    documentAuditLog: { create: vi.fn() },
    recipient: { updateMany: vi.fn() },
    envelope: { update: vi.fn() },
    field: { update: vi.fn() },
  };

  return {
    txMock,
    prismaMock: {
      user: { findFirst: vi.fn(), findFirstOrThrow: vi.fn() },
      team: { findFirst: vi.fn() },
      envelope: { findFirst: vi.fn(), findFirstOrThrow: vi.fn() },
      recipient: { findFirstOrThrow: vi.fn(), update: vi.fn() },
      documentAuditLog: { create: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: typeof txMock) => unknown) => await fn(txMock)),
    },
    getApiTokenByTokenMock: vi.fn(),
    createEnvelopeMock: vi.fn(),
    createDocumentFromTemplateMock: vi.fn(),
    triggerJobMock: vi.fn(),
    sendMailMock: vi.fn(),
  };
});

vi.mock('@documenso/prisma', () => ({ prisma: prismaMock }));
vi.mock('@documenso/lib/server-only/public-api/get-api-token-by-token', () => ({
  getApiTokenByToken: getApiTokenByTokenMock,
}));
vi.mock('@documenso/ee/server-only/limits/server', () => ({
  getServerLimits: vi.fn(async () => ({ remaining: { documents: 100 } })),
}));
vi.mock('@documenso/lib/server-only/document-conversion', () => ({
  convertToPdf: vi.fn(async () => Buffer.from('%PDF-1.7')),
}));
vi.mock('@documenso/lib/universal/upload/put-file.server', () => ({
  putNormalizedPdfFileServerSide: vi.fn(async () => ({ id: 'data_1' })),
}));
vi.mock('@documenso/lib/server-only/envelope/create-envelope', () => ({ createEnvelope: createEnvelopeMock }));
vi.mock('@documenso/lib/server-only/template/create-document-from-template', () => ({
  createDocumentFromTemplate: createDocumentFromTemplateMock,
}));
vi.mock('@documenso/lib/jobs/client', () => ({ jobs: { triggerJob: triggerJobMock } }));
vi.mock('@documenso/email/mailer', () => ({ mailer: { sendMail: sendMailMock } }));
vi.mock('@documenso/lib/server-only/email/get-email-context', () => ({
  getEmailContext: vi.fn(async () => ({
    branding: undefined,
    emailLanguage: 'en',
    settings: { includeSenderDetails: true },
    organisationType: OrganisationType.ORGANISATION,
    senderEmail: { name: 'Reeve', address: 'noreply@sign.meetreeve.com' },
    replyToEmail: undefined,
  })),
}));
vi.mock('@documenso/lib/server-only/envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: vi.fn(async () => ({ envelopeWhereInput: { id: 'envelope_1' } })),
}));
vi.mock('@documenso/lib/server-only/credits/meter-send', () => ({
  meterDocumentSend: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));
vi.mock('@documenso/lib/server-only/webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));
vi.mock('@documenso/lib/types/webhook-payload', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  mapEnvelopeToWebhookDocumentPayload: vi.fn(),
  ZWebhookDocumentSchema: { parse: vi.fn() },
}));
vi.mock('@documenso/lib/server-only/recipient/update-recipient-next-reminder', () => ({
  updateRecipientNextReminder: vi.fn(),
}));
// Compiled translation catalogs are a build artefact; the source-language
// message descriptors render identically without them.
vi.mock('@documenso/lib/client-only/providers/i18n-server', () => ({
  getI18nInstance: () => {
    const i18n = setupI18n({ locale: 'en', messages: { en: {} } });
    i18n.activate('en');

    return Promise.resolve(i18n);
  },
}));

const { createCallerFactory, router } = await import('./trpc');
const { createDocumentRoute } = await import('./document-router/create-document');
const { distributeEnvelopeRoute } = await import('./envelope-router/distribute-envelope');
const { templateRouter } = await import('./template-router/router');
const { run: runSendSigningEmail } = await import('@documenso/lib/jobs/definitions/emails/send-signing-email.handler');

const ON_BEHALF_OF = 'X-Reeve-Sign-On-Behalf-Of';
const SYSTEM_USER = { id: 999, email: 'reeve-provisioner@meetreeve.com', name: 'Reeve Provisioner', disabled: false };
const MEMBER = { id: 77, email: 'matt@mindfortress.com', name: 'Matt Rhodes' };
const TEAM = { id: 7, name: 'MindFortress' };

const RECIPIENT = {
  id: 5,
  email: 'signer@example.com',
  name: 'Signer',
  token: 'recipient-token',
  role: RecipientRole.SIGNER,
  signingOrder: null,
  signingStatus: SigningStatus.NOT_SIGNED,
  sendStatus: SendStatus.NOT_SENT,
  authOptions: null,
};

const envelopeOwnedBy = (userId: number) => ({
  id: 'envelope_1',
  secondaryId: 'document_42',
  userId,
  teamId: TEAM.id,
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
});

const createCaller = createCallerFactory(
  router({
    create: createDocumentRoute,
    distribute: distributeEnvelopeRoute,
    useTemplate: templateRouter.createDocumentFromTemplate,
  }),
);

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: () => logger };

// Authenticated exactly as a v2 OpenAPI request carrying the org's API token.
const callerWith = (headers: Record<string, string> = {}) =>
  createCaller({
    logger: logger as never,
    session: null,
    user: null,
    teamId: undefined,
    req: new Request('http://localhost/api/v2', { headers: { authorization: 'api_org_token', ...headers } }),
    res: new Response(),
    metadata: { requestMetadata: {}, source: 'apiV2', auth: null },
  });

const createInput = () => {
  const form = new FormData();
  form.append('payload', JSON.stringify({ title: 'NDA' }));
  form.append('file', new File([Buffer.from('%PDF-1.7')], 'nda.pdf', { type: 'application/pdf' }));

  return form;
};

const expectForbidden = async (promise: Promise<unknown>) => {
  const err = await promise.catch((e: unknown) => e);

  expect(AppError.parseError((err as { cause?: unknown }).cause ?? err).code).toBe(AppErrorCode.FORBIDDEN);
};

describe('v2 X-Reeve-Sign-On-Behalf-Of', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getApiTokenByTokenMock.mockResolvedValue({ id: 1, user: SYSTEM_USER, team: TEAM, teamId: TEAM.id });
    createEnvelopeMock.mockImplementation(async ({ userId }: { userId: number }) => envelopeOwnedBy(userId));
    // template/use returns getDocumentWithDetailsById's full shape; these
    // tests only need to see who createDocumentFromTemplate was called for.
    createDocumentFromTemplateMock.mockRejectedValue(new AppError(AppErrorCode.NOT_FOUND, { message: 'stop here' }));
  });

  const asMember = () => {
    prismaMock.user.findFirst.mockResolvedValue({ id: MEMBER.id });
    prismaMock.team.findFirst.mockResolvedValue({ id: TEAM.id });
  };

  const asNonMember = () => {
    prismaMock.user.findFirst.mockResolvedValue({ id: 88 });
    prismaMock.team.findFirst.mockResolvedValue(null);
  };

  describe('POST /api/v2/document/create', () => {
    it('member -> the envelope is owned by that member', async () => {
      asMember();

      await callerWith({ [ON_BEHALF_OF]: MEMBER.email }).create(createInput() as never);

      expect(createEnvelopeMock).toHaveBeenCalledWith(expect.objectContaining({ userId: MEMBER.id, teamId: TEAM.id }));
    });

    it('non-member -> 403 and nothing is created', async () => {
      asNonMember();

      await expectForbidden(callerWith({ [ON_BEHALF_OF]: 'other-org@example.com' }).create(createInput() as never));

      expect(createEnvelopeMock).not.toHaveBeenCalled();
    });

    it('header absent -> unchanged: the token user owns the envelope', async () => {
      await callerWith().create(createInput() as never);

      expect(prismaMock.user.findFirst).not.toHaveBeenCalled();
      expect(createEnvelopeMock).toHaveBeenCalledWith(expect.objectContaining({ userId: SYSTEM_USER.id }));
    });
  });

  describe('POST /api/v2/template/use', () => {
    const useInput = { templateId: 5, recipients: [] };

    it('member -> the envelope is created for that member', async () => {
      asMember();

      await callerWith({ [ON_BEHALF_OF]: MEMBER.email })
        .useTemplate(useInput)
        .catch(() => undefined);

      expect(createDocumentFromTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: MEMBER.id, teamId: TEAM.id }),
      );
    });

    it('non-member -> 403 and nothing is created', async () => {
      asNonMember();

      await expectForbidden(callerWith({ [ON_BEHALF_OF]: 'other-org@example.com' }).useTemplate(useInput));

      expect(createDocumentFromTemplateMock).not.toHaveBeenCalled();
    });

    it('header absent -> unchanged', async () => {
      await callerWith()
        .useTemplate(useInput)
        .catch(() => undefined);

      expect(createDocumentFromTemplateMock).toHaveBeenCalledWith(expect.objectContaining({ userId: SYSTEM_USER.id }));
    });
  });

  it('create on behalf of a member + distribute with the org token renders `<member> on behalf of "<org>"`', async () => {
    asMember();

    // 1. Create on behalf of the member.
    await callerWith({ [ON_BEHALF_OF]: MEMBER.email }).create(createInput() as never);
    const created = await createEnvelopeMock.mock.results[0].value;
    expect(created.userId).toBe(MEMBER.id);

    // 2. Distribute that envelope with the same org token (no header), as
    //    reeve-agents does.
    prismaMock.envelope.findFirst.mockResolvedValue(created);
    txMock.envelope.update.mockResolvedValue({ ...created, status: DocumentStatus.PENDING });

    await callerWith().distribute({ envelopeId: created.id });

    // 3. Run the invite job distribute queued, rendering the real email.
    const signingJob = triggerJobMock.mock.calls.find(([job]) => job.name === 'send.signing.requested.email');

    if (!signingJob) {
      throw new Error('distribute queued no send.signing.requested.email job');
    }

    const users: Record<number, object> = { [SYSTEM_USER.id]: SYSTEM_USER, [MEMBER.id]: MEMBER };
    prismaMock.user.findFirstOrThrow.mockImplementation(({ where }: { where: { id: number } }) =>
      Promise.resolve(users[where.id]),
    );
    prismaMock.envelope.findFirstOrThrow.mockResolvedValue({
      ...created,
      status: DocumentStatus.PENDING,
      team: { name: TEAM.name, teamEmail: null },
    });
    prismaMock.recipient.findFirstOrThrow.mockResolvedValue(RECIPIENT);

    await runSendSigningEmail({
      payload: signingJob[0].payload,
      io: { runTask: async (_key: string, fn: () => Promise<unknown>) => await fn() } as never,
    });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const { text } = sendMailMock.mock.calls[0][0];
    expect(text).toContain('Matt Rhodes on behalf of "MindFortress"');
    expect(text).not.toContain(SYSTEM_USER.name);
  });
});
