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
    // This specific suite hits a real external S3-compatible store (MinIO)
    // over the network and must never run as part of the default unit
    // suite -- see `npm run test:integration` / vitest.integration.config.ts.
    // Scoped to this exact file (not a blanket `*.integration.test.ts`
    // exclude) so self-contained "integration" suites that spin up their
    // own in-process server (e.g. server-only/credits/client.integration.test.ts)
    // keep running as part of the default suite -- they need no live
    // external infra and were never the problem.
    exclude: [...configDefaults.exclude, '**/server-only/field/finalize-field-file-upload.integration.test.ts'],
  },
});
