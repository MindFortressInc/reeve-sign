import { REEVE_CREDITS_API_URL, REEVE_CREDITS_TIMEOUT_MS, REEVE_SIGN_HOST_KEY } from '../../constants/credits';
import { AppError } from '../../errors/app-error';

/**
 * DEV-2838: thin client for reeve-services' host-key-routed credits surface
 * (`api/routers/credits_host_app.py`, mounted at `/api/v1/credits`). Callers
 * authenticate as the `sign` host_app via the `X-Reeve-Host-Key` header
 * (`api/credits_bootstrap.py` registers `sign` as a credits-capable
 * host_app) — the same established pattern studio/freya/agentpik already use.
 *
 * Every function here throws `AppError` on failure. There is deliberately NO
 * silent-fallback path: a caller that wants "unconfigured = no metering"
 * must check `IS_CREDITS_METERING_ENABLED()` itself (see
 * `packages/lib/server-only/credits/meter-send.ts`) — this module fails
 * closed on every error, including "not configured" and "service
 * unreachable", so it can never be mistaken for an optional/best-effort call.
 */

const NOT_CONFIGURED_MESSAGE = 'REEVE_CREDITS_API_URL / REEVE_SIGN_HOST_KEY are not configured';

const UNAVAILABLE_USER_MESSAGE = "We couldn't verify your credit balance right now. Please try sending again shortly.";

const INSUFFICIENT_CREDITS_USER_MESSAGE =
  "You don't have enough credits to send this document. Please top up your balance and try again.";

const MAX_ERROR_BODY_CHARS = 500;

export type CreditsOwnerType = 'user' | 'org';

export type ReserveCreditsOptions = {
  ownerId: string;
  amount: number;
  referenceId: string;
  reason: string;
  ownerType?: CreditsOwnerType;
};

export type ReserveCreditsResult = {
  reservationId: string;
  reserved: number;
};

export type CommitReservationResult = {
  entryId: string;
  committed: number;
  reservationId: string;
};

export type VoidReservationResult = {
  voided: boolean;
  reservationId: string;
};

export type CreditsBalance = {
  balance: number | null;
  base: number | null;
  topUp: number | null;
  expiringSoon: number | null;
  ownerType: string;
  reason?: string;
};

type CreditsFetchOptions = {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
};

/**
 * Shared fetch wrapper for every credits endpoint. Mirrors the
 * config-missing / timeout-or-network / non-2xx triage used by the document
 * conversion client (`packages/lib/server-only/document-conversion/gotenberg.ts`).
 */
