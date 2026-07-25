import { env } from '@documenso/lib/utils/env';
import { createCookie } from 'react-router';

/**
 * Caches a *positive* Reeve.Compliance consent-status result so the
 * authenticated layout loader (`routes/_authenticated+/_layout.tsx`) doesn't
 * call `GET /api/compliance/v1/consent/status` on every single request
 * (DEV-2837).
 *
 * The cookie value records the subject_id (user email) that was confirmed as
 * fully accepted *and* the exact doc_type → version map they accepted — not
 * just a boolean, and not the subject alone. Keying on version matters
 * (DEV-4781): a subject-only cache meant a mid-session ToS/Privacy version
 * bump (or a newly-required doc_type) would never re-prompt, because the
 * stale cookie kept matching. Now the gate re-checks whenever the cached
 * version map no longer covers every currently-required doc_type.
 *
 * A bounded `maxAge` is the second half of that fix: the app can't learn
 * about a server-side *version bump of an existing doc_type* without asking
 * the compliance API, so the cache is trusted for at most
 * `CONSENT_CACHE_MAX_AGE_SECONDS`, after which the gate re-validates against
 * the live status endpoint and re-prompts if the accepted version is now
 * stale. This turns "never re-prompts this browser session" into "re-prompts
 * within the TTL window" while still keeping the status endpoint off the hot
 * path for the vast majority of navigations.
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

/**
 * How long a positive consent result is trusted before the gate re-checks the
 * compliance API. One hour bounds the re-prompt latency after a version bump
 * without putting the status endpoint on every navigation.
 */
export const CONSENT_CACHE_MAX_AGE_SECONDS = 60 * 60;

const authSecret = env('NEXTAUTH_SECRET');

export const consentCheckCookie = createCookie('reeve-consent-ok', {
  path: '/',
  maxAge: CONSENT_CACHE_MAX_AGE_SECONDS,
  httpOnly: true,
  sameSite: 'lax',
  secure: env('NODE_ENV') === 'production',
  secrets: authSecret ? [authSecret] : [],
});

/**
 * Persisted shape of the consent cache cookie. `versions` maps each accepted
 * doc_type to the version that was confirmed current at cache time.
 */
export type CachedConsent = {
  subjectId: string;
  versions: Record<string, string>;
};

/**
 * Serializes a `Set-Cookie` header caching the given positive consent result.
 */
export const serializeConsentCache = (cached: CachedConsent): Promise<string> => {
  return consentCheckCookie.serialize(cached);
};

const isCachedConsent = (value: unknown): value is CachedConsent => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (typeof candidate.subjectId !== 'string' || candidate.subjectId.length === 0) {
    return false;
  }

  if (typeof candidate.versions !== 'object' || candidate.versions === null) {
    return false;
  }

  return Object.values(candidate.versions as Record<string, unknown>).every((v) => typeof v === 'string');
};

/**
 * Returns the parsed consent cache on this request, or `null` if there is no
 * cookie, it fails to verify/parse, or it doesn't match the expected shape.
 */
export const getCachedConsent = async (request: Request): Promise<CachedConsent | null> => {
  const cookieHeader = request.headers.get('cookie');

  if (!cookieHeader) {
    return null;
  }

  const value: unknown = await consentCheckCookie.parse(cookieHeader).catch(() => null);

  return isCachedConsent(value) ? value : null;
};
