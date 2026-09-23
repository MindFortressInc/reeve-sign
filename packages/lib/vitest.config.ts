import { lingui } from '@lingui/vite-plugin';
import macrosPlugin from 'vite-plugin-babel-macros';
import { configDefaults, defineConfig } from 'vitest/config';

// DEV-8741: several packages/lib modules (e.g. constants/i18n.ts, used
// transitively by server-only/pdf/render-certificate.ts) call the
// `@lingui/core/macro` `msg` tag at module load time. Without this
// compile-time transform, `msg` is not a real function under plain
// Node/Vitest SSR and throws "msg is not a function" on import -- the same
// problem packages/auth/vitest.config.ts already solves this way.
export default defineConfig({
  plugins: [macrosPlugin(), lingui()],
  test: {
    include: ['**/*.test.ts'],
    // These two specific suites hit real external infra (MinIO; Postgres) and
    // must never run as part of the default unit suite -- see
    // `npm run test:integration` / vitest.integration.config.ts for the MinIO
    // one, `npm run test:db-integration` / vitest.db-integration.config.ts for
    // the Postgres one. Scoped to these exact files (not a blanket
    // `*.integration.test.ts` exclude) so self-contained "integration" suites
    // that spin up their own in-process server (e.g.
    // server-only/credits/client.integration.test.ts) keep running as part of
    // the default suite -- they need no live external infra and were never
    // the problem.
    exclude: [
      ...configDefaults.exclude,
      '**/server-only/field/finalize-field-file-upload.integration.test.ts',
      '**/server-only/document/conditional-visibility-consent.integration.test.ts',
      '**/server-only/template/create-document-from-direct-template.integration.test.ts',
      '**/server-only/envelope/duplicate-envelope.integration.test.ts',
      '**/server-only/recipient/get-handoff-eligibility.integration.test.ts',
    ],
  },
});
