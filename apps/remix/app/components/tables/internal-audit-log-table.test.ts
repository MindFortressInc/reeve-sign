import { DOCUMENT_AUDIT_LOG_TYPE, type TDocumentAuditLog } from '@documenso/lib/types/document-audit-logs';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { InternalAuditLogTable } from './internal-audit-log-table';

// DEV-9179. No catalog is loaded, so `_(descriptor)` falls back to each
// message's source text -- the same code path the app takes, without a
// compiled catalog. Mirrors packages/lib/server-only/pdf/render-certificate.test.ts.
const i18n = setupI18n({ locale: 'en', messages: { en: {} } });

const buildAuditLog = (type: string, data: unknown): TDocumentAuditLog =>
  ({
    id: 'audit_log_1',
    createdAt: new Date('2026-08-14T18:29:00.000Z'),
    envelopeId: 'envelope_1',
    name: null,
    email: 'signer@example.com',
    userId: null,
    userAgent: null,
    ipAddress: '203.0.113.4',
    type,
    data,
  }) as unknown as TDocumentAuditLog;

const renderTable = (logs: TDocumentAuditLog[]) =>
  renderToStaticMarkup(createElement(I18nProvider, { i18n }, createElement(InternalAuditLogTable, { logs })));

describe('InternalAuditLogTable', () => {
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
    const markup = renderTable([buildAuditLog(type, data)]);

    expect(markup).toContain(expectedHeading);
  });

  it('never prints the raw enum name as the row heading', () => {
    const markup = renderTable([
      buildAuditLog(DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED, {
        contact: 'sender@example.com',
        method: 'email',
        verifiedAt: '2026-08-14T18:29:00.000Z',
      }),
    ]);

    expect(markup).not.toContain('DOCUMENT SENDER IDENTITY VERIFIED');
    expect(markup).not.toContain('DOCUMENT_SENDER_IDENTITY_VERIFIED');
  });

  // The heading is `uppercase` in CSS, so a sentence-case label would still be
  // shouted at the reader -- and for this event it would still read "VERIFIED"
  // over a description that says it is not independently verified (DEV-9003).
  it('does not force the heading to uppercase', () => {
    const markup = renderTable([buildAuditLog(DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENT, {})]);

    const headingClasses = /class="([^"]*tracking-wide[^"]*)"/.exec(markup)?.[1] ?? '';

    expect(headingClasses).not.toContain('uppercase');
  });
});
