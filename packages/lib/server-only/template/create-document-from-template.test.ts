import { DocumentVisibility, TeamMemberRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';

// DEV-12518: `X-Reeve-Sign-On-Behalf-Of` on template use. The template is
// looked up as the API-token user (the org's system user, team ADMIN); the
// on-behalf-of member only owns the new envelope. The real
// `getEnvelopeWhereInput` builds the visibility filter here, so a MEMBER-role
// lookup of an ADMIN-visibility template really misses.

const { prismaMock, txMock, getTeamByIdMock, triggerWebhookMock } = vi.hoisted(() => {
  const txMock = {
    envelope: { create: vi.fn(), findFirst: vi.fn() },
    field: { createManyAndReturn: vi.fn() },
    documentAuditLog: { create: vi.fn() },
    envelopeAttachment: { findMany: vi.fn(), createMany: vi.fn() },
  };

  return {
    txMock,
    prismaMock: {
      envelope: { findFirst: vi.fn() },
      folder: { findUnique: vi.fn() },
      documentData: { findFirst: vi.fn(), create: vi.fn() },
      documentMeta: { create: vi.fn() },
      user: { findFirstOrThrow: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: typeof txMock) => unknown) => await fn(txMock)),
    },
    getTeamByIdMock: vi.fn(),
    triggerWebhookMock: vi.fn(),
  };
});

vi.mock('@documenso/prisma', () => ({ prisma: prismaMock }));
vi.mock('../team/get-team', () => ({ getTeamById: getTeamByIdMock }));
vi.mock('../team/get-team-settings', () => ({
  getTeamSettings: vi.fn(async () => ({
    documentVisibility: DocumentVisibility.EVERYONE,
    defaultRecipients: null,
    documentTimezone: 'Etc/UTC',
    documentLanguage: 'en',
    documentDateFormat: 'yyyy-MM-dd hh:mm a',
    typedSignatureEnabled: true,
    uploadSignatureEnabled: true,
    drawSignatureEnabled: true,
    emailId: null,
    emailReplyTo: null,
    emailDocumentSettings: null,
    envelopeExpirationPeriod: null,
    reminderSettings: null,
  })),
}));
vi.mock('../envelope/increment-id', () => ({
  incrementDocumentId: vi.fn(async () => ({ documentId: 42, formattedDocumentId: 'document_42' })),
}));
vi.mock('../../universal/upload/get-file.server', () => ({
  getFileServerSide: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
}));
vi.mock('../../universal/upload/put-file.server', () => ({
  putNormalizedPdfFileServerSide: vi.fn(async () => ({ type: 'BYTES_64', data: 'cGRm' })),
}));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: triggerWebhookMock }));
vi.mock('../../types/webhook-payload', () => ({
  mapEnvelopeToWebhookDocumentPayload: vi.fn((envelope: unknown) => envelope),
  ZWebhookDocumentSchema: { parse: vi.fn((payload: unknown) => payload) },
}));

const { createDocumentFromTemplate } = await import('./create-document-from-template');

const SYSTEM_USER = { id: 999, email: 'reeve-provisioner@meetreeve.com', name: 'Reeve Provisioner' };
const MEMBER = { id: 77, email: 'matt@mindfortress.com', name: 'Matt Rhodes' };
const TEAM = { id: 7, name: 'MindFortress', organisationId: 'org_1', teamEmail: null };

const ROLE_BY_USER: Record<number, TeamMemberRole> = {
  [SYSTEM_USER.id]: TeamMemberRole.ADMIN,
  [MEMBER.id]: TeamMemberRole.MEMBER,
};

// Owned by the system user, visible to team ADMINs only.
const TEMPLATE = {
  id: 'envelope_template',
  secondaryId: 'template_5',
  title: 'NDA',
  internalVersion: 1,
  externalId: null,
  visibility: DocumentVisibility.ADMIN,
  userId: SYSTEM_USER.id,
  teamId: TEAM.id,
  authOptions: null,
  useLegacyFieldInsertion: false,
  documentMeta: null,
  recipients: [
    {
      id: 11,
      name: 'Signer',
      email: 'signer@example.com',
      role: 'SIGNER',
      signingOrder: null,
      authOptions: null,
      fields: [],
    },
  ],
  envelopeItems: [{ id: 'envelope_item_template', title: 'NDA', documentDataId: 'data_template', order: 1 }],
};

const REQUEST_METADATA: ApiRequestMetadata = {
  requestMetadata: { ipAddress: '198.51.100.5', userAgent: 'vitest' },
  source: 'apiV2',
  auth: 'api',
  auditUser: { id: null, email: null, name: TEAM.name },
};

type EnvelopeWhere = {
  OR?: Array<{ userId?: number; visibility?: { in: DocumentVisibility[] }; teamId?: number }>;
};

// Evaluates the team-template filter `getEnvelopeWhereInput` builds; the
// organisation-template query (no OR clause) never matches this team template.
const matchesTeamTemplate = (where: EnvelopeWhere) =>
  (where.OR ?? []).some(
    (clause) =>
      clause.userId === TEMPLATE.userId ||
      (clause.teamId === TEMPLATE.teamId && clause.visibility?.in.includes(TEMPLATE.visibility)),
  );

