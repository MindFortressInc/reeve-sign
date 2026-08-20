import { describe, expect, it } from 'vitest';

import { ZCreateDocumentMutationSchema, ZSenderVerificationSchema } from './schema';

// DEV-8741: optional sender identity-verification metadata on the v1
// create-document body. Additive -- omitting it entirely must stay valid
// (every caller before this change), and the field itself is zod-validated:
// contact, method (email|sms), verifiedAt (ISO-8601), optional ip.

const MINIMAL_BODY = {
  title: 'Test Document',
  recipients: [{ name: 'Signer One', email: 'signer@example.com' }],
};

describe('ZCreateDocumentMutationSchema — senderVerification (additive, optional)', () => {
  it('parses a body with no senderVerification at all (every existing caller)', () => {
    const result = ZCreateDocumentMutationSchema.safeParse(MINIMAL_BODY);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.senderVerification).toBeUndefined();
    }
  });

  it('parses a body with a fully-specified email senderVerification', () => {
    const result = ZCreateDocumentMutationSchema.safeParse({
      ...MINIMAL_BODY,
      senderVerification: {
        contact: 'sender@example.com',
        method: 'email',
        verifiedAt: '2026-08-14T18:29:00.000Z',
        ipAddress: '203.0.113.7',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.senderVerification).toEqual({
        contact: 'sender@example.com',
        method: 'email',
        verifiedAt: '2026-08-14T18:29:00.000Z',
        ipAddress: '203.0.113.7',
      });
    }
  });

  it('parses an sms senderVerification without ipAddress (ipAddress is optional)', () => {
    const result = ZCreateDocumentMutationSchema.safeParse({
      ...MINIMAL_BODY,
      senderVerification: {
        contact: '+15551234567',
        method: 'sms',
        verifiedAt: '2026-08-14T18:29:00.000Z',
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown verification method', () => {
    const result = ZCreateDocumentMutationSchema.safeParse({
      ...MINIMAL_BODY,
      senderVerification: {
        contact: 'sender@example.com',
        method: 'carrier-pigeon',
        verifiedAt: '2026-08-14T18:29:00.000Z',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO-8601 verifiedAt', () => {
    const result = ZCreateDocumentMutationSchema.safeParse({
      ...MINIMAL_BODY,
      senderVerification: {
        contact: 'sender@example.com',
        method: 'email',
        verifiedAt: 'yesterday afternoon',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects an empty contact', () => {
    const result = ZSenderVerificationSchema.safeParse({
      contact: '',
      method: 'email',
      verifiedAt: '2026-08-14T18:29:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a senderVerification missing verifiedAt', () => {
    const result = ZSenderVerificationSchema.safeParse({
      contact: 'sender@example.com',
      method: 'email',
    });

    expect(result.success).toBe(false);
  });

  it('rejects method: email with a contact that is not an email', () => {
    const result = ZSenderVerificationSchema.safeParse({
      contact: '+15551234567',
      method: 'email',
      verifiedAt: '2026-08-14T18:29:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('rejects method: sms with a contact that is not E.164', () => {
    const result = ZSenderVerificationSchema.safeParse({
      contact: 'sender@example.com',
      method: 'sms',
      verifiedAt: '2026-08-14T18:29:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('rejects method: sms with a phone number missing the leading +', () => {
    const result = ZSenderVerificationSchema.safeParse({
      contact: '15551234567',
      method: 'sms',
      verifiedAt: '2026-08-14T18:29:00.000Z',
    });

    expect(result.success).toBe(false);
  });
});
