import { env } from '../utils/env';

/**
 * DEV-18278: Reeve.Sign fair-use send admission (reeve-services
 * `POST /api/sign/v1/internal/admission`, docs/SIGN_FAIR_USE_ADMISSION.md).
 *
 * Only Reeve-provisioned organisations (system-user owned or `reeve-ext-*`,
 * see `isReeveProvisionedOrganisation`) are admitted. For them
 * admission is NOT optional: when these are unset, their sends fail closed
 * (see `packages/lib/server-only/sign-admission/admit-send.ts`). Fork-native
 * organisations never call it, so self-host / local dev is unaffected.
 *
 * The request is signed with `REEVE_SHARED_HMAC_SECRET`
 * (`packages/lib/server-only/compliance/constants.ts`), the same secret every
 * `/api/sign/v1/internal/*` route verifies.
 */

const DEFAULT_TIMEOUT_MS = 5_000;

/** Base URL of reeve-services, e.g. `https://api.meetreeve.com`. */
export const REEVE_SIGN_ADMISSION_API_URL = (): string | undefined => env('REEVE_SIGN_ADMISSION_API_URL');

export const REEVE_SIGN_ADMISSION_TIMEOUT_MS = (): number => {
  const parsed = parseInt(env('REEVE_SIGN_ADMISSION_TIMEOUT_MS') ?? '', 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
};
