import type { SessionUser } from '@documenso/auth/server/lib/session/session';
import {
  getConsentStatus,
  IS_REEVE_COMPLIANCE_ENABLED,
  REEVE_COMPLIANCE_DOC_TYPES,
} from '@documenso/lib/server-only/compliance';
import { logger } from '@documenso/lib/utils/logger';

import { consentCheckCookie, getCachedConsentSubjectId } from '~/storage/consent-check-cookie.server';
import { CONSENT_GATE_ROUTE_PATH } from '~/utils/consent-gate-route';

// Re-exported for existing importers; the source of truth is the client-safe
// `consent-gate-route` module so the layout's `shouldRevalidate` can share it.
export { CONSENT_GATE_ROUTE_PATH };

/**
 * Discriminated union (deep-review finding, DEV-2837): a redirect and a
 * cache-write are mutually exclusive outcomes — the plain
 * `{ redirectTo: string | null; setCookieHeader: string | null }` shape
 * couldn't express that, leaving a "both set" case TypeScript wouldn't flag
 * even though no code path produces it.
 */
export type ConsentGateResult =
  | { type: 'noop' }
  | { type: 'redirect'; to: string }
  | { type: 'cache'; setCookieHeader: string };

const NO_ACTION: ConsentGateResult = { type: 'noop' };

/**
 * DEV-2837: gates authenticated access on ToS/Privacy acceptance via the
 * Reeve.Compliance API (`GET /api/compliance/v1/consent/status`,
 * host_app=`reeve`, doc_types=`tos,privacy`).
 *
 * Env-gated fail-open, mirroring the `IS_DOCUMENT_CONVERSION_ENABLED` idiom
 * (`packages/lib/constants/document-conversion.ts`): if the compliance env
 * vars are unset (self-host/dev), this is a permanent no-op. If they ARE
 * configured but the status check errors or times out, this still doesn't
 * block — it logs and lets the request through. A consent gate should never
 * be the reason the whole app goes down; availability wins over strictness
 * here (an outage means a delayed re-prompt, not a lockout).
 *
 * A positive result is cached in a session-scoped cookie keyed to the
 * subject_id, so the status endpoint is called at most once per browser
 * session per user (not on every single navigation).
 */
export const checkConsentGate = async ({
  request,
  user,
}: {
  request: Request;
  user: Pick<SessionUser, 'email'>;
}): Promise<ConsentGateResult> => {
  if (!IS_REEVE_COMPLIANCE_ENABLED()) {
    return NO_ACTION;
  }

  const url = new URL(request.url);

  // Never gate the consent page itself — otherwise a still-pending
  // acceptance would bounce the user right back to the page they're on.
  if (url.pathname === CONSENT_GATE_ROUTE_PATH) {
    return NO_ACTION;
  }

  const subjectId = user.email;

  const cachedSubjectId = await getCachedConsentSubjectId(request);

  if (cachedSubjectId && cachedSubjectId === subjectId) {
    return NO_ACTION;
  }

  const status = await getConsentStatus({ subjectId, docTypes: REEVE_COMPLIANCE_DOC_TYPES });

  if (status === null) {
    // Fail-open: compliance API errored, timed out, or is unreachable.
    // Deliberately NOT cached as a positive result — we want the next
    // request to re-check rather than remember a failure as a success.
    logger.warn({ event: 'reeve_compliance_consent_status_check_failed', subjectId });

    return NO_ACTION;
  }

  const needsAcceptance = status.some((item) => item.needsAcceptance);

  if (needsAcceptance) {
    const returnTo = `${url.pathname}${url.search}`;
    const to = `${CONSENT_GATE_ROUTE_PATH}?returnTo=${encodeURIComponent(returnTo)}`;

    return { type: 'redirect', to };
  }

  // Positive result — cache it for the rest of this browser session so we
  // don't hit the compliance API on every request.
  const setCookieHeader = await consentCheckCookie.serialize(subjectId);

  return { type: 'cache', setCookieHeader };
};
