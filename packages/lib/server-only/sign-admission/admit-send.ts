import { REEVE_SIGN_ADMISSION_API_URL, REEVE_SIGN_ADMISSION_TIMEOUT_MS } from '../../constants/sign-admission';
import { AppError } from '../../errors/app-error';
import { logger } from '../../utils/logger';
import { REEVE_SHARED_HMAC_SECRET } from '../compliance/constants';
import { buildSignedHeaders } from '../compliance/sign-request';
import { REEVE_PROVISIONED_ORGANISATION_URL_PREFIX } from '../reeve-admin/derive-organisation-url';

/**
 * DEV-18278: the fork's authoritative fair-use backstop. Every send and
 * resend from a Reeve-provisioned organisation (`reeve-ext-*`) asks
 * reeve-services' admission (docs/SIGN_FAIR_USE_ADMISSION.md) before any
 * metering or mail. Upstream doors (api / embed / agents) consume the
 * admission before they distribute, so a first send normally replays it
 * (`replay: true`); a resend spends a fresh slot under its own attempt key.
 *
 * Fail closed: anything but 200 `decision: "allow"` throws a
 * `SignAdmissionError` (an AppError), including unset config, a timeout and a network
 * error. Fork-native organisations are exempt and logged.
 */

export const SIGN_ADMISSION_PATH = '/api/sign/v1/internal/admission';

const UNAVAILABLE_MESSAGE = "We couldn't confirm this send right now, so nothing was sent. Please try again shortly.";

const REFUSED_MESSAGE = 'Reeve.Sign refused this send, so nothing was sent.';

const MAX_SERVER_MESSAGE_CHARS = 500;

export const SIGN_ADMISSION_ERROR_CODES = [
  'SIGN_ACCOUNT_SUSPENDED',
  'SIGN_SEND_RATE_LIMITED',
  'SIGN_ACCOUNT_UNRESOLVED',
  'SIGN_ADMISSION_UNAVAILABLE',
] as const;

export type SignAdmissionErrorCode = (typeof SIGN_ADMISSION_ERROR_CODES)[number];

export type SignAdmissionStatus = 403 | 422 | 429 | 503;

/** An AppError for a refused send; `retryAfterSeconds` is set only on a 429. */
export type SignAdmissionError = AppError & {
  code: SignAdmissionErrorCode;
  statusCode: SignAdmissionStatus;
  retryAfterSeconds?: number;
};

/** Server refusal codes the fork surfaces as they are; anything else is "unavailable". */
const REFUSALS: Record<string, { code: SignAdmissionErrorCode; status: 403 | 422 | 429 }> = {
  account_suspended: { code: 'SIGN_ACCOUNT_SUSPENDED', status: 403 },
  tenant_suspended: { code: 'SIGN_ACCOUNT_SUSPENDED', status: 403 },
  send_rate_limited: { code: 'SIGN_SEND_RATE_LIMITED', status: 429 },
  account_unresolved: { code: 'SIGN_ACCOUNT_UNRESOLVED', status: 422 },
};

export const createSignAdmissionError = (
  code: SignAdmissionErrorCode,
  status: SignAdmissionStatus,
  message: string,
  retryAfterSeconds?: number,
): SignAdmissionError => {
  const error = new AppError(code, {
    message,
    userMessage: message,
    statusCode: status,
    headers: retryAfterSeconds !== undefined ? { 'Retry-After': String(retryAfterSeconds) } : undefined,
  });

  return Object.assign(error, { code, statusCode: status, retryAfterSeconds });
};

export const isSignAdmissionError = (error: unknown): error is SignAdmissionError => {
  return error instanceof AppError && (SIGN_ADMISSION_ERROR_CODES as readonly string[]).includes(error.code);
};

const unavailable = () => createSignAdmissionError('SIGN_ADMISSION_UNAVAILABLE', 503, UNAVAILABLE_MESSAGE);

