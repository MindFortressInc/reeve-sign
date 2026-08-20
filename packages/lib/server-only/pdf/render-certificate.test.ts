import { describe, expect, it } from 'vitest';

import { formatSenderVerificationValue } from './render-certificate';

// DEV-8741: pure formatting for the sender OTP identity-verification line
// shown on the certificate footer. Deliberately has no lingui/Konva/
// skia-canvas dependency (see the docstring on the function) so it's
// testable without the rendering pipeline; the actual PDF rendering (block
// present/absent) is verified separately via a rendered artifact -- see
// PR description / DEV-8741 notes.

describe('formatSenderVerificationValue', () => {
  it('formats an email verification with contact, method, and a formatted timestamp', () => {
    const result = formatSenderVerificationValue({
      contact: 'sender@example.com',
      method: 'email',
      verifiedAt: '2026-08-14T18:29:00.000Z',
    });

    expect(result).toContain('sender@example.com');
    expect(result).toContain('Email OTP');
    expect(result).toContain('2026-08-14');
  });

  it('formats an sms verification with the SMS label', () => {
    const result = formatSenderVerificationValue({
      contact: '+15551234567',
      method: 'sms',
      verifiedAt: '2026-08-14T18:29:00.000Z',
    });

    expect(result).toContain('+15551234567');
    expect(result).toContain('SMS OTP');
  });

  it('falls back to the raw string for an unparseable verifiedAt rather than throwing', () => {
    const result = formatSenderVerificationValue({
      contact: 'sender@example.com',
      method: 'email',
      verifiedAt: 'not-a-real-timestamp',
    });

    expect(result).toContain('not-a-real-timestamp');
  });
});
