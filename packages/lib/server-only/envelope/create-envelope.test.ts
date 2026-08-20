import { EnvelopeType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import type { CreateEnvelopeOptions } from './create-envelope';

// DEV-8741: sender OTP identity-verification is recorded as an additional
// audit log written inside createEnvelope's transaction, only when the
// caller supplies `data.senderVerification`. These tests exercise that
// branch directly (create-with-metadata writes the audit row) and confirm
// the no-metadata path is untouched (create-without stays byte-identical).
//
// vi.mock() calls are hoisted above imports by vitest's transform, so the
// mock fns must be created via vi.hoisted() to be safely referenceable
// inside the factories below.
const {
  teamFindFirstMock,
  documentMetaCreateMock,
  transactionMock,
  txEnvelopeCreateMock,
  txEnvelopeFindFirstMock,
  txDocumentAuditLogCreateMock,
  getTeamSettingsMock,
  incrementDocumentIdMock,
  incrementTemplateIdMock,
  triggerWebhookMock,
  mapEnvelopeToWebhookDocumentPayloadMock,
  zWebhookDocumentSchemaParseMock,
} = vi.hoisted(() => ({
  teamFindFirstMock: vi.fn(),
  documentMetaCreateMock: vi.fn(),
  transactionMock: vi.fn(),
  txEnvelopeCreateMock: vi.fn(),
  txEnvelopeFindFirstMock: vi.fn(),
  txDocumentAuditLogCreateMock: vi.fn(),
  getTeamSettingsMock: vi.fn(),
  incrementDocumentIdMock: vi.fn(),
  incrementTemplateIdMock: vi.fn(),
  triggerWebhookMock: vi.fn(),
  mapEnvelopeToWebhookDocumentPayloadMock: vi.fn(),
  zWebhookDocumentSchemaParseMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    team: { findFirst: teamFindFirstMock },
    documentMeta: { create: documentMetaCreateMock },
    $transaction: transactionMock,
  },
}));

vi.mock('../team/get-team-settings', () => ({
  getTeamSettings: getTeamSettingsMock,
}));

vi.mock('../envelope/increment-id', () => ({
  incrementDocumentId: incrementDocumentIdMock,
  incrementTemplateId: incrementTemplateIdMock,
}));

vi.mock('../webhooks/trigger/trigger-webhook', () => ({
  triggerWebhook: triggerWebhookMock,
}));

// Bypass the webhook payload mapping/validation entirely -- it's unrelated
// to what this test covers, and pinning down every field of a real Envelope
// row just to satisfy ZWebhookDocumentSchema.parse would make this test
// brittle to changes that have nothing to do with sender verification.
vi.mock('../../types/webhook-payload', () => ({
  mapEnvelopeToWebhookDocumentPayload: mapEnvelopeToWebhookDocumentPayloadMock,
  ZWebhookDocumentSchema: { parse: zWebhookDocumentSchemaParseMock },
}));

const { createEnvelope } = await import('./create-envelope');

const TEAM_ROW = {
  id: 10,
  organisationId: 'org_1',
  name: 'Test Team',
  organisation: {
    organisationClaim: {
      flags: { cfr21: false },
    },
  },
};

const TEAM_SETTINGS = {
  documentVisibility: 'EVERYONE',
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
  delegateDocumentOwnership: false,
};

const ENVELOPE_ID = 'envelope_abc';

const REQUEST_METADATA: ApiRequestMetadata = {
  requestMetadata: { ipAddress: '198.51.100.5', userAgent: 'vitest' },
  source: 'apiV1',
  auth: 'api',
};

const baseCreateEnvelopeOptions = (): CreateEnvelopeOptions => ({
  userId: 1,
  teamId: 10,
  internalVersion: 1 as const,
  data: {
    type: EnvelopeType.DOCUMENT,
    title: 'Test Document',
    envelopeItems: [{ documentDataId: 'docdata_1' }],
  },
  meta: {
    subject: 'Please sign',
    message: 'Sign please',
    redirectUrl: '',
  },
  requestMetadata: REQUEST_METADATA,
});

