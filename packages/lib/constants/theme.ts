import type { TCssVarsSchema } from '../types/css-vars';

/**
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 *
 * KEEP THIS FILE IN SYNC WITH `packages/ui/styles/theme.css`.
 *
 * These are the light-mode default values for the CSS custom properties
 * defined under `:root` in the theme stylesheet, exposed here as hex strings
 * so they can be used as defaults for colour-picker UI components and other
 * places that don't render through CSS variables.
 *
 * If you change a value in `theme.css`, update it here too. There is NO
 * automated check linking the two files; they have drifted historically
 * and will drift again unless you update both.
 *
 * Computed via `colord({ h, s, l }).toHex()` — see the inline HSL comments
 * for the source-of-truth values from `theme.css`.
 *
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 */
type HslTriplet = { h: number; s: number; l: number };

/**
 * The static brand primary as an HSL triplet — the SAME source-of-truth
 * values as `theme.css`'s `--primary` / `--ring` / `--brand` defaults
 * (`189.5 49.4% 32.5%`). Kept as HSL rather than a hex literal so this file
 * carries no brand hex: runtime brand chrome is sourced from the
 * host_app_brands registry (DEV-5616) and these values are only the static
 * fallback used when no registry override is configured.
 */
const BRAND_PRIMARY_HSL: HslTriplet = { h: 189.5, s: 49.4, l: 32.5 };

/**
 * Minimal HSL → hex conversion (CSS Color 4 algorithm), matching what
 * `colord({ h, s, l }).toHex()` produces for the values used here. Local to
 * avoid adding a `colord` dependency to `@documenso/lib`.
 */
const hslToHex = ({ h, s, l }: HslTriplet): string => {
  const saturation = s / 100;
  const lightness = l / 100;

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const huePrime = h / 60;
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1));
  const m = lightness - chroma / 2;

  const [r, g, b] =
    huePrime < 1
      ? [chroma, x, 0]
      : huePrime < 2
        ? [x, chroma, 0]
        : huePrime < 3
          ? [0, chroma, x]
          : huePrime < 4
            ? [0, x, chroma]
            : huePrime < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];

  const toChannel = (value: number) =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${toChannel(r)}${toChannel(g)}${toChannel(b)}`;
};

export const DEFAULT_BRAND_COLORS = {
  background: '#ffffff', //              0 0% 100%
  foreground: '#0f172a', //              222.2 47.4% 11.2%
  muted: '#f1f5f9', //                   210 40% 96.1%
  mutedForeground: '#64748b', //         215.4 16.3% 46.9%
  popover: '#ffffff', //                 0 0% 100%
  popoverForeground: '#0f172a', //       222.2 47.4% 11.2%
  card: '#ffffff', //                    0 0% 100%
  cardBorder: '#e2e8f0', //              214.3 31.8% 91.4%
  cardForeground: '#0f172a', //          222.2 47.4% 11.2%
  fieldCard: '#e3f2f4', //               189 49% 92%
  fieldCardBorder: '#3a9aab', //         189.5 49.4% 45%
  fieldCardForeground: '#0f172a', //     222.2 47.4% 11.2%
  widget: '#f7f7f7', //                  0 0% 97%
  widgetForeground: '#f2f2f2', //        0 0% 95%
  border: '#e2e8f0', //                  214.3 31.8% 91.4%
  input: '#e2e8f0', //                   214.3 31.8% 91.4%
  primary: hslToHex(BRAND_PRIMARY_HSL), // #2a6f7c — 189.5 49.4% 32.5%
  primaryForeground: '#ffffff', //       0 0% 100%
  secondary: '#f1f5f9', //               210 40% 96.1%
  secondaryForeground: '#0f172a', //     222.2 47.4% 11.2%
  accent: '#f1f5f9', //                  210 40% 96.1%
  accentForeground: '#0f172a', //        222.2 47.4% 11.2%
  destructive: '#ff0000', //             0 100% 50%
  destructiveForeground: '#f8fafc', //   210 40% 98%
  ring: hslToHex(BRAND_PRIMARY_HSL), //  #2a6f7c — 189.5 49.4% 32.5%
  warning: '#e1cb05', //                 54 96% 45%
  envelopeEditorBackground: '#f8fafc', //210 40% 98.04%
  // `cardBorderTint` is intentionally excluded from the colour-picker UI:
  // unlike the rest of these tokens it is consumed via `rgb(var(--token))`
  // (not `hsl(...)`) and stored as raw RGB triplets in `theme.css`. It does
  // not flow through `toNativeCssVars` and is not user-customisable from the
  // branding form. `radius` is a length, not a colour, so it lives in
  // `DEFAULT_BRAND_RADIUS` below.
} as const satisfies Record<keyof Omit<TCssVarsSchema, 'radius' | 'cardBorderTint'>, string>;

export const DEFAULT_BRAND_RADIUS = '0.5rem';
