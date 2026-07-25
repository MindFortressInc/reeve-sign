import { describe, expect, it } from 'vitest';

import { CONSENT_GATE_ROUTE_PATH, shouldRevalidateConsentGate } from './consent-gate-route';

/**
 * Regression coverage for DEV-4781: the consent gate lives in the
 * authenticated layout loader, which otherwise opts out of revalidation. If
 * the loader is skipped when a not-yet-accepted user client-navigates *away*
 * from `/legal-consent`, they reach protected routes without accepting. The
 * layout's `shouldRevalidate` delegates entirely to this pure function, so
 * asserting its truth table here locks the SPA-navigation bypass shut.
 */
describe('shouldRevalidateConsentGate', () => {
  it('revalidates when navigating away from the consent page (the bypass path)', () => {
    expect(
      shouldRevalidateConsentGate({
        currentPathname: CONSENT_GATE_ROUTE_PATH,
        nextPathname: '/documents',
      }),
    ).toBe(true);
  });

  it('revalidates for any protected destination, not just one', () => {
    for (const nextPathname of ['/', '/settings', '/t/acme/documents', '/o/acme/settings/members']) {
      expect(
        shouldRevalidateConsentGate({
          currentPathname: CONSENT_GATE_ROUTE_PATH,
          nextPathname,
        }),
      ).toBe(true);
    }
  });

  it('does not revalidate while staying on the consent page', () => {
    expect(
      shouldRevalidateConsentGate({
        currentPathname: CONSENT_GATE_ROUTE_PATH,
        nextPathname: CONSENT_GATE_ROUTE_PATH,
      }),
    ).toBe(false);
  });

  it('does not revalidate for navigations that never touched the consent page', () => {
    expect(
      shouldRevalidateConsentGate({
        currentPathname: '/documents',
        nextPathname: '/settings',
      }),
    ).toBe(false);
  });

  it('does not force revalidation when arriving *at* the consent page', () => {
    // The gate itself redirects here on a real load; the fast no-revalidate
    // path is correct for an accepted user who is never parked on this page.
    expect(
      shouldRevalidateConsentGate({
        currentPathname: '/documents',
        nextPathname: CONSENT_GATE_ROUTE_PATH,
      }),
    ).toBe(false);
  });
});