beforeEach(() => {
  teamFindFirstMock.mockReset().mockResolvedValue(TEAM_ROW);
  documentMetaCreateMock.mockReset().mockResolvedValue({ id: 'meta_1' });
  getTeamSettingsMock.mockReset().mockResolvedValue(TEAM_SETTINGS);
  incrementDocumentIdMock.mockReset().mockResolvedValue({ documentId: 1, formattedDocumentId: 123 });
  incrementTemplateIdMock.mockReset();
  triggerWebhookMock.mockReset().mockResolvedValue(undefined);
  mapEnvelopeToWebhookDocumentPayloadMock.mockReset().mockImplementation((envelope: unknown) => envelope);
  zWebhookDocumentSchemaParseMock.mockReset().mockImplementation((payload: unknown) => payload);

  txEnvelopeCreateMock.mockReset().mockResolvedValue({
    id: ENVELOPE_ID,
    envelopeItems: [{ id: 'envelope_item_1', documentDataId: 'docdata_1' }],
  });
  txEnvelopeFindFirstMock.mockReset().mockResolvedValue({ id: ENVELOPE_ID, title: 'Test Document' });
  txDocumentAuditLogCreateMock.mockReset().mockResolvedValue({});

  transactionMock.mockReset().mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      envelope: {
        create: txEnvelopeCreateMock,
        findFirst: txEnvelopeFindFirstMock,
      },
      documentAuditLog: {
        create: txDocumentAuditLogCreateMock,
      },
    }),
  );
});

describe('createEnvelope — senderVerification (DEV-8741)', () => {
  it('create-without: no senderVerification writes only the DOCUMENT_CREATED audit log (byte-identical to pre-DEV-8741 behaviour)', async () => {
    await createEnvelope(baseCreateEnvelopeOptions());

    expect(txDocumentAuditLogCreateMock).toHaveBeenCalledTimes(1);

    const [[{ data: auditLogData }]] = txDocumentAuditLogCreateMock.mock.calls;
    expect(auditLogData.type).toBe('DOCUMENT_CREATED');
    expect(auditLogData.envelopeId).toBe(ENVELOPE_ID);
  });

  it('create-with-metadata: writes a second DOCUMENT_SENDER_IDENTITY_VERIFIED audit row carrying the verification metadata', async () => {
    const options = baseCreateEnvelopeOptions();
    options.data = {
      ...options.data,
      senderVerification: {
        contact: 'sender@example.com',
        method: 'email',
        verifiedAt: '2026-08-14T18:29:00.000Z',
        ipAddress: '203.0.113.7',
      },
    };

    await createEnvelope(options);

    expect(txDocumentAuditLogCreateMock).toHaveBeenCalledTimes(2);

    const calls = txDocumentAuditLogCreateMock.mock.calls.map(([arg]) => arg.data);

    expect(calls[0].type).toBe('DOCUMENT_CREATED');

    expect(calls[1].type).toBe('DOCUMENT_SENDER_IDENTITY_VERIFIED');
    expect(calls[1].envelopeId).toBe(ENVELOPE_ID);
    expect(calls[1].data).toEqual({
      contact: 'sender@example.com',
      method: 'email',
      verifiedAt: '2026-08-14T18:29:00.000Z',
      ipAddress: '203.0.113.7',
    });
  });

  it('create-with-metadata: ipAddress is optional and normalizes to null when omitted', async () => {
    const options = baseCreateEnvelopeOptions();
    options.data = {
      ...options.data,
      senderVerification: {
        contact: '+15551234567',
        method: 'sms',
        verifiedAt: '2026-08-14T18:29:00.000Z',
      },
    };

    await createEnvelope(options);

    const calls = txDocumentAuditLogCreateMock.mock.calls.map(([arg]) => arg.data);
    const senderVerifiedCall = calls.find((c) => c.type === 'DOCUMENT_SENDER_IDENTITY_VERIFIED');

    expect(senderVerifiedCall.data).toEqual({
      contact: '+15551234567',
      method: 'sms',
      verifiedAt: '2026-08-14T18:29:00.000Z',
      ipAddress: null,
    });
  });
});
