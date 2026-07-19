import { env } from '@documenso/lib/utils/env';
import { createCookie } from 'react-router';

/**
 * Caches a *positive* Reeve.Compliance consent-status result for the rest
 * of the browser session, so the authenticated layout loader
 * (`routes/_authenticated+/_layout.tsx`) doesn't call
 * `GET /api/compliance/v1/consent/status` on every single request (DEV-2837).
 *
 * The cookie value is the subject_id (user email) that was last confirmed
 * as fully accepted — not just a boolean — so that if a different user logs
 * in on the same browser, the stale cookie doesn't wrongly skip their check.
 * No `maxAge`/`expires` is set: this is a session cookie, matching "at most
 * once per session" literally (it's gone once the browser session ends).
 *
 * `secrets` is REQUIRED here (deep-review finding, DEV-2837): without it,
 * `createCookie` falls back to plain reversible base64 encoding, which
 * would let a user forge `reeve-consent-ok=<base64 of their own email>` and
 * permanently skip both the redirect to `/legal-consent` and the remote
 * status check — this cookie is the sole gate enforcement point, so an
 * unsigned value is a full, self-service bypass. Signed with the same
 * `NEXTAUTH_SECRET` the session cookie itself uses (`packages/auth/server/lib/session/session-cookies.ts`),
 * matching that existing precedent. `checkConsentGate` is only reached
 * after `session.isAuthenticated`, which already required a valid
 * `NEXTAUTH_SECRET` to verify the session cookie — so this never runs with
 * an unset secret in a working deployment.
 *
 * Pattern otherwise mirrors the existing `lang-cookie.server.ts`.
 */
const authSecret = env('NEXTAUTH_SECRET');

export const consentCheckCookie = createCookie('reeve-consent-ok', {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: env('NODE_ENV') === 'production',
  secrets: authSecret ? [authSecret] : [],
});

/**
 * Returns the subject_id cached as "consent OK" on this request, or `null`
 * if there is no cookie (or it fails to parse).
 */
export const getCachedConsentSubjectId = async (request: Request): Promise<string | null> => {
  const cookieHeader = request.headers.get('cookie');

  if (!cookieHeader) {
    return null;
  }

  const value: unknown = await consentCheckCookie.parse(cookieHeader).catch(() => null);

  return typeof value === 'string' && value.length > 0 ? value : null;
};
