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
