import { IS_CREDITS_METERING_ENABLED, REEVE_SIGN_SEND_CREDITS_COST } from '../../constants/credits';
import { commitReservation, reserveCredits, voidReservation } from './client';

const SEND_REASON = 'sign.envelope.send';

export type MeterDocumentSendOptions = {
  /** The local (Documenso-fork) user id of the sender — the owner whose
   *  `sign` host_app ledger is charged. There is no shared cross-product
   *  Reeve identity wired yet, so this keys the "sign" ledger off reeve-sign's
   *  own user id; that's fine because the "sign" host_app ledger namespace is
   *  exclusive to this product (DEV-2838; org-scoped balance is DEV-2739, out
   *  of scope). */
  userId: number;
  /** The envelope's canonical id (`envelope.id`), stable across the caller's
   *  choice of documentId/templateId/envelopeId lookup — used as the
   *  idempotency key so retried sends of the same envelope never double
   *  charge. */
  envelopeId: string;
};

/**
 * DEV-2838: wraps a send operation with pre-send credit reservation and
 * post-send commit/void — the ONLY place reeve-sign talks to the
 * reeve-services credits surface, so both the envelope-router and the legacy
 * document-router send paths (both call `sendDocument()`, which calls this)
 * get identical metering with no duplicated logic.
 *
 * Behavior:
 * - Metering disabled (`IS_CREDITS_METERING_ENABLED()` false — no env vars
 *   configured): pure no-op passthrough. Self-host / local dev sends are
 *   never gated or charged.
 * - Metering enabled: reserves `REEVE_SIGN_SEND_CREDITS_COST()` credits
 *   BEFORE `sendFn` runs. Insufficient balance or an unreachable credits
 *   service both throw (fail closed) and `sendFn` never runs — no send, no
 *   charge, no free-send hole either way.
 * - `sendFn` throws: the reservation is voided (best-effort; a void failure
 *   is logged, not re-thrown, so the original send error isn't masked) and
 *   the original error propagates.
 * - `sendFn` succeeds: the reservation is committed (best-effort; by this
 *   point the document has already been sent/webhooked, so a commit failure
 *   is logged rather than surfaced as a user-facing send failure — undoing an
 *   email that already went out isn't an option). A stuck open reservation
 *   left behind by a commit failure is an ops-visible ledger concern, not a
 *   blocking one.
 */
export async function meterDocumentSend<T>(
  { userId, envelopeId }: MeterDocumentSendOptions,
  sendFn: () => Promise<T>,
): Promise<T> {
  if (!IS_CREDITS_METERING_ENABLED()) {
    return sendFn();
  }

  const ownerId = String(userId);
  const referenceId = `sign.send.${envelopeId}`;
  const amount = REEVE_SIGN_SEND_CREDITS_COST();

  // Fail closed: reserveCredits throws AppError (INSUFFICIENT_CREDITS on 402,
  // CREDITS_SERVICE_UNAVAILABLE on any transport/config failure) — either way
  // sendFn below never runs.
  const reservation = await reserveCredits({
    ownerId,
    amount,
    referenceId,
    reason: SEND_REASON,
  });

  let result: T;

  try {
    result = await sendFn();
  } catch (err) {
    await voidReservation(reservation.reservationId).catch((voidErr) => {
      console.error(`[credits] Failed to void reservation ${reservation.reservationId} after a failed send:`, voidErr);
    });

    throw err;
  }

  await commitReservation(reservation.reservationId).catch((commitErr) => {
    console.error(
      `[credits] Failed to commit reservation ${reservation.reservationId} after a successful send:`,
      commitErr,
    );
  });

  return result;
}
