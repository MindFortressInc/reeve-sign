import { lingui } from '@lingui/vite-plugin';
import macrosPlugin from 'vite-plugin-babel-macros';
import { defineConfig } from 'vitest/config';

// Dedicated project for suites that hit real infra (e.g. MinIO) and are
// excluded from the default `npm test` (see vitest.config.ts). Run
// explicitly via `npm run test:integration -w @documenso/lib`. Each suite
// still self-gates (e.g. RUN_S3_INTEGRATION_TESTS) so an accidental
// invocation without a live endpoint fails loudly instead of silently
// reporting a pass.
export default defineConfig({
  plugins: [macrosPlugin(), lingui()],
  test: {
    include: ['**/server-only/field/finalize-field-file-upload.integration.test.ts'],
  },
});
