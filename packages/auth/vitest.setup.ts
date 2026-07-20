import { vi } from 'vitest';

// The auth app's route handlers transitively import
// `@documenso/lib/client-only/providers/i18n-server`, which at module-eval time
// eagerly kicks off `Promise.all(SUPPORTED_LANGUAGE_CODES.map(loadCatalog))`.
// `loadCatalog` performs a variable dynamic import of compiled translation
// catalogs (`../../translations/${lang}/web.mjs`) that only resolves inside
// apps/remix's full Vite build graph, so under this package-local Vitest run it
// rejects as an unhandled rejection unrelated to the guard behaviour under test.
//
// Mock the module so that eager load never runs. This lets us keep unhandled
// rejections visible (no `dangerouslyIgnoreUnhandledErrors`) instead of blanket
// silencing them. None of the auth guard tests need real translations: the 403
// cases are short-circuited by `oidcOnlyGuard` before any handler runs, and the
// pass-through cases fail schema validation first.
vi.mock('@documenso/lib/client-only/providers/i18n-server', () => ({
  loadCatalog: vi.fn(async (lang: string) => ({ [lang]: {} })),
  allI18nInstances: Promise.resolve({}),
  getI18nInstance: vi.fn(async () => ({
    // Minimal stub shaped like a @lingui/core I18n instance's `_` translator,
    // in case any pass-through handler reaches it before validation fails.
    _: (message: unknown) => message,
  })),
}));
