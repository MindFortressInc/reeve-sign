import { assertLocalhostFallbackAllowed, env } from '@documenso/lib/utils/env';

export const APP_DOCUMENT_UPLOAD_SIZE_LIMIT = Number(env('NEXT_PUBLIC_DOCUMENT_SIZE_UPLOAD_LIMIT')) || 50;

const LOCAL_WEBAPP_URL = 'http://localhost:3000';

export const NEXT_PUBLIC_WEBAPP_URL = () => {
  const webAppUrl = env('NEXT_PUBLIC_WEBAPP_URL');

  if (webAppUrl) {
    return webAppUrl;
  }

  assertLocalhostFallbackAllowed('NEXT_PUBLIC_WEBAPP_URL', LOCAL_WEBAPP_URL);

  return LOCAL_WEBAPP_URL;
};

// A blank value (e.g. `NAME=` copied from .env.example) counts as unset: libpdf
// drops an empty /Reason or /ContactInfo from the signature instead of using it.
export const NEXT_PUBLIC_SIGNING_CONTACT_INFO = () =>
  env('NEXT_PUBLIC_SIGNING_CONTACT_INFO')?.trim() || NEXT_PUBLIC_WEBAPP_URL();

export const NEXT_PUBLIC_SIGNING_REASON = () => env('NEXT_PUBLIC_SIGNING_REASON')?.trim() || 'Signed with Reeve.Sign';

// Product identity for developer- and admin-facing surfaces (OpenAPI titles,
// download filenames, help links). DEV-19567.
export const APP_DISPLAY_NAME = 'Reeve.Sign';

export const APP_FILENAME_PREFIX = 'reeve-sign';

export const APP_DOCS_URL = 'https://docs.meetreeve.com/docs';

export const APP_TERMS_URL = 'https://meetreeve.com/terms';

export const APP_PRIVACY_URL = 'https://meetreeve.com/privacy';

export const NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER = () =>
  env('NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER') === 'true';

export const NEXT_PRIVATE_INTERNAL_WEBAPP_URL = () =>
  env('NEXT_PRIVATE_INTERNAL_WEBAPP_URL') ?? NEXT_PUBLIC_WEBAPP_URL();

export const IS_BILLING_ENABLED = () => env('NEXT_PUBLIC_FEATURE_BILLING_ENABLED') === 'true';

export const API_V2_BETA_URL = '/api/v2-beta';
export const API_V2_URL = '/api/v2';

export const SUPPORT_EMAIL = env('NEXT_PUBLIC_SUPPORT_EMAIL') ?? 'support@meetreeve.com';

export const USE_INTERNAL_URL_BROWSERLESS = () => env('NEXT_PUBLIC_USE_INTERNAL_URL_BROWSERLESS') === 'true';

export const IS_AI_FEATURES_CONFIGURED = () => !!env('GOOGLE_VERTEX_PROJECT_ID') && !!env('GOOGLE_VERTEX_API_KEY');

/**
 * Temporary flag to toggle between Playwright-based and Konva-based PDF generation
 * for audit logs during sealing.
 *
 * @deprecated This is a temporary flag and will be removed once Konva-based generation is stable.
 */
export const NEXT_PRIVATE_USE_PLAYWRIGHT_PDF = () => env('NEXT_PRIVATE_USE_PLAYWRIGHT_PDF') === 'true';

export const NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY = () => env('NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY');
