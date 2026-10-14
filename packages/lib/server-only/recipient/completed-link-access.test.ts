import { DocumentStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { COMPLETED_LINK_TTL_DAYS, canViewCompletedLink, isCompletedLinkExpired } from './completed-link-access';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-14T12:00:00.000Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);

const owner = { id: 1, email: 'owner@example.com' };
const recipientEmail = 'Signer@Example.com';

const base = { now, recipientEmail, ownerId: owner.id, status: DocumentStatus.COMPLETED };

describe('completed-link-access', () => {
  it('uses a 7-day window', () => {
    expect(COMPLETED_LINK_TTL_DAYS).toBe(7);
  });

  it('never expires a link whose envelope has not completed', () => {
    expect(isCompletedLinkExpired({ status: DocumentStatus.PENDING, completedAt: null, now })).toBe(false);
    expect(
      canViewCompletedLink({ ...base, status: DocumentStatus.PENDING, completedAt: null, sessionUser: null }),
    ).toBe(true);
  });

  it('treats a completed envelope with no completedAt (legacy row) as expired', () => {
    expect(isCompletedLinkExpired({ status: DocumentStatus.COMPLETED, completedAt: null, now })).toBe(true);
    expect(
      canViewCompletedLink({ ...base, status: DocumentStatus.COMPLETED, completedAt: null, sessionUser: null }),
    ).toBe(false);
    expect(
      canViewCompletedLink({ ...base, status: DocumentStatus.COMPLETED, completedAt: null, sessionUser: owner }),
    ).toBe(true);
  });

  it('lets anyone holding the link view it within 7 days of completion', () => {
    expect(canViewCompletedLink({ ...base, completedAt: daysAgo(0), sessionUser: null })).toBe(true);
    expect(canViewCompletedLink({ ...base, completedAt: daysAgo(6), sessionUser: null })).toBe(true);
    expect(canViewCompletedLink({ ...base, completedAt: daysAgo(7), sessionUser: null })).toBe(true);
  });

  it('expires the link for an anonymous viewer after 7 days', () => {
    expect(isCompletedLinkExpired({ status: DocumentStatus.COMPLETED, completedAt: daysAgo(8), now })).toBe(true);
    expect(canViewCompletedLink({ ...base, completedAt: new Date(daysAgo(7).getTime() - 1), sessionUser: null })).toBe(
      false,
    );
    expect(canViewCompletedLink({ ...base, completedAt: daysAgo(8), sessionUser: null })).toBe(false);
  });

  it('expires the link for a signed-in stranger after 7 days', () => {
    expect(
      canViewCompletedLink({
        ...base,
        completedAt: daysAgo(8),
        sessionUser: { id: 99, email: 'stranger@example.com' },
      }),
    ).toBe(false);
  });

  it('keeps the link open for the document owner after 7 days', () => {
    expect(canViewCompletedLink({ ...base, completedAt: daysAgo(8), sessionUser: owner })).toBe(true);
  });

  it('keeps the link open for the recipient, matching email case-insensitively', () => {
    expect(
      canViewCompletedLink({ ...base, completedAt: daysAgo(400), sessionUser: { id: 2, email: 'signer@example.COM' } }),
    ).toBe(true);
  });
});
