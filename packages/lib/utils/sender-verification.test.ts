import { setupI18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';

import { formatSenderVerificationValue } from './sender-verification';

// DEV-8741: pure formatting for the sender OTP identity-verification line
// shown on the certificate footer. Deliberately has no Konva/skia-canvas
// dependency (see the docstring on the function) so it's testable without
// the rendering pipeline; the actual PDF rendering (block present/absent) is
// verified separately via a rendered artifact -- see PR description /
// DEV-8741 notes.
//
// DEV-9178: moved here with the function, which the Audit Log PDF row now
// composes too (utils/document-audit-logs.ts) -- it is no longer the
// certificate's alone. `i18n` is a real I18n instance with no catalog loaded, so
// `i18n._(msg\`...\`)` falls back to each message's id -- identical to its
// English source text -- exercising the same code path
// `generate-certificate-pdf.ts` uses in production without pulling in a
// compiled translation catalog.
const i18n = setupI18n({ locale: 'en', messages: { en: {} } });

describe('formatSenderVerificationValue', () => {
  it('formats an email verification with contact, method, and a formatted timestamp', () => {
    const result = formatSenderVerificationValue(
      {
        contact: 'sender@example.com',
        method: 'email',
        verifiedAt: '2026-08-14T18:29:00.000Z',
      },
      i18n,
    );

    expect(result).toContain('sender@example.com');
    expect(result).toContain('Email OTP');
    expect(result).toContain('2026-08-14');
  });

  it('formats an sms verification with the SMS label', () => {
    const result = formatSenderVerificationValue(
      {
        contact: '+15551234567',
        method: 'sms',
        verifiedAt: '2026-08-14T18:29:00.000Z',
      },
      i18n,
    );

    expect(result).toContain('+15551234567');
    expect(result).toContain('SMS OTP');
  });

  it('falls back to the raw string for an unparseable verifiedAt rather than throwing', () => {
    const result = formatSenderVerificationValue(
      {
        contact: 'sender@example.com',
        method: 'email',
        verifiedAt: 'not-a-real-timestamp',
      },
      i18n,
    );

    expect(result).toContain('not-a-real-timestamp');
  });
});
