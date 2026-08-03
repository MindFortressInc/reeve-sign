import { z } from 'zod';

import { CSS_LENGTH_REGEX } from '../../types/css-vars';
import { env } from '../../utils/env';

/**
 * DEV-5616: runtime brand chrome sourced from reeve-services'
 * `host_app_brands` registry.
 *
 * When `REEVE_BRAND_API_URL` is configured, the Remix root layout
 * (`apps/remix/app/root.tsx`) calls `fetchHostAppBrandCssVars()` and injects
 * the returned declarations as an inline `<style>:root{…}</style>` block.
 * Because that block is un-layered CSS it wins over the `@layer base`
 * defaults in `packages/ui/styles/theme.css`, so editing the brand row
 * re-themes the app WITHOUT a rebuild.
 *
 * FAIL-OPEN by design: no env var, fetch failure, timeout, or an
 * unparseable response all resolve to `null` — the static `theme.css`
 * defaults (the original Reeve teal) win and the app renders exactly as
 * before. At most one server-side warning is logged, ever.
 *
 * The registry stores ONLY single colors (primary_color,
 * primary_foreground, accent_color, radius, extra_css_vars) — NOT an
 * 11-step ramp. The `--brand-50…950` shades are derived from
 * `primary_color` by re-applying the hue/saturation/lightness offsets of
 * the original teal ramp, so a registry row containing the current default
 * (#2A6F7C) reproduces the static ramp exactly.
 */

/**
 * Base URL of the reeve-services tenant surface serving the public
 * (unauthenticated) `GET /v1/tenant/host-app-brand/{host_app_id}` endpoint,
 * e.g. https://api.meetreeve.com. Unset (self-host / local dev default)
 * disables registry theming entirely — no default points at prod.
 */
export const REEVE_BRAND_API_URL = (): string | undefined => env('REEVE_BRAND_API_URL');

/** host_app_brands row to read. Defaults to the `reeve` row. */
const REEVE_BRAND_HOST_APP_ID = (): string => env('REEVE_BRAND_HOST_APP_ID') || 'reeve';

const DEFAULT_TIMEOUT_MS = 3_000;

/** Per-request timeout for the brand registry fetch. Kept short: this runs in the root loader. */
const REEVE_BRAND_TIMEOUT_MS = (): number => {
  const raw = env('REEVE_BRAND_TIMEOUT_MS');
  const parsed = raw ? parseInt(raw, 10) : NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
};

const SUCCESS_CACHE_TTL_MS = 60 * 60 * 1_000;
const FAILURE_CACHE_TTL_MS = 5 * 60 * 1_000;

const ZHostAppBrandResponseSchema = z.object({
  primary_color: z.string().nullish(),
  primary_foreground: z.string().nullish(),
  accent_color: z.string().nullish(),
  radius: z.string().nullish(),
  extra_css_vars: z.record(z.string()).nullish(),
});

type THostAppBrandResponse = z.infer<typeof ZHostAppBrandResponseSchema>;

type HslTriplet = { h: number; s: number; l: number };

const HEX_COLOR_REGEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Every injected custom property name/value is validated because the result
 * is interpolated raw into a server-rendered `<style>` block — anything
 * outside these shapes is a CSS-injection vector.
 */
const EXTRA_CSS_VAR_NAME_REGEX = /^--[a-z][a-z0-9-]*$/;
const EXTRA_CSS_VAR_VALUE_REGEX = /^[^;{}<>]{1,128}$/;

/**
 * The original Reeve teal ramp expressed in HSL — the SAME values as the
 * `--brand*` defaults in `packages/ui/styles/theme.css`. `base` is the
 * DEFAULT/600 shade (#2A6F7C); each step's offsets from `base` are re-applied
 * to the registry's `primary_color` to derive its ramp.
 */
const BASE_RAMP_PRIMARY: HslTriplet = { h: 189.5, s: 49.4, l: 32.5 };

const BASE_RAMP_STEPS: Array<{ shade: string } & HslTriplet> = [
  { shade: '50', h: 187.5, s: 36.4, l: 95.7 },
  { shade: '100', h: 189, s: 37, l: 89.4 },
  { shade: '200', h: 186.5, s: 35.2, l: 79.4 },
  { shade: '300', h: 188.3, s: 34.1, l: 66.7 },
  { shade: '400', h: 188.6, s: 30.7, l: 50.8 },
  { shade: '500', h: 189.9, s: 42.3, l: 39.4 },
  { shade: '600', h: 189.5, s: 49.4, l: 32.5 },
  { shade: '700', h: 189.2, s: 48.1, l: 26.5 },
  { shade: '800', h: 189.4, s: 45.1, l: 22.2 },
  { shade: '900', h: 190.5, s: 40.8, l: 19.2 },
  { shade: '950', h: 190.7, s: 48.3, l: 11.4 },
];

const roundTo1 = (value: number) => Math.round(value * 10) / 10;

