import { lingui } from '@lingui/vite-plugin';
import macrosPlugin from 'vite-plugin-babel-macros';
import { defineConfig } from 'vitest/config';

// Same setup as packages/api/vitest.config.ts: routes transitively import
// @documenso/lib modules that call the `@lingui/core/macro` `msg` tag at load
// time. `jsx: automatic` lets tests render real @documenso/email templates.
export default defineConfig({
  plugins: [macrosPlugin(), lingui()],
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['**/*.test.ts'],
  },
});
