/* eslint-disable @typescript-eslint/no-var-requires */
const baseConfig = require('@documenso/tailwind-config');
const path = require('path');

module.exports = {
  ...baseConfig,
  content: [`templates/**/*.{ts,tsx}`],
  theme: {
    ...baseConfig.theme,
    extend: {
      ...baseConfig.theme.extend,
      colors: {
        ...baseConfig.theme.extend.colors,
        // Email clients cannot resolve the CSS-variable-based `brand` token
        // from the shared config, so the react-email dev preview pins the
        // static hex ramp. KEEP IN SYNC with packages/email/brand-colors.ts
        // (the runtime render path) and the `--brand*` defaults in
        // packages/ui/styles/theme.css (DEV-5616).
        brand: {
          DEFAULT: '#2A6F7C',
          50: '#F0F7F8',
          100: '#DAEBEE',
          200: '#B8D9DD',
          300: '#8DBFC7',
          400: '#5B9DA8',
          500: '#3A818F',
          600: '#2A6F7C',
          700: '#235A64',
          800: '#1F4A52',
          900: '#1D3E45',
          950: '#0F262B',
        },
      },
    },
  },
};
