import { setupI18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';

import { ZDocumentAuditLogTypeSchema } from '../types/document-audit-logs';
import { getDocumentAuditLogTypeLabel } from './document-audit-logs';

// No catalog loaded, so `_()` falls back to each message's source text.
const i18n = setupI18n({ locale: 'en', messages: { en: {} } });

const ALL_TYPES = ZDocumentAuditLogTypeSchema.options;

describe('getDocumentAuditLogTypeLabel', () => {
  it('covers every DOCUMENT_AUDIT_LOG_TYPE with a readable label', () => {
    for (const type of ALL_TYPES) {
      const label = i18n._(getDocumentAuditLogTypeLabel(type));

      expect(label, type).toBeTruthy();
      // The bug: the heading was the raw SCREAMING_SNAKE enum, or that enum
      // with its underscores swapped for spaces.
      expect(label, type).not.toBe(type);
      expect(label, type).not.toBe(type.replace(/_/g, ' '));
      expect(label, type).not.toMatch(/_/);
      expect(label, type).not.toBe(label.toUpperCase());
    }
  });

  it('gives every type a distinct label', () => {
    const labels = ALL_TYPES.map((type) => i18n._(getDocumentAuditLogTypeLabel(type)));

    expect(new Set(labels).size).toBe(ALL_TYPES.length);
  });

  it('does not assert sender verification the description underneath retracts', () => {
    // DEV-9003/DEV-9179: the enum is named ..._VERIFIED, but the row's
    // description says the contact is sender-attested and NOT independently
    // verified. The heading must not claim otherwise.
    const label = i18n._(getDocumentAuditLogTypeLabel('DOCUMENT_SENDER_IDENTITY_VERIFIED'));

    expect(label).toBe('Sender contact attested');
    expect(label).not.toMatch(/verified/i);
  });

  it('falls back to the humanised enum for a type no longer in the schema', () => {
    // Unreachable for a current type (the map is exhaustive at compile time),
    // but a historic row must degrade rather than print `undefined` on a PDF.
    const label = i18n._(getDocumentAuditLogTypeLabel('DOCUMENT_LEGACY_REMOVED_EVENT' as never));

    expect(label).toBe('DOCUMENT LEGACY REMOVED EVENT');
  });
});