const wrapHue = (value: number) => ((value % 360) + 360) % 360;

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const hexToHsl = (hex: string): HslTriplet | null => {
  if (!HEX_COLOR_REGEX.test(hex)) {
    return null;
  }

  const normalized =
    hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;

  const r = parseInt(normalized.slice(1, 3), 16) / 255;
  const g = parseInt(normalized.slice(3, 5), 16) / 255;
  const b = parseInt(normalized.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  let h = 0;

  if (delta !== 0) {
    if (max === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
  }

  return { h: roundTo1(wrapHue(h)), s: roundTo1(s * 100), l: roundTo1(l * 100) };
};

/** Space-separated HSL triplet, the exact format `hsl(var(--token))` consumes. */
const toTripletString = ({ h, s, l }: HslTriplet): string =>
  `${roundTo1(wrapHue(h))} ${roundTo1(clampPercent(s))}% ${roundTo1(clampPercent(l))}%`;

const deriveBrandRampVars = (primary: HslTriplet): Record<string, string> => {
  const vars: Record<string, string> = {
    '--brand': toTripletString(primary),
  };

  for (const step of BASE_RAMP_STEPS) {
    vars[`--brand-${step.shade}`] = toTripletString({
      h: primary.h + (step.h - BASE_RAMP_PRIMARY.h),
      s: primary.s + (step.s - BASE_RAMP_PRIMARY.s),
      l: primary.l + (step.l - BASE_RAMP_PRIMARY.l),
    });
  }

  return vars;
};

const brandToCssVars = (brand: THostAppBrandResponse): Record<string, string> => {
  const vars: Record<string, string> = {};

  const primary = brand.primary_color ? hexToHsl(brand.primary_color) : null;

  if (primary) {
    Object.assign(vars, deriveBrandRampVars(primary));

    vars['--primary'] = toTripletString(primary);
    vars['--ring'] = toTripletString(primary);
  }

  const primaryForeground = brand.primary_foreground ? hexToHsl(brand.primary_foreground) : null;

  if (primaryForeground) {
    vars['--primary-foreground'] = toTripletString(primaryForeground);
  }

  // `accent_color` is deliberately NOT mapped: in this design system
  // `--accent` is a muted hover/surface tone (210 40% 96.1%), not a brand
  // accent — writing a saturated registry accent (e.g. #F77F00) into it would
  // repaint every dropdown/hover surface. Reachable via `extra_css_vars` when
  // genuinely wanted.

  if (brand.radius && CSS_LENGTH_REGEX.test(brand.radius)) {
    vars['--radius'] = brand.radius;
  }

  for (const [key, value] of Object.entries(brand.extra_css_vars ?? {})) {
    if (EXTRA_CSS_VAR_NAME_REGEX.test(key) && EXTRA_CSS_VAR_VALUE_REGEX.test(value)) {
      vars[key] = value;
    }
  }

  return vars;
};

const fetchBrandRow = async (baseUrl: string): Promise<THostAppBrandResponse> => {
  const hostAppId = REEVE_BRAND_HOST_APP_ID();

  const endpoint = new URL(
    `/v1/tenant/host-app-brand/${encodeURIComponent(hostAppId)}`,
    baseUrl,
  ).toString();

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REEVE_BRAND_TIMEOUT_MS());

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    throw new Error(`Brand registry returned ${response.status}`);
  }

  const parsed = ZHostAppBrandResponseSchema.safeParse(await response.json());

  if (!parsed.success) {
    throw new Error('Brand registry response did not match the expected shape');
  }

  return parsed.data;
};

type BrandCacheEntry = { cssVars: string | null; expiresAt: number };

let brandCache: BrandCacheEntry | null = null;

let hasWarnedFetchFailure = false;

/**
 * Returns the registry-derived CSS custom property declarations as a single
 * string (e.g. `--brand: 189.5 49.4% 32.5%; --primary: …;`), or `null` when
 * the registry is unconfigured/unreachable (fail-open — static `theme.css`
 * defaults win). Successful lookups are cached in-memory for ~1h; failures
 * for 5 minutes so a transient blip doesn't pin defaults for a full hour.
 */
export const fetchHostAppBrandCssVars = async (): Promise<string | null> => {
  const baseUrl = REEVE_BRAND_API_URL();

  if (!baseUrl) {
    return null;
  }

  const now = Date.now();

  if (brandCache && brandCache.expiresAt > now) {
    return brandCache.cssVars;
  }

  try {
    const brand = await fetchBrandRow(baseUrl);
    const vars = brandToCssVars(brand);

    const cssVars =
      Object.keys(vars).length > 0
        ? Object.entries(vars)
            .map(([key, value]) => `${key}: ${value};`)
            .join(' ')
        : null;

    brandCache = { cssVars, expiresAt: now + SUCCESS_CACHE_TTL_MS };

    return cssVars;
  } catch (err) {
    if (!hasWarnedFetchFailure) {
      hasWarnedFetchFailure = true;

      console.warn(
        `[host-app-brand] Falling back to static theme defaults: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    brandCache = { cssVars: null, expiresAt: now + FAILURE_CACHE_TTL_MS };

    return null;
  }
};
