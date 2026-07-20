/**
 * Sentry PII scrubbing conventions shared between the server (`@sentry/node`,
 * see `apps/remix/server/sentry.ts`) and client (`@sentry/react`, see
 * `apps/remix/app/entry.client.tsx`) SDKs.
 *
 * Deliberately mirrors reeve-services' `packages/monitor/reeve_monitor/sentry.py`
 * (`_PII_HEADER_DENYLIST`, `_PII_KEY_PATTERNS`, `_scrub`, `_build_before_send`)
 * so error events look the same shape across the Reeve fleet regardless of
 * language. reeve-sign has no JS equivalent to wire through -- `@reeve/monitor-web`
 * (reeve-services) only covers PostHog/GA4, not Sentry -- so this module
 * replicates the Python conventions directly instead of importing them.
 */

/** Header names (case-insensitive) that are fully redacted, never partially. */
const PII_HEADER_DENYLIST = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token']);

/** Object key patterns (case-insensitive) whose values are redacted wherever they appear. */
const PII_KEY_PATTERNS: RegExp[] = [
  /^password$/i,
  /^pass$/i,
  /^pwd$/i,
  /.*_token$/i,
  /.*_secret$/i,
  /.*_key$/i,
  /^api[_-]?key$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
];

const REDACTED = '[redacted]';

const isSensitiveKey = (key: string, extraPatterns: RegExp[]): boolean =>
  [...PII_KEY_PATTERNS, ...extraPatterns].some((pattern) => pattern.test(key));

const scrubValue = (value: unknown, extraPatterns: RegExp[]): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, extraPatterns));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        isSensitiveKey(key, extraPatterns) ? REDACTED : scrubValue(val, extraPatterns),
      ]),
    );
  }

  return value;
};

/**
 * Minimal shape of a Sentry event this scrubber cares about. Kept loose
 * (rather than importing `@sentry/core`'s `Event` type) so this module has
 * zero Sentry SDK dependency and stays safely importable from both the
 * Node (`@sentry/node`) and browser (`@sentry/react`) bundles without
 * pulling either SDK into the other's build.
 */
export interface ScrubbableSentryEvent {
  request?: {
    headers?: Record<string, string>;
    data?: unknown;
    extra?: unknown;
    url?: string;
    query_string?: unknown;
    [key: string]: unknown;
  };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Builds a Sentry `beforeSend` hook that redacts credential-shaped headers
 * and body/extra/context keys before the event leaves the process.
 *
 * Typed against the local `ScrubbableSentryEvent` shape rather than
 * `@sentry/core`'s `Event`/`ErrorEvent` (deliberately -- see that type's
 * doc comment for why). Callers wire this in at the `Sentry.init({
 * beforeSend })` boundary in `apps/remix/server/sentry.ts` and
 * `apps/remix/app/entry.client.tsx`, where a narrow, well-scoped cast
 * adapts between the two -- see the comments there.
 *
 * @param extraPatterns Regex source strings (case-insensitive) for
 * app-specific secrets beyond the shared denylist.
 */
export function buildSentryBeforeSend(
  extraPatterns: string[] = [],
): (event: ScrubbableSentryEvent) => ScrubbableSentryEvent {
  const compiled = extraPatterns.map((pattern) => new RegExp(pattern, 'i'));

  return (event) => {
    if (event.request && typeof event.request === 'object') {
      const request = event.request;

      if (request.headers && typeof request.headers === 'object') {
        request.headers = Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key,
            PII_HEADER_DENYLIST.has(key.toLowerCase()) ? REDACTED : value,
          ]),
        );
      }

      if ('data' in request) {
        request.data = scrubValue(request.data, compiled);
      }

      // `request.extra` isn't a field the real Sentry SDKs populate (there's
      // no `RequestEventData.extra`) -- scrubbed anyway for parity with the
      // Python reference's equivalent branch and as a defensive no-op in
      // case a future SDK version or a custom integration adds one.
      if ('extra' in request) {
        request.extra = scrubValue(request.extra, compiled);
      }

      // Sentry's request integrations populate `request.url` and
      // `request.query_string` even with `sendDefaultPii: false`, and these
      // routes carry presigned tokens in the query string. Strip the query
      // string off the URL and redact `query_string` entirely so tokens
      // never leave the process.
      if (typeof request.url === 'string') {
        request.url = request.url.split('?')[0];
      }

      if ('query_string' in request) {
        request.query_string = REDACTED;
      }
    }

    if (event.extra) {
      event.extra = scrubValue(event.extra, compiled) as Record<string, unknown>;
    }

    if (event.contexts && typeof event.contexts === 'object') {
      event.contexts = scrubValue(event.contexts, compiled) as Record<string, unknown>;
    }

    return event;
  };
}
