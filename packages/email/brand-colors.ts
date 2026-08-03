/**
 * Email-safe static brand ramp (DEV-5616).
 *
 * The app's `brand` Tailwind token resolves through CSS variables
 * (`hsl(var(--brand-*))`) so the host_app_brands registry can re-theme the
 * web app at runtime — but email clients cannot resolve CSS custom
 * properties, so rendered emails pin the static defaults from
 * `packages/ui/styles/theme.css` as concrete hex values here.
 *
 * KEEP IN SYNC with the `--brand*` defaults in
 * `packages/ui/styles/theme.css` (and the duplicate in
 * `packages/email/tailwind.config.js` used by the react-email dev preview).
 */
export const emailBrandColors = {
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
} as const;
