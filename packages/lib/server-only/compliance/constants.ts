import { env } from '../../utils/env';

/**
 * Reeve.Compliance consent-capture substrate (DEV-2837).
 *
 * Talks to the `reeve-services` `/api/compliance/v1/*` endpoints (DEV-2614) to
 * gate app access on ToS/Privacy acceptance. Entirely optional: when the env
 * vars below are unset (self-host/dev), every function in this package is a
 * no-op — mirrors the `IS_DOCUMENT_CONVERSION_ENABLED` env-gating idiom in
 * `packages/lib/constants/document-conversion.ts`.
 *
 * Var names are intentionally NOT `NEXT_PRIVATE_`-prefixed: `REEVE_SHARED_HMAC_SECRET`
 * must match the literal env var name `reeve-services` reads
 * (`api/services/channels/hmac_middleware.py`) so ops can copy the same
 * secret value into both services' env without a name translation step.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export const REEVE_COMPLIANCE_HOST_APP = 'reeve';

export const REEVE_COMPLIANCE_DOC_TYPES = ['tos', 'privacy'] as const;

export type ReeveComplianceDocType = (typeof REEVE_COMPLIANCE_DOC_TYPES)[number];

/** Base URL of the reeve-services Reeve.Compliance API, e.g. `https://api.meetreeve.com`. */
export const REEVE_COMPLIANCE_API_URL = (): string | undefined => env('REEVE_COMPLIANCE_API_URL');

/** Shared HMAC secret — must be the same value as reeve-services' `REEVE_SHARED_HMAC_SECRET`. */
export const REEVE_SHARED_HMAC_SECRET = (): string | undefined => env('REEVE_SHARED_HMAC_SECRET');

/**
 * Whether the consent gate is configured. When `false`, the gate and its
 * client no-op entirely (fail-open by construction, not by catching errors).
 */
export const IS_REEVE_COMPLIANCE_ENABLED = (): boolean => {
  return Boolean(REEVE_COMPLIANCE_API_URL() && REEVE_SHARED_HMAC_SECRET());
};

export const REEVE_COMPLIANCE_REQUEST_TIMEOUT_MS = (): number => {
  const raw = env('REEVE_COMPLIANCE_REQUEST_TIMEOUT_MS');

  if (!raw) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  const parsed = parseInt(raw, 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  return parsed;
};
