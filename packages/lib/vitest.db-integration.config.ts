import { lingui } from '@lingui/vite-plugin';
import macrosPlugin from 'vite-plugin-babel-macros';
import { defineConfig } from 'vitest/config';

// Dedicated project for suites that hit a real Postgres database (not MinIO
// -- see vitest.integration.config.ts for that) and are excluded from the
// default `npm test` (see vitest.config.ts). Run explicitly via
// `npm run test:db-integration -w @documenso/lib`, with NEXT_PRIVATE_DATABASE_URL
// pointed at a live, migrated, isolated database and RUN_DB_INTEGRATION_TESTS=true
// set (the suite self-gates on that flag and fails loudly rather than silently
// skipping once selected -- see the suite's own doc comment). Kept in its own
// config file, separate from the MinIO one, so running this never requires a
// live MinIO endpoint too.
export default defineConfig({
  plugins: [macrosPlugin(), lingui()],
  test: {
    include: [
      '**/server-only/document/conditional-visibility-consent.integration.test.ts',
      '**/server-only/template/create-document-from-direct-template.integration.test.ts',
      '**/server-only/envelope/duplicate-envelope.integration.test.ts',
      '**/server-only/recipient/get-handoff-eligibility.integration.test.ts',
    ],
  },
});
