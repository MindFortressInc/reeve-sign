import { createHash, timingSafeEqual } from 'node:crypto';

import { env } from '../../utils/env';

/**
 * Header used by the service-token-guarded Reeve.Sign admin provisioning
 * endpoint (`POST /api/reeve-admin/organisations`). See DEV-4873.
 *
 * `Request.headers.get()` is case-insensitive, so this exact-case constant is
 * only for documentation/readability at call sites.
 */
export const REEVE_ADMIN_TOKEN_HEADER = 'X-Reeve-Sign-Admin-Token';

/**
 * Fail-closed gate: the Reeve admin provisioning endpoint must be treated as
 * disabled (not merely "unauthenticated") whenever `REEVE_SIGN_ADMIN_TOKEN`
 * is unset or empty. Never falls open.
 */
export const isReeveAdminProvisioningConfigured = (): boolean => {
  const token = env('REEVE_SIGN_ADMIN_TOKEN');

  return typeof token === 'string' && token.length > 0;
};

/**
 * Digest both sides to a fixed-length buffer before comparing so that
 * `timingSafeEqual` never throws on a length mismatch (which would itself
 * leak timing/branch information) and so the comparison is constant-time
 * regardless of the caller-supplied token's length.
 */
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time comparison of a caller-supplied token against
 * `REEVE_SIGN_ADMIN_TOKEN`. Returns false (never throws, never opens) when
 * the env var is unset or the provided token is missing/empty.
 */
export const isReeveAdminTokenValid = (providedToken: string | null | undefined): boolean => {
  const expectedToken = env('REEVE_SIGN_ADMIN_TOKEN');

  if (!expectedToken || !providedToken) {
    return false;
  }

  return timingSafeEqual(digest(expectedToken), digest(providedToken));
};
