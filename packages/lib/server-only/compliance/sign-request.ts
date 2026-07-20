import { createHmac } from 'node:crypto';

/**
 * Request signing for the reeve-services Reeve.Compliance API.
 *
 * Mirrors `api/services/channels/hmac_middleware.py::verify_hmac` exactly
 * (verified against reeve-services pin `31b880bc5526`):
 *
 *   sig = "sha256=" + HMAC_SHA256(REEVE_SHARED_HMAC_SECRET, f"{ts}.{body}").hexdigest()
 *
 * bound with a fresh `X-Reeve-Timestamp` (±5 min window server-side) per the
 * DEV-3446 replay-protected scheme — the same one reeve-agents' `/api/ingest`
 * uses. For GET requests (consent/status, legal/current) `body` is the empty
 * string, matching how `verify_hmac` reads `await request.body()` regardless
 * of HTTP method.
 */

export const REEVE_SIGNATURE_HEADER = 'X-Reeve-Signature';
export const REEVE_TIMESTAMP_HEADER = 'X-Reeve-Timestamp';

export type SignedRequestHeaders = {
  [REEVE_SIGNATURE_HEADER]: string;
  [REEVE_TIMESTAMP_HEADER]: string;
};

/**
 * Signs a request body with the shared HMAC secret.
 *
 * @param secret - REEVE_SHARED_HMAC_SECRET value.
 * @param body - Raw request body string (empty string for GET requests).
 * @param timestampSeconds - Unix timestamp in seconds. Defaults to now; only
 *   overridden by tests for deterministic fixtures.
 */
export const signReeveRequestBody = (
  secret: string,
  body: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): { signature: string; timestamp: string } => {
  const timestamp = String(timestampSeconds);
  const signedMessage = `${timestamp}.${body}`;
  const digest = createHmac('sha256', secret).update(signedMessage).digest('hex');

  return {
    signature: `sha256=${digest}`,
    timestamp,
  };
};

/** Builds the `X-Reeve-Signature` / `X-Reeve-Timestamp` header pair for a request. */
export const buildSignedHeaders = (secret: string, body: string): SignedRequestHeaders => {
  const { signature, timestamp } = signReeveRequestBody(secret, body);

  return {
    [REEVE_SIGNATURE_HEADER]: signature,
    [REEVE_TIMESTAMP_HEADER]: timestamp,
  };
};
