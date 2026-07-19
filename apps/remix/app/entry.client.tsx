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
 */
function SentryInit() {
  useEffect(() => {
    const dsn = env('NEXT_PUBLIC_SENTRY_DSN');

    if (dsn) {
      void import('@sentry/react').then((Sentry) => {
        const scrubBeforeSend = buildSentryBeforeSend();

        Sentry.init({
          dsn,
          environment: import.meta.env.MODE,
          tracesSampleRate: 0.1,
          sendDefaultPii: false,
          // See the matching comment in apps/remix/server/sentry.ts -- same
          // narrow adapter cast, same reason (scrub.ts has zero Sentry SDK
          // dependency on purpose).
          beforeSend: (event) =>
            scrubBeforeSend(event as unknown as ScrubbableSentryEvent) as unknown as SentryErrorEvent,
          integrations: [Sentry.browserTracingIntegration()],
        });

        Sentry.setTag('service_name', 'reeve-sign');
        Sentry.setTag('host_app', 'reeve');
      });
    }
  }, []);

  return null;
}

async function main() {
  const locale = detect(fromHtmlTag('lang')) || 'en';

  await dynamicActivate(locale);

  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <I18nProvider i18n={i18n}>
          <HydratedRouter />
        </I18nProvider>

        <PosthogInit />
        <SentryInit />
      </StrictMode>,
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
