import { readFileSync } from 'node:fs';
import { setupI18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { describe, expect, it } from 'vitest';

import type { TDocumentAuditLog } from '../types/document-audit-logs';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../types/document-audit-logs';
import { formatDocumentAuditLogAction } from './document-audit-logs';

// DEV-9003: the DOCUMENT_SENDER_IDENTITY_VERIFIED activity message is
// user-visible text on a legal document -- it is rendered into the signing
// certificate PDF's audit-log table (server-only/pdf/render-audit-logs.ts) as
// well as the web activity tables. Its wording must stay consistent with the
// certificate footer written by server-only/pdf/render-certificate.ts, which
// deliberately says "sender-attested" rather than "verified" because the
// server holds no proof the OTP actually happened (DEV-8975).

/**
 * The certificate footer's message, declared with the same macro call
 * render-certificate.ts uses. `.message` is the msgid written to the
 * catalogs; `.id` is the generated key `lingui compile` maps translations to.
 */
const certificateFooterMessage = msg`Sender-attested contact verification (not independently verified)`;

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

/** No user attribution on the row, so the anonymous variant is selected. */
const ANONYMOUS_LOG: TDocumentAuditLog = {
  ...SENDER_IDENTITY_VERIFIED_EVENT,
  name: null,
  email: null,
  userId: null,
};

/** Attributed row, so the `you` / `user` variants are selected instead. */
const ATTRIBUTED_LOG: TDocumentAuditLog = {
  ...SENDER_IDENTITY_VERIFIED_EVENT,
  name: 'Ada Lovelace',
  email: 'sender@example.com',
  userId: 42,
};

/**
 * Reads a shipped translation straight out of a committed catalog, so the
 * "reuses the certificate msgid" claim is asserted against the real .po
 * rather than a hand-written fixture.
 */
const readTranslationFromCatalog = (locale: string, msgid: string): string => {
  const catalog = readFileSync(new URL(`../translations/${locale}/web.po`, import.meta.url), 'utf-8');
  const escaped = msgid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^msgid "${escaped}"\\nmsgstr "(.+)"$`, 'm').exec(catalog);

  if (!match) {
    throw new Error(`No translated msgstr for "${msgid}" in ${locale}/web.po`);
  }

  return match[1];
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

    const { description } = formatDocumentAuditLogAction(i18n, ANONYMOUS_LOG);

    expect(description).toBe('Sender-attested contact verification (not independently verified)');
    expect(description).not.toMatch(/\bcontact verified\b/);
  });

  it('renders the same wording the certificate footer uses', () => {
    const i18n = createI18n('en');

    const { description } = formatDocumentAuditLogAction(i18n, ANONYMOUS_LOG);

    expect(description).toBe(certificateFooterMessage.message);
  });

  it('reuses the certificate msgid, so the already-shipped translations resolve', () => {
    const germanTranslation = readTranslationFromCatalog('de', String(certificateFooterMessage.message));
    const i18n = createI18n('de', { [certificateFooterMessage.id]: germanTranslation });

    const { description } = formatDocumentAuditLogAction(i18n, ANONYMOUS_LOG);

    // Resolves to the real German string -- not a raw key, not empty.
    expect(description).toBe(germanTranslation);
    expect(description).not.toBe('');
    expect(description).not.toBe(certificateFooterMessage.id);
  });

  it('falls back to readable English when a locale has no translation yet', () => {
    const i18n = createI18n('de');

    const { description } = formatDocumentAuditLogAction(i18n, ANONYMOUS_LOG);

    expect(description).toBe('Sender-attested contact verification (not independently verified)');
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
