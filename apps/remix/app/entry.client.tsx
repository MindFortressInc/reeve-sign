import { extractPostHogConfig } from '@documenso/lib/constants/feature-flags';
import { buildSentryBeforeSend, type ScrubbableSentryEvent } from '@documenso/lib/universal/sentry/scrub';
import { env } from '@documenso/lib/utils/env';
import { dynamicActivate } from '@documenso/lib/utils/i18n';
import { i18n } from '@lingui/core';
import { detect, fromHtmlTag } from '@lingui/detect-locale';
import { I18nProvider } from '@lingui/react';
// Type-only: `Sentry` inside the dynamic `import('@sentry/react').then((Sentry) => ...)`
// callback below is a value (the module namespace object), not usable in a
// type position, so `ErrorEvent` is imported separately for the cast.
import type { ErrorEvent as SentryErrorEvent } from '@sentry/react';
import { StrictMode, startTransition, useEffect } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

import './utils/polyfills/promise-with-resolvers';

function PosthogInit() {
  const postHogConfig = extractPostHogConfig();

  useEffect(() => {
    if (postHogConfig) {
      void import('posthog-js').then(({ default: posthog }) => {
        posthog.init(postHogConfig.key, {
          api_host: postHogConfig.host,
          capture_exceptions: true,
        });
      });
    }
  }, []);

  return null;
}

/**
 * Client-side error monitoring (DEV-2839). Gated on `NEXT_PUBLIC_SENTRY_DSN`
 * (via the repo's `env()`/`window.__ENV__` mechanism, see
 * `packages/lib/utils/env.ts` and `createPublicEnv()`); no-op when unset.
 * Dynamically imported like `PosthogInit` above, to keep `@sentry/react`
 * out of the initial bundle. See `apps/remix/server/sentry.ts` for the
 * SDK-choice rationale (`@sentry/node` + `@sentry/react`, not
 * `@sentry/react-router`) and the shared PII-scrubbing conventions.
 *
 * Awaited in `main()` *before* `hydrateRoot` (DEV-4790) -- previously this
 * ran in a post-hydration `useEffect`, which meant errors thrown during
 * hydration itself (the ones `root.tsx`'s `ErrorBoundary` forwards via
 * `Sentry.captureException`) were silently dropped because no client
 * existed yet. Runs in parallel with the i18n catalog load, so hydration
 * isn't delayed by the extra chunk fetch.
 */
async function initClientSentry() {
  const dsn = env('NEXT_PUBLIC_SENTRY_DSN');

  if (!dsn) {
    return;
  }

  const Sentry = await import('@sentry/react');

  const scrubBeforeSend = buildSentryBeforeSend();

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Deliberately no tracesSampleRate / browserTracingIntegration:
    // this ticket (DEV-2839) scopes to error monitoring only. See the
    // matching comment in apps/remix/server/sentry.ts -- `beforeSend`
    // below never fires for transaction/span events, so enabling
    // tracing here without a `beforeSendTransaction` scrubber would
    // ship unscrubbed page URLs (including query-string tokens, e.g.
    // the embed-authoring routes' presigned tokens) to Sentry.
    sendDefaultPii: false,
    // See the matching comment in apps/remix/server/sentry.ts -- same
    // narrow adapter cast, same reason (scrub.ts has zero Sentry SDK
    // dependency on purpose).
    beforeSend: (event) => scrubBeforeSend(event as unknown as ScrubbableSentryEvent) as unknown as SentryErrorEvent,
  });

  Sentry.setTag('service_name', 'reeve-sign');
  Sentry.setTag('host_app', 'reeve');
}

async function main() {
  const locale = detect(fromHtmlTag('lang')) || 'en';

  // Monitoring must never block the app: if the `@sentry/react` chunk fails
  // to load (ad blocker, flaky network), log and hydrate anyway.
  await Promise.all([
    dynamicActivate(locale),
    initClientSentry().catch((err) => console.error('[sentry] client init failed', err)),
  ]);

  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <I18nProvider i18n={i18n}>
          <HydratedRouter />
        </I18nProvider>

        <PosthogInit />
      </StrictMode>,
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