export type AdmitSignSendOptions = {
  /** The v2 envelope id (`envelope_...`). */
  envelopeId: string;
  /** The numeric v1 document id: reeve-services' `/api/v2/sign` admits under it. */
  legacyDocumentId: number;
  /** The envelope's organisation url; only `reeve-ext-*` is admitted. */
  organisationUrl: string;
  /** `send` for a first distribute, `resend:<unique id>` for each resend. */
  attempt: string;
};

export type SignAdmissionResult =
  | { enforced: false }
  | { enforced: true; account: string; consumed: boolean; replay: boolean };

type AdmissionErrorBody = { error?: { code?: unknown; message?: unknown; retry_after_seconds?: unknown } };

const toRetryAfter = (bodyValue: unknown, header: string | null): number | undefined => {
  const candidate = typeof bodyValue === 'number' ? bodyValue : Number(header);

  return Number.isFinite(candidate) && candidate >= 0 ? Math.ceil(candidate) : undefined;
};

export const admitSignSend = async ({
  envelopeId,
  legacyDocumentId,
  organisationUrl,
  attempt,
}: AdmitSignSendOptions): Promise<SignAdmissionResult> => {
  if (!organisationUrl.startsWith(REEVE_PROVISIONED_ORGANISATION_URL_PREFIX)) {
    logger.info({ event: 'sign_admission_exempt', reason: 'fork_native_org', envelopeId, attempt });

    return { enforced: false };
  }

  const baseUrl = REEVE_SIGN_ADMISSION_API_URL();
  const secret = REEVE_SHARED_HMAC_SECRET();

  if (!baseUrl || !secret) {
    logger.error({ event: 'sign_admission_not_configured', envelopeId, attempt });

    throw unavailable();
  }

  const body = JSON.stringify({
    door: 'fork',
    envelope_id: envelopeId,
    document_id: String(legacyDocumentId),
    attempt,
  });

  const signal = AbortSignal.timeout(REEVE_SIGN_ADMISSION_TIMEOUT_MS());

  let response: Response;
  let payload: unknown;

  try {
    response = await fetch(new URL(SIGN_ADMISSION_PATH, baseUrl).toString(), {
      method: 'POST',
      headers: { ...buildSignedHeaders(secret, body), 'Content-Type': 'application/json' },
      body,
      signal,
    });

    payload = await response.json().catch(() => null);
  } catch (err) {
    logger.error({
      event: 'sign_admission_request_error',
      envelopeId,
      attempt,
      timedOut: signal.aborted,
      error: err instanceof Error ? err.message : String(err),
    });

    throw unavailable();
  }

  if (response.status === 200) {
    const allow = payload as { decision?: unknown; account?: unknown; consumed?: unknown; replay?: unknown } | null;

    if (allow?.decision === 'allow' && typeof allow.account === 'string') {
      return {
        enforced: true,
        account: allow.account,
        consumed: allow.consumed === true,
        replay: allow.replay === true,
      };
    }
  }

  const error = (payload as AdmissionErrorBody | null)?.error;
  const refusal = typeof error?.code === 'string' ? REFUSALS[error.code] : undefined;

  // The upstream body stays in server logs only by status/code (DEV-17675).
  logger.warn({
    event: 'sign_admission_refused',
    envelopeId,
    attempt,
    status: response.status,
    code: typeof error?.code === 'string' ? error.code : null,
  });

  if (!refusal || refusal.status !== response.status) {
    throw unavailable();
  }

  // Refusal messages are written for the sender ("Slow down: ... try again in
  // 37 seconds."), so they pass through as the user-facing message.
  const message =
    typeof error?.message === 'string' && error.message.trim()
      ? error.message.slice(0, MAX_SERVER_MESSAGE_CHARS)
      : REFUSED_MESSAGE;

  const retryAfterSeconds =
    refusal.status === 429 ? toRetryAfter(error?.retry_after_seconds, response.headers.get('Retry-After')) : undefined;

  throw createSignAdmissionError(refusal.code, refusal.status, message, retryAfterSeconds);
};
