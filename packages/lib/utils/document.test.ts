import type { OrganisationGlobalSettings } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { DEFAULT_DOCUMENT_TIME_ZONE } from '../constants/time-zones';
import { extractDerivedDocumentMeta } from './document';

// DEV-15771: the API v1 create path now leaves an omitted timezone undefined.
// The persisted DocumentMeta.timezone must still resolve meta -> team/org
// setting -> UTC, so a team with no setting keeps today's UTC stamp.

const settings = (documentTimezone: string | null) =>
  ({ documentTimezone, documentDateFormat: 'yyyy-MM-dd hh:mm a' }) as unknown as Omit<
    OrganisationGlobalSettings,
    'id'
  >;

describe('extractDerivedDocumentMeta timezone (DEV-15771)', () => {
  it('no meta, no setting -> UTC', () => {
    expect(extractDerivedDocumentMeta(settings(null), { timezone: undefined }).timezone).toBe(
      DEFAULT_DOCUMENT_TIME_ZONE,
    );
  });

  it('no meta -> the team/org setting', () => {
    expect(extractDerivedDocumentMeta(settings('America/Los_Angeles'), {}).timezone).toBe('America/Los_Angeles');
  });

  it('meta beats the setting', () => {
    expect(extractDerivedDocumentMeta(settings('Europe/London'), { timezone: 'America/Los_Angeles' }).timezone).toBe(
      'America/Los_Angeles',
    );
  });
});
