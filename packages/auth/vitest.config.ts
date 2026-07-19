import { lingui } from '@lingui/vite-plugin';
import macrosPlugin from 'vite-plugin-babel-macros';
import { defineConfig } from 'vitest/config';

// The auth app's route handlers transitively import job/email definitions
// that use @lingui/macro (e.g. `msg\`...\``). Those need the same
// compile-time macro transform apps/remix/vite.config.ts uses, or importing
// them under a plain Node/Vitest SSR transform throws "msg is not a
// function".
export default defineConfig({
  plugins: [macrosPlugin(), lingui()],
  test: {
    include: ['**/*.test.ts'],
    // packages/lib/client-only/providers/i18n-server.tsx eagerly kicks off
    // `Promise.all(SUPPORTED_LANGUAGE_CODES.map(loadCatalog))` at module load
    // time, which dynamic-imports compiled translation catalogs
    // (`../../translations/${lang}/web.mjs`). That variable dynamic import
    // only resolves under apps/remix's full Vite build graph, not a
    // package-local Vitest run, so it rejects here as an unrelated
    // background unhandled rejection. Rather than blanket-silencing all
    // unhandled rejections (which would also hide genuine failures in future
    // tests), vitest.setup.ts mocks that module so the eager catalog load
    // never runs, keeping real unhandled rejections visible.
    setupFiles: ['./vitest.setup.ts'],
  },
});
