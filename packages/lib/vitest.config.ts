import { lingui } from '@lingui/vite-plugin';
import macrosPlugin from 'vite-plugin-babel-macros';
import { defineConfig } from 'vitest/config';

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
  },
});
