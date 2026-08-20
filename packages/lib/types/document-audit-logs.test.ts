import { describe, expect, it } from 'vitest';

import { DOCUMENT_AUDIT_LOG_TYPE, ZDocumentAuditLogSchema, ZDocumentAuditLogTypeSchema } from './document-audit-logs';

// DEV-8741: sender OTP identity-verification event on the signing
// certificate. These tests cover the new enum member and its data schema in
// isolation -- no Konva/skia-canvas rendering or Prisma involved.

const BASE_LOG_FIELDS = {
  id: 'audit_log_1',
  createdAt: new Date('2026-08-14T18:30:00.000Z'),
  envelopeId: 'envelope_1',
};

describe('DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED', () => {
  it('is a member of the audit log type enum', () => {
    expect(DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED).toBe('DOCUMENT_SENDER_IDENTITY_VERIFIED');
    expect(ZDocumentAuditLogTypeSchema.safeParse('DOCUMENT_SENDER_IDENTITY_VERIFIED').success).toBe(true);
  });

  it('validates a full event: contact, method, verifiedAt, ipAddress', () => {
    const result = ZDocumentAuditLogSchema.safeParse({
      ...BASE_LOG_FIELDS,
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED,
      data: {
        contact: 'sender@example.com',
        method: 'email',
        verifiedAt: '2026-08-14T18:29:00.000Z',
        ipAddress: '203.0.113.7',
      },
    });

    expect(result.success).toBe(true);

    if (result.success && result.data.type === DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED) {
      expect(result.data.data).toEqual({
        contact: 'sender@example.com',
        method: 'email',
        verifiedAt: '2026-08-14T18:29:00.000Z',
        ipAddress: '203.0.113.7',
      });
    } else {
      expect.unreachable('parsed result should be a DOCUMENT_SENDER_IDENTITY_VERIFIED event');
    }
  });

  it('validates an sms-method event without ipAddress (nullish, not required)', () => {
    const result = ZDocumentAuditLogSchema.safeParse({
      ...BASE_LOG_FIELDS,
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED,
      data: {
        contact: '+15551234567',
        method: 'sms',
        verifiedAt: '2026-08-14T18:29:00.000Z',
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown verification method', () => {
    const result = ZDocumentAuditLogSchema.safeParse({
      ...BASE_LOG_FIELDS,
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED,
      data: {
        contact: 'sender@example.com',
        method: 'fax',
        verifiedAt: '2026-08-14T18:29:00.000Z',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a payload missing contact', () => {
    const result = ZDocumentAuditLogSchema.safeParse({
      ...BASE_LOG_FIELDS,
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED,
      data: {
        method: 'email',
        verifiedAt: '2026-08-14T18:29:00.000Z',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a payload missing verifiedAt', () => {
    const result = ZDocumentAuditLogSchema.safeParse({
      ...BASE_LOG_FIELDS,
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED,
      data: {
        contact: 'sender@example.com',
        method: 'email',
      },
    });

    expect(result.success).toBe(false);
  });
});
