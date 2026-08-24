import { setupI18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';

import { getSenderAttestedContactVerificationMessage } from '../constants/document-audit-logs';
import type { TDocumentAuditLog } from '../types/document-audit-logs';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../types/document-audit-logs';
import { formatDocumentAuditLogAction } from './document-audit-logs';

// DEV-9003: the DOCUMENT_SENDER_IDENTITY_VERIFIED activity message is
// user-visible text on a legal document -- it is printed into the Audit Log
// PDF (server-only/pdf/render-audit-logs.ts) as well as the web activity
// tables. It must not assert a verification the server never performed:
// `senderVerification` is client-supplied and unproven until DEV-8975.
//
// NOTE: no CI job currently runs vitest (turbo.json has no `test` task and
// ci.yml runs only `npm run build`), so this is a local guard, not a merge
// gate. See the CI follow-up ticket linked from DEV-9003.

const EXPECTED_WORDING = 'Sender-attested contact verification (not independently verified)';

const SENDER_IDENTITY_VERIFIED_EVENT = {
  id: 'audit_log_1',
  createdAt: new Date('2026-08-14T18:30:00.000Z'),
  envelopeId: 'envelope_1',
  type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED,
  data: {
    contact: 'sender@example.com',
    method: 'email',
    verifiedAt: '2026-08-14T18:29:00.000Z',
    ipAddress: '203.0.113.7',
  },
} as const;

/**
 * The shape production actually writes: create-envelope.ts passes
 * `user: { id }` only, so `createDocumentAuditLogData` nulls name/email and
 * `formatDocumentAuditLogAction` selects the anonymous variant -- including
 * on the Audit Log PDF, which calls it with no `userId` argument.
 */
const PRODUCTION_LOG: TDocumentAuditLog = {
  ...SENDER_IDENTITY_VERIFIED_EVENT,
  name: null,
  email: null,
  userId: 42,
};

/** Hypothetical attributed row, exercising the `you` / `user` variants. */
const ATTRIBUTED_LOG: TDocumentAuditLog = {
  ...SENDER_IDENTITY_VERIFIED_EVENT,
  name: 'Ada Lovelace',
  email: 'sender@example.com',
  userId: 42,
};

const createI18n = (locale: string, messages: Record<string, string> = {}) => {
  const i18n = setupI18n();
  i18n.load(locale, messages);
  i18n.activate(locale);
  return i18n;
};

describe('formatDocumentAuditLogAction · DOCUMENT_SENDER_IDENTITY_VERIFIED', () => {
  it('describes the event as sender-attested, never as verified by us', () => {
    const i18n = createI18n('en');

    const { description } = formatDocumentAuditLogAction(i18n, PRODUCTION_LOG);

    expect(description).toBe(EXPECTED_WORDING);
    // The pre-DEV-9003 wording, and the looser claim it made.
    expect(description).not.toMatch(/contact verified/);
    expect(description).not.toMatch(/\bverified control of\b/);
  });

  it('renders the exact message the signing certificate uses, from the shared descriptor', () => {
    const i18n = createI18n('en');

    const { description } = formatDocumentAuditLogAction(i18n, PRODUCTION_LOG);

    // Asserted against the descriptor render-certificate.ts renders, so
    // changing the certificate wording alone cannot leave the two out of sync.
    const descriptor = getSenderAttestedContactVerificationMessage();

    expect(description).toBe(i18n._(descriptor));
    expect(descriptor.message).toBe(EXPECTED_WORDING);
  });

  it('resolves a translation rather than rendering a raw key or an empty string', () => {
    const germanWording = 'Vom Absender bestätigte Kontaktverifizierung (nicht unabhängig geprüft)';
    const messageId = getSenderAttestedContactVerificationMessage().id;

    expect(messageId).toBeTruthy();

    const i18n = createI18n('de', { [String(messageId)]: germanWording });

    const { description } = formatDocumentAuditLogAction(i18n, PRODUCTION_LOG);

    expect(description).toBe(germanWording);
    expect(description).not.toBe(messageId);
    expect(description).not.toBe('');
  });

  it('falls back to readable English when a locale has no translation yet', () => {
    const i18n = createI18n('de');

    const { description } = formatDocumentAuditLogAction(i18n, PRODUCTION_LOG);

    expect(description).toBe(EXPECTED_WORDING);
  });

  it('attributes the attestation to the viewer without asserting verification', () => {
    const i18n = createI18n('en');

    const { prefix, description } = formatDocumentAuditLogAction(i18n, ATTRIBUTED_LOG, 42);

    expect(prefix).toBe('You');
    expect(description).toBe('You attested control of sender@example.com (not independently verified)');
    expect(description).not.toMatch(/\bverified control of\b/);
  });

  it('attributes the attestation to a named sender without asserting verification', () => {
    const i18n = createI18n('en');

    const { description } = formatDocumentAuditLogAction(i18n, ATTRIBUTED_LOG, 7);

    expect(description).toBe('Ada Lovelace attested control of sender@example.com (not independently verified)');
    expect(description).not.toMatch(/\bverified control of\b/);
  });
});