const useTemplate = async (ownerUserId?: number) =>
  await createDocumentFromTemplate({
    id: { type: 'templateId', id: 5 },
    userId: SYSTEM_USER.id,
    ownerUserId,
    teamId: TEAM.id,
    recipients: [{ id: 11, email: 'signer@example.com', name: 'Signer' }],
    requestMetadata: REQUEST_METADATA,
  });

const auditRows = () => txMock.documentAuditLog.create.mock.calls.map(([arg]) => arg.data);

beforeEach(() => {
  vi.clearAllMocks();

  getTeamByIdMock.mockImplementation(async ({ userId }: { userId: number }) => ({
    ...TEAM,
    currentTeamRole: ROLE_BY_USER[userId],
  }));
  prismaMock.envelope.findFirst.mockImplementation(async ({ where }: { where: EnvelopeWhere }) =>
    matchesTeamTemplate(where) ? TEMPLATE : null,
  );
  prismaMock.documentData.findFirst.mockResolvedValue({ id: 'data_template', data: 'cGRm' });
  prismaMock.documentData.create.mockResolvedValue({ id: 'data_new' });
  prismaMock.documentMeta.create.mockResolvedValue({ id: 'meta_1' });
  prismaMock.user.findFirstOrThrow.mockResolvedValue(MEMBER);

  // Recipient tokens are generated inside the function; echo them back.
  txMock.envelope.create.mockImplementation(
    async ({ data }: { data: { userId: number; recipients: { createMany: { data: { token: string }[] } } } }) => ({
      id: 'envelope_new',
      title: 'NDA',
      userId: data.userId,
      recipients: data.recipients.createMany.data.map((recipient, index) => ({
        id: 21 + index,
        token: recipient.token,
      })),
      envelopeItems: [{ id: 'envelope_item_new' }],
    }),
  );
  txMock.field.createManyAndReturn.mockResolvedValue([]);
  txMock.envelopeAttachment.findMany.mockResolvedValue([]);
  txMock.envelope.findFirst.mockResolvedValue({ id: 'envelope_new', documentMeta: null, recipients: [] });
});

describe('createDocumentFromTemplate on behalf of a member (DEV-12518)', () => {
  it('an ADMIN-visibility template resolves for a MEMBER owner; the member owns the envelope', async () => {
    const envelope = await useTemplate(MEMBER.id);

    expect(envelope.userId).toBe(MEMBER.id);
    expect(getTeamByIdMock).toHaveBeenCalledWith({ teamId: TEAM.id, userId: SYSTEM_USER.id });
    expect(getTeamByIdMock).not.toHaveBeenCalledWith(expect.objectContaining({ userId: MEMBER.id }));
  });

  it('records DOCUMENT_CREATED for the member and DOCUMENT_DELEGATED_OWNER_CREATED naming the token actor', async () => {
    await useTemplate(MEMBER.id);

    const [created, delegated] = auditRows();

    expect(created.type).toBe('DOCUMENT_CREATED');
    expect(created.userId).toBe(MEMBER.id);

    expect(delegated.type).toBe('DOCUMENT_DELEGATED_OWNER_CREATED');
    expect(delegated.envelopeId).toBe('envelope_new');
    expect(delegated.userId).toBe(SYSTEM_USER.id);
    expect(delegated.data).toEqual({
      delegatedOwnerName: MEMBER.name,
      delegatedOwnerEmail: MEMBER.email,
      teamName: TEAM.name,
    });
    expect(prismaMock.user.findFirstOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MEMBER.id } }),
    );
  });

  it('webhooks key on the token actor, as on the header-less path', async () => {
    await useTemplate(MEMBER.id);

    expect(triggerWebhookMock).toHaveBeenCalledTimes(2);
    for (const [args] of triggerWebhookMock.mock.calls) {
      expect(args).toEqual(expect.objectContaining({ userId: SYSTEM_USER.id, teamId: TEAM.id }));
    }
  });

  it('no owner -> token user owns it, DOCUMENT_CREATED keeps the request audit user, no delegated row', async () => {
    const envelope = await useTemplate();

    expect(envelope.userId).toBe(SYSTEM_USER.id);
    expect(prismaMock.user.findFirstOrThrow).not.toHaveBeenCalled();

    const rows = auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('DOCUMENT_CREATED');
    expect(rows[0].userId).toBeNull();
    expect(rows[0].name).toBe(TEAM.name);
  });

  it('owner equal to the token user is not a delegation', async () => {
    await useTemplate(SYSTEM_USER.id);

    expect(prismaMock.user.findFirstOrThrow).not.toHaveBeenCalled();
    expect(auditRows().map((row) => row.type)).toEqual(['DOCUMENT_CREATED']);
  });

  it('a MEMBER token user still cannot see an ADMIN-visibility template (filter unchanged)', async () => {
    await expect(
      createDocumentFromTemplate({
        id: { type: 'templateId', id: 5 },
        userId: MEMBER.id,
        teamId: TEAM.id,
        recipients: [{ id: 11, email: 'signer@example.com' }],
        requestMetadata: REQUEST_METADATA,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
