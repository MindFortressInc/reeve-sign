import { logger } from '../../utils/logger';
import {
  IS_REEVE_COMPLIANCE_ENABLED,
  REEVE_COMPLIANCE_API_URL,
  REEVE_COMPLIANCE_HOST_APP,
  REEVE_COMPLIANCE_REQUEST_TIMEOUT_MS,
  REEVE_SHARED_HMAC_SECRET,
} from './constants';
import { buildSignedHeaders } from './sign-request';
import type {
  ConsentStatusItem,
  CurrentLegalDocument,
  RawConsentRecordResponse,
  RawConsentStatusResponse,
  RawCurrentDocumentsResponse,
} from './types';
import { mapConsentStatusItem, mapCurrentDocument } from './types';

/**
 * Thin fetch client for the reeve-services Reeve.Compliance API
 * (`/api/compliance/v1/*`, DEV-2614), HMAC-signed per `sign-request.ts`.
 *
 * Every exported function is fail-open by construction: if the gate is
 * unconfigured, the request times out, the network errors, or the API
 * returns a non-2xx, the function returns `null` (reads) or `false`
 * (writes) rather than throwing. Callers decide what "no answer" means —
 * for the consent gate that's "let the user through and log it" (see
 * `apps/remix/app/utils/consent-gate.server.ts`): availability over
 * strictness for a consent gate, don't lock users out on an API blip.
 */

type GetConsentStatusOptions = {
  subjectId: string;
  docTypes: readonly string[];
  hostApp?: string;
  subjectType?: string;
  locale?: string;
};

type GetCurrentLegalDocumentsOptions = {
  docTypes: readonly string[];
  hostApp?: string;
  locale?: string;
};

type RecordConsentOptions = {
  subjectId: string;
  docType: string;
  version: string;
  hostApp?: string;
  subjectType?: string;
  action?: 'accepted' | 'withdrawn';
  locale?: string;
  ip?: string;
  userAgent?: string;
  source?: string;
};

const fetchWithTimeout = async (url: string, init: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REEVE_COMPLIANCE_REQUEST_TIMEOUT_MS());

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Signed GET against the compliance API. Returns `null` on disabled config,
 * a non-2xx response, or any thrown error (timeout/network/parse) — never
 * throws.
 */
const complianceGet = async <T>(path: string, params: Record<string, string>): Promise<T | null> => {
  if (!IS_REEVE_COMPLIANCE_ENABLED()) {
    return null;
  }

  const baseUrl = REEVE_COMPLIANCE_API_URL();
  const secret = REEVE_SHARED_HMAC_SECRET();

  // Guarded by IS_REEVE_COMPLIANCE_ENABLED above; re-checked for type narrowing.
  if (!baseUrl || !secret) {
    return null;
  }

  const url = new URL(path, baseUrl);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  try {
    const headers = buildSignedHeaders(secret, '');

    const response = await fetchWithTimeout(url.toString(), { method: 'GET', headers });

    if (!response.ok) {
      logger.warn({
        event: 'reeve_compliance_request_failed',
        path,
        status: response.status,
      });

      return null;
    }

    return (await response.json()) as T;
  } catch (err) {
    logger.warn({
      event: 'reeve_compliance_request_error',
      path,
      error: err instanceof Error ? err.message : String(err),
    });

    return null;
  }
};

/**
 * Signed POST against the compliance API. Returns `null` on disabled
 * config, a non-2xx response, or any thrown error — never throws.
 */
const compliancePost = async <T>(path: string, body: Record<string, unknown>): Promise<T | null> => {
  if (!IS_REEVE_COMPLIANCE_ENABLED()) {
    return null;
  }

  const baseUrl = REEVE_COMPLIANCE_API_URL();
  const secret = REEVE_SHARED_HMAC_SECRET();

  if (!baseUrl || !secret) {
    return null;
  }

  const url = new URL(path, baseUrl);
  const bodyString = JSON.stringify(body);

  try {
    const headers = {
      ...buildSignedHeaders(secret, bodyString),
      'Content-Type': 'application/json',
    };

    const response = await fetchWithTimeout(url.toString(), {
      method: 'POST',
      headers,
      body: bodyString,
    });

    if (!response.ok) {
      logger.warn({
        event: 'reeve_compliance_request_failed',
        path,
        status: response.status,
      });

      return null;
    }

    return (await response.json()) as T;
  } catch (err) {
    logger.warn({
      event: 'reeve_compliance_request_error',
      path,
      error: err instanceof Error ? err.message : String(err),
    });

    return null;
  }
};

/**
 * `GET /api/compliance/v1/consent/status` — per-doc_type acceptance state
 * for a subject. Returns `null` when the gate is unconfigured or the
 * request failed in any way (fail-open signal for the caller).
 */
export const getConsentStatus = async ({
  subjectId,
  docTypes,
  hostApp = REEVE_COMPLIANCE_HOST_APP,
  subjectType = 'user',
  locale = 'en',
}: GetConsentStatusOptions): Promise<ConsentStatusItem[] | null> => {
  const raw = await complianceGet<RawConsentStatusResponse>('/api/compliance/v1/consent/status', {
    host_app: hostApp,
    subject_id: subjectId,
    doc_types: docTypes.join(','),
    subject_type: subjectType,
    locale,
  });

  return raw ? raw.status.map(mapConsentStatusItem) : null;
};

/**
 * `GET /api/compliance/v1/legal/current` — the current version + link for
 * each requested doc_type, used to render the acceptance UI. Returns `null`
 * on disabled config or request failure.
 */
export const getCurrentLegalDocuments = async ({
  docTypes,
  hostApp = REEVE_COMPLIANCE_HOST_APP,
  locale = 'en',
}: GetCurrentLegalDocumentsOptions): Promise<CurrentLegalDocument[] | null> => {
  const raw = await complianceGet<RawCurrentDocumentsResponse>('/api/compliance/v1/legal/current', {
    host_app: hostApp,
    doc_types: docTypes.join(','),
    locale,
  });

  return raw ? raw.documents.map(mapCurrentDocument) : null;
};

/**
 * `POST /api/compliance/v1/consent` — records acceptance (or withdrawal)
 * for one doc_type into the append-only `consent_records` ledger. Returns
 * `false` (never throws) on disabled config or request failure so the
 * caller can log-and-continue rather than trap the user in a retry loop.
 */
export const recordConsent = async ({
  subjectId,
  docType,
  version,
  hostApp = REEVE_COMPLIANCE_HOST_APP,
  subjectType = 'user',
  action = 'accepted',
  locale = 'en',
  ip,
  userAgent,
  source = 'reeve-sign',
}: RecordConsentOptions): Promise<boolean> => {
  const raw = await compliancePost<RawConsentRecordResponse>('/api/compliance/v1/consent', {
    host_app: hostApp,
    subject_id: subjectId,
    doc_type: docType,
    version,
    subject_type: subjectType,
    action,
    locale,
    ip,
    user_agent: userAgent,
    source,
  });

  return raw !== null;
};
