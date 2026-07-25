/**
 * Route the consent gate never redirects away from — avoids a redirect loop
 * (DEV-2837).
 *
 * Lives in this client-safe (non-`.server`) module so it can be shared by
 * both the server-only gate logic (`consent-gate.server.ts`) and the
 * authenticated layout's client-side `shouldRevalidate`
 * (`routes/_authenticated+/_layout.tsx`). The layout must re-run the gate
 * when a not-yet-accepted user tries to client-navigate away from this page,
 * and `shouldRevalidate` runs in the browser bundle where a `.server` import
 * isn't available.
 */
export const CONSENT_GATE_ROUTE_PATH = '/legal-consent';

/**
 * Whether the authenticated layout loader (and therefore the consent gate)
 * must re-run for a client-side navigation from `currentUrl` to `nextUrl`.
 *
 * The layout otherwise opts out of revalidation entirely for speed. The one
 * case we cannot skip is leaving the consent page: a not-yet-accepted user is
 * parked on `/legal-consent`, and every in-app `<Link>` is an SPA navigation
 * that would otherwise reuse the parent loader's cached data and never re-run
 * the gate — letting them reach protected routes without accepting. Forcing a
 * revalidation on the way *out* of the consent page re-runs the gate, which
 * bounces an un-accepted user straight back.
 *
 * Kept as a pure, client-safe function (no request/loader deps) so it can be
 * unit-tested in isolation and shared by the layout's `shouldRevalidate`.
 */
export const shouldRevalidateConsentGate = ({
  currentPathname,
  nextPathname,
}: {
  currentPathname: string;
  nextPathname: string;
}): boolean => {
  return currentPathname === CONSENT_GATE_ROUTE_PATH && nextPathname !== CONSENT_GATE_ROUTE_PATH;
};
