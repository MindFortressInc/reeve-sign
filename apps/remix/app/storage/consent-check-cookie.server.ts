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
 * Pattern mirrors the existing `lang-cookie.server.ts`.
 */
export const consentCheckCookie = createCookie('reeve-consent-ok', {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: env('NODE_ENV') === 'production',
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
