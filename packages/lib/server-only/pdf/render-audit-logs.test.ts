import { setupI18n } from '@lingui/core';
import type Konva from 'konva';
import { describe, expect, it } from 'vitest';

import type { TDocumentAuditLog } from '../../types/document-audit-logs';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { renderRow } from './render-audit-logs';

// DEV-9179. `i18n` is a real I18n instance with no catalog loaded, so
// `i18n._(descriptor)` falls back to each message's source text -- the same
// code path `generate-audit-log-pdf.ts` uses in production, without pulling in
// a compiled translation catalog. Mirrors render-certificate.test.ts.
const i18n = setupI18n({ locale: 'en', messages: { en: {} } });

const buildAuditLog = (type: string, data: unknown, email: string | null = 'signer@example.com'): TDocumentAuditLog =>
  ({
    id: 'audit_log_1',
    createdAt: new Date('2026-08-14T18:29:00.000Z'),
    envelopeId: 'envelope_1',
    name: null,
    email,
    userId: null,
    userAgent: null,
    ipAddress: '203.0.113.4',
    type,
    data,
  }) as unknown as TDocumentAuditLog;

/** Every string the rendered row actually puts in front of a reader. */
const renderRowText = (auditLog: TDocumentAuditLog): string[] =>
  renderRow({ auditLog, width: 500, i18n })
    .find('Text')
    .map((node) => (node as Konva.Text).text());

describe('renderRow (Audit Log PDF)', () => {
  it.each([
    [
      DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED,
      { contact: 'sender@example.com', method: 'email', verifiedAt: '2026-08-14T18:29:00.000Z' },
      'Sender contact attested',
    ],
    [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENT, {}, 'Document sent'],
    [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_OPENED, {}, 'Document opened'],
    [
      DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED,
      { fieldId: 'field_1', field: { type: 'SIGNATURE', data: '' }, fieldSecurity: { type: 'NONE' } },
      'Field signed',
    ],
    [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_FAILED, {}, '2FA token validation failed'],
    [
      DOCUMENT_AUDIT_LOG_TYPE.ENVELOPE_ITEM_PDF_REPLACED,
      { envelopeItemId: 'item_1', envelopeItemTitle: 'Lease.pdf' },
      'Envelope item PDF replaced',
    ],
  ])('heads the %s row with its translated label', (type, data, expectedHeading) => {
    const text = renderRowText(buildAuditLog(type, data));

    expect(text).toContain(expectedHeading);
  });

  it('never prints the raw enum name as the row heading', () => {
    const text = renderRowText(
      buildAuditLog(DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED, {
        contact: 'sender@example.com',
        method: 'email',
        verifiedAt: '2026-08-14T18:29:00.000Z',
      }),
    );

    expect(text).not.toContain('DOCUMENT SENDER IDENTITY VERIFIED');
    expect(text).not.toContain('DOCUMENT_SENDER_IDENTITY_VERIFIED');
  });

  // The heading used to read "...VERIFIED" while the sentence rendered directly
  // beneath it retracts exactly that (DEV-9003). Both strings are on the same
  // legal page, so they have to agree.
  it('does not contradict the sender-attested description printed beneath it', () => {
    const text = renderRowText(
      // No actor on the row, so `formatDocumentAuditLogAction` picks the
      // anonymous description -- the shared DEV-9003 descriptor.
      buildAuditLog(
        DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED,
        { contact: 'sender@example.com', method: 'email', verifiedAt: '2026-08-14T18:29:00.000Z' },
        null,
      ),
    );

    expect(text).toContain('Sender-attested contact verification (not independently verified)');
    expect(text.some((line) => /verified/i.test(line) && !/not independently verified/i.test(line))).toBe(false);
  });
});
