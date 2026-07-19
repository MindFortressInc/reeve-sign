import { buildSentryBeforeSend, type ScrubbableSentryEvent } from '@documenso/lib/universal/sentry/scrub';
import * as Sentry from '@sentry/node';
import type { ErrorHandler } from 'hono';
import { createMiddleware } from 'hono/factory';

import type { HonoEnv } from './router';

/**
 * Error monitoring for reeve-sign (DEV-2839).
 *
 * SDK choice: `@sentry/node` (server) + `@sentry/react` (client, see
 * `apps/remix/app/entry.client.tsx`), NOT `@sentry/react-router`. The
 * official `@sentry/react-router` server-side setup assumes the standard
 * `react-router-serve` script and an exposed `entry.server.tsx`
 * `handleError` hook, loaded via `NODE_OPTIONS='--import ./instrument.server.mjs'`.
 * This app doesn't use `react-router-serve` at all -- `server/main.js` is a
 * hand-copied Hono entrypoint (see `apps/remix/.bin/build.sh`) built around
 * `@hono/node-server`, and `server/router.ts` is the actual request-handling
 * surface (React Router is mounted into it via `hono-react-router-adapter`,
 * not the other way around). `@sentry/node` instruments that shape directly
 * and is GA (there is also an official `@sentry/hono` package, but it's
 * still ALPHA -- not worth the stability risk for a monitoring dependency).
 *
 * Mirrors reeve-services' `packages/monitor/reeve_monitor/sentry.py`
 * (`init_sentry`, `SentryContextMiddleware`) for the DSN env var precedent
 * (`SENTRY_DSN`), the `service_name`/`org_id`/`user_id` tag names, and the
 * per-request isolation-scope pattern. reeve-sign has no shared JS package
 * to wire through -- `@reeve/monitor-web` (reeve-services) only covers
 * PostHog/GA4, not Sentry.
 */

export const SENTRY_SERVICE_NAME = 'reeve-sign';
export const SENTRY_HOST_APP = 'reeve';

/**
 * Initialize the Sentry Node SDK. No-op (returns `false`) when `SENTRY_DSN`
 * is unset, so deployments that don't configure Sentry pay zero runtime
 * cost. Safe to call more than once (e.g. from both `server/main.js` and
 * `server/router.ts`) -- guarded so it only initializes the client once.
 */
export function initServerSentry(dsn: string | undefined = process.env.SENTRY_DSN): boolean {
  if (!dsn) {
    console.info('[sentry] SENTRY_DSN not set; server-side error monitoring disabled');
    return false;
  }

  if (Sentry.getClient()) {
    return true;
  }

  const scrubBeforeSend = buildSentryBeforeSend();

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    // `scrubBeforeSend` is typed against the shared, SDK-agnostic
    // `ScrubbableSentryEvent` (see packages/lib/universal/sentry/scrub.ts)
    // rather than `@sentry/node`'s own `Event` type, so this repo's PII
    // scrubbing logic has zero Sentry SDK dependency and is safely
    // importable from both the Node and browser bundles. The cast is a
    // narrow, single-boundary adapter: `Event` is a structural superset of
    // `ScrubbableSentryEvent`, and the function mutates-and-returns the
    // same object, so nothing is lost crossing it.
    beforeSend: (event) => scrubBeforeSend(event as unknown as ScrubbableSentryEvent) as unknown as Sentry.ErrorEvent,
  });

  console.info('[sentry] server-side error monitoring initialized', { service_name: SENTRY_SERVICE_NAME });

  return true;
}

/**
 * Request-scoped tagging middleware. Slots into the middleware chain in
 * `server/router.ts` alongside `appContext`/`securityHeadersMiddleware`.
 *
 * Tags every event from this request with `service_name` and `host_app`.
 *
 * `org_id`/`user_id` are deliberately NOT set here: at this point in the
 * middleware chain (before the React Router loader runs) the session
 * hasn't been decoded yet -- `AppContext` (`server/context.ts`) only
 * carries `requestMetadata` (ip/user-agent). Decoding the session here
 * would mean a second DB-backed session lookup on every request --
 * `root.tsx`'s loader already does one via `getOptionalSession` -- which is
 * a real behavior/perf change, not a cheap tag. `user_id` is tagged
 * client-side instead (see `apps/remix/app/root.tsx`), where the session
 * is already-loaded data. `org_id` isn't tagged anywhere yet: the active
 * organisation isn't part of the root session payload either -- it's
 * resolved per-route from the URL via `OrganisationProvider`
 * (`@documenso/lib/client-only/providers/organisation`), which isn't
 * mounted at the root layout. Wiring it would mean either parsing the URL
 * here (fragile, duplicates route logic) or hoisting that provider to
 * root (a real refactor) -- out of scope for this ticket.
 *
 * Wraps `next()` in a fresh Sentry isolation scope (mirrors
 * `reeve_monitor.sentry.SentryContextMiddleware`'s pure-ASGI isolation
 * scope) so tags never leak across concurrent requests.
 */
export const sentryTaggingMiddleware = createMiddleware<HonoEnv>(async (_c, next) => {
  if (!Sentry.getClient()) {
    await next();
    return;
  }

  await Sentry.withIsolationScope(async () => {
    Sentry.setTag('service_name', SENTRY_SERVICE_NAME);
    Sentry.setTag('host_app', SENTRY_HOST_APP);

    await next();
  });
});

/**
 * Global error handler, registered via `app.onError(sentryErrorHandler)` in
 * `server/router.ts`. This is what actually reports errors -- the tagging
 * middleware above only prepares the scope those reports land in.
 *
 * Hono catches handler throws internally (see the default `errorHandler` in
 * `hono/hono-base.ts`) and converts them into a response *without* ever
 * raising a process-level `uncaughtException`, so `@sentry/node`'s default
 * exception hooks never see them. Without an explicit `captureException`
 * call here, thrown errors would never reach Sentry at all.
 *
 * Deliberately replicates Hono's own default `errorHandler` response shape
 * exactly (the `"getResponse" in err` duck-type check, then the same
 * generic 500 fallback) so registering this handler is a pure addition --
 * it does not change the response any existing route returns on error.
 */
export const sentryErrorHandler: ErrorHandler<HonoEnv> = (err, c) => {
  if (Sentry.getClient()) {
    Sentry.captureException(err);
  }

  if (typeof err === 'object' && err !== null && 'getResponse' in err) {
    const res = (err as { getResponse: () => Response }).getResponse();
    return c.newResponse(res.body, res);
  }

  console.error(err);

  return c.text('Internal Server Error', 500);
};
