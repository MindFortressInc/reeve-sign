import { env } from '../utils/env';

/**
 * DEV-2838: Reeve.Sign P4 usage metering — user-level 500cr/doc charge on
 * send, gated on the user's Reeve credit balance.
 *
 * Env-gated the same way as document conversion
 * (see `IS_DOCUMENT_CONVERSION_ENABLED` in ./document-conversion.ts):
 *
 * - Unconfigured (no `REEVE_CREDITS_API_URL` / `REEVE_SIGN_HOST_KEY`) →
 *   metering is a no-op. Self-host / local dev sends are never gated or
 *   charged.
 * - Configured but reeve-services is unreachable at send time → this is
 *   NOT treated as "unconfigured". The send FAILS CLOSED (blocked with a
 *   clear error) — see `packages/lib/server-only/credits/client.ts` — so a
 *   live billing gate can never be silently bypassed by the metering
 *   service being down.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Rate SSOT is reeve-services' commerce catalog, NOT this file:
 * `api/commerce_bootstrap.py`'s `ProductDef(id="sign", credits=500,
 * usd_display="$0.50")` on the "reeve" catalog (see
 * `tests/test_commerce_bootstrap.py::test_reeve_catalog_registers_per_sku_products`
 * in reeve-services). This default only mirrors that SSOT value so reeve-sign
 * keeps working if the env override is unset; `REEVE_SIGN_SEND_CREDITS_COST`
 * exists purely so ops can react to a rate change without a redeploy.
 */
const DEFAULT_SEND_CREDITS_COST = 500;

/** Base URL of the reeve-services credits surface, e.g. https://api.meetreeve.com */
export const REEVE_CREDITS_API_URL = (): string | undefined => env('REEVE_CREDITS_API_URL');

/**
 * The `sign` host_app's `X-Reeve-Host-Key` credential, minted via
 * reeve-services' `scripts/comms/register-host-app.py` against the `sign`
 * host_app registered in `api/credits_bootstrap.py` (DEV-2838).
 */
export const REEVE_SIGN_HOST_KEY = (): string | undefined => env('REEVE_SIGN_HOST_KEY');

/**
 * Whether send-time credit metering is active. Both vars are required — a
 * URL with no key (or vice versa) is a misconfiguration, not "enabled", so
 * it also resolves to disabled (no-op) rather than a half-wired gate.
 */
export const IS_CREDITS_METERING_ENABLED = (): boolean => {
  return Boolean(REEVE_CREDITS_API_URL() && REEVE_SIGN_HOST_KEY());
};

/** Credits charged per sent envelope. See the SSOT note above. */
export const REEVE_SIGN_SEND_CREDITS_COST = (): number => {
  const raw = env('REEVE_SIGN_SEND_CREDITS_COST');
  const parsed = raw ? parseInt(raw, 10) : NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SEND_CREDITS_COST;
};

/** Per-request timeout for calls to the reeve-services credits surface. */
export const REEVE_CREDITS_TIMEOUT_MS = (): number => {
  const raw = env('REEVE_CREDITS_TIMEOUT_MS');
  const parsed = raw ? parseInt(raw, 10) : NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
};
