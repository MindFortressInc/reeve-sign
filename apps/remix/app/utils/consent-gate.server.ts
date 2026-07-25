import type { SessionUser } from '@documenso/auth/server/lib/session/session';
import {
  getConsentStatus,
  IS_REEVE_COMPLIANCE_ENABLED,
  REEVE_COMPLIANCE_DOC_TYPES,
} from '@documenso/lib/server-only/compliance';
import { logger } from '@documenso/lib/utils/logger';

import { getCachedConsent, serializeConsentCache } from '~/storage/consent-check-cookie.server';
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
 * Whether the cached version map covers every doc_type the gate currently
 * requires. A missing doc_type means the cache predates a new requirement and
 * must not be trusted.
 */
const hasAllDocTypes = (versions: Record<string, string>): boolean => {
  return REEVE_COMPLIANCE_DOC_TYPES.every(
    (docType) => typeof versions[docType] === 'string' && versions[docType].length > 0,
  );
};

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
 * A positive result is cached in a signed cookie keyed to the subject_id
 * *and* the accepted doc_type → version map, with a bounded TTL, so the
 * status endpoint stays off the hot path for most navigations while a
 * version bump or a newly-required doc_type still re-prompts (DEV-4781) —
 * see `consent-check-cookie.server.ts` for the caching contract.
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

  const cached = await getCachedConsent(request);

  // Trust the cache only when it belongs to this subject AND still covers
  // every currently-required doc_type. A doc_type added to the required set
  // (e.g. via deploy) invalidates a stale cookie locally with no API call; a
  // version bump of an existing doc_type is caught by the cookie's bounded
  // TTL, after which we fall through to a fresh status check here (DEV-4781).
  if (cached && cached.subjectId === subjectId && hasAllDocTypes(cached.versions)) {
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

  // Positive result — cache it (subject + accepted versions, bounded TTL) so
  // we don't hit the compliance API on every request.
  const versions = Object.fromEntries(
    status.map((item) => [item.docType, item.currentVersion ?? item.acceptedVersion ?? '']),
  );

  const setCookieHeader = await serializeConsentCache({ subjectId, versions });

  return { type: 'cache', setCookieHeader };
};
