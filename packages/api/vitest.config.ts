import { lingui } from '@lingui/vite-plugin';
import macrosPlugin from 'vite-plugin-babel-macros';
import { defineConfig } from 'vitest/config';

// packages/api/v1/schema.ts transitively imports @documenso/lib's
// constants/i18n.ts, which calls the `@lingui/core/macro` `msg` tag at
// module load time. Without this compile-time transform, `msg` is not a
// real function under plain Node/Vitest SSR and throws "msg is not a
// function" on import -- the same fix packages/auth/vitest.config.ts and
// packages/lib/vitest.config.ts already apply (DEV-8741).
export default defineConfig({
  plugins: [macrosPlugin(), lingui()],
  test: {
    include: ['**/*.test.ts'],
  },
});
