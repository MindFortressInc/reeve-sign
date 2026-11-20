import { lingui } from '@lingui/vite-plugin';
import macrosPlugin from 'vite-plugin-babel-macros';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // DEV-9179: component tests import modules that call the `@lingui/core/macro`
  // `msg` tag (the component itself, and `@documenso/lib/constants/i18n` at
  // module load). Without this compile-time transform `msg` is not a real
  // function under plain Node/Vitest and throws on import -- the same two
  // plugins app/vite.config.ts and packages/lib/vitest.config.ts already use.
  plugins: [macrosPlugin(), lingui(), tsconfigPaths()],
  // @documenso/email's tsconfig says `jsx: preserve`, so its templates would
  // compile to classic React.createElement; same fix as packages/trpc's config.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['server/**/*.test.ts', 'app/**/*.test.ts'],
  },
});