async function creditsFetch<T>({ method, path, body }: CreditsFetchOptions): Promise<T> {
  const baseUrl = REEVE_CREDITS_API_URL();
  const hostKey = REEVE_SIGN_HOST_KEY();

  if (!baseUrl || !hostKey) {
    throw new AppError('CREDITS_SERVICE_NOT_CONFIGURED', {
      message: NOT_CONFIGURED_MESSAGE,
      statusCode: 503,
    });
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REEVE_CREDITS_TIMEOUT_MS());

  const endpoint = new URL(path, baseUrl).toString();

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Reeve-Host-Key': hostKey,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const isAbortError = err instanceof Error && err.name === 'AbortError';

    const message = isAbortError
      ? 'Credits service timed out'
      : `Credits service request failed: ${err instanceof Error ? err.message : String(err)}`;

    // Network failure / timeout — FAIL CLOSED. Never swallow this as a
    // no-op; the gate must block the send when the metering service can't
    // be reached (see module docstring).
    throw new AppError('CREDITS_SERVICE_UNAVAILABLE', {
      message,
      userMessage: UNAVAILABLE_USER_MESSAGE,
      statusCode: 503,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (response.status === 402) {
    throw new AppError('INSUFFICIENT_CREDITS', {
      message: 'Insufficient credit balance for this send',
      userMessage: INSUFFICIENT_CREDITS_USER_MESSAGE,
      statusCode: 402,
    });
  }

  if (response.status === 404) {
    throw new AppError('CREDITS_RESERVATION_NOT_FOUND', {
      message: `Credits reservation not found (${path})`,
      userMessage: UNAVAILABLE_USER_MESSAGE,
      statusCode: 503,
    });
  }

  if (response.status === 409) {
    throw new AppError('CREDITS_RESERVATION_CONFLICT', {
      message: `Credits reservation conflict (${path})`,
      userMessage: UNAVAILABLE_USER_MESSAGE,
      statusCode: 503,
    });
  }

  if (!response.ok) {
    let bodyText = '';

    try {
      bodyText = await response.text();
    } catch {
      bodyText = '';
    }

    const truncatedBody =
      bodyText.length > MAX_ERROR_BODY_CHARS ? `${bodyText.slice(0, MAX_ERROR_BODY_CHARS)}...` : bodyText;

    throw new AppError('CREDITS_SERVICE_UNAVAILABLE', {
      message: `Credits service returned ${response.status}: ${truncatedBody}`,
      userMessage: UNAVAILABLE_USER_MESSAGE,
      statusCode: 503,
    });
  }

  return (await response.json()) as T;
}

/**
 * Place an atomic hold on `amount` credits. Idempotent on the reeve-services
 * side by `(host_app, owner, reason, reference_id)` — calling this again with
 * the SAME `referenceId` + `reason` (e.g. a retried send) replays the
 * existing reservation rather than double-holding. Throws `AppError` with
 * code `INSUFFICIENT_CREDITS` (402) when the balance can't cover it, or
 * `CREDITS_SERVICE_UNAVAILABLE` on any transport/config failure (fail
 * closed).
 */
export async function reserveCredits({
  ownerId,
  amount,
  referenceId,
  reason,
  ownerType = 'user',
}: ReserveCreditsOptions): Promise<ReserveCreditsResult> {
  const data = await creditsFetch<{ reserved: number; reservation_id: string }>({
    method: 'POST',
    path: '/api/v1/credits/reserve',
    body: { owner_id: ownerId, amount, reference_id: referenceId, reason, owner_type: ownerType },
  });

  return { reservationId: data.reservation_id, reserved: data.reserved };
}

/**
 * Convert an open hold into a real debit. `referenceId` optionally overrides
 * the ledger idempotency key for the resulting debit entry; when omitted the
 * reservation's own reference_id is used.
 */
export async function commitReservation(reservationId: string, referenceId?: string): Promise<CommitReservationResult> {
  const data = await creditsFetch<{ committed: number; entry_id: string; reservation_id: string }>({
    method: 'POST',
    path: `/api/v1/credits/reserve/${encodeURIComponent(reservationId)}/commit`,
    body: { reference_id: referenceId },
  });

  return { entryId: data.entry_id, committed: data.committed, reservationId: data.reservation_id };
}

/** Release an open hold without debiting anything. */
export async function voidReservation(reservationId: string): Promise<VoidReservationResult> {
  const data = await creditsFetch<{ voided: boolean; reservation_id: string }>({
    method: 'POST',
    path: `/api/v1/credits/reserve/${encodeURIComponent(reservationId)}/void`,
  });

  return { voided: data.voided, reservationId: data.reservation_id };
}

/** Read-only balance lookup for the `sign` host_app ledger. */
export async function getCreditsBalance(
  ownerId: string,
  ownerType: CreditsOwnerType = 'user',
): Promise<CreditsBalance> {
  const data = await creditsFetch<{
    balance: number | null;
    base: number | null;
    top_up: number | null;
    expiring_soon: number | null;
    owner_type: string;
    reason?: string;
  }>({
    method: 'GET',
    path: `/api/v1/credits/balance/${encodeURIComponent(ownerId)}?owner_type=${ownerType}`,
  });

  return {
    balance: data.balance,
    base: data.base,
    topUp: data.top_up,
    expiringSoon: data.expiring_soon,
    ownerType: data.owner_type,
    reason: data.reason,
  };
}
