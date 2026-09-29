import { createRateLimit } from './rate-limit';

// ---- Auth (Tier 1 - Critical, sends emails) ----

export const signupRateLimit = createRateLimit({
  action: 'auth.signup',
  max: 3,
  window: '3h',
});

export const forgotPasswordRateLimit = createRateLimit({
  action: 'auth.forgot-password',
  max: 3,
  globalMax: 20,
  window: '1h',
});

export const resendVerifyEmailRateLimit = createRateLimit({
  action: 'auth.resend-verify-email',
  max: 3,
  globalMax: 20,
  window: '1h',
});

export const request2FAEmailRateLimit = createRateLimit({
  action: 'auth.request-2fa-email',
  max: 5,
  globalMax: 20,
  window: '15m',
});

// ---- Auth (Tier 2 - Unauthenticated) ----

export const loginRateLimit = createRateLimit({
  action: 'auth.login',
  max: 10,
  globalMax: 50,
  window: '15m',
});

export const resetPasswordRateLimit = createRateLimit({
  action: 'auth.reset-password',
  max: 5,
  globalMax: 20,
  window: '1h',
});

export const verifyEmailRateLimit = createRateLimit({
  action: 'auth.verify-email',
  max: 5,
  globalMax: 20,
  window: '15m',
});

export const passkeyRateLimit = createRateLimit({
  action: 'auth.passkey',
  max: 10,
  globalMax: 50,
  window: '15m',
});

export const linkOrgAccountRateLimit = createRateLimit({
  action: 'auth.link-org-account',
  max: 5,
  globalMax: 20,
  window: '1h',
});

// ---- API (Tier 4 - Standard) ----

export const apiV1RateLimit = createRateLimit({
  action: 'api.v1',
  max: 100,
  window: '1m',
});

export const apiV2RateLimit = createRateLimit({
  action: 'api.v2',
  max: 100,
  window: '1m',
});

export const apiTrpcRateLimit = createRateLimit({
  action: 'api.trpc',
  max: 100,
  window: '1m',
});

export const aiRateLimit = createRateLimit({
  action: 'api.ai',
  max: 3,
  window: '1m',
});

export const fileUploadRateLimit = createRateLimit({
  action: 'api.file-upload',
  max: 20,
  window: '1m',
});

// ---- Public direct-template file upload (anonymous) ----

/**
 * A direct-template link is a public bearer URL, so its FILE_UPLOAD presign is
 * effectively an anonymous upload endpoint. Per IP is the tight bound; per
 * link token is deliberately loose, because every legitimate visitor of a
 * popular template shares that one counter and a tight cap would let a single
 * abuser lock them all out. The token cap still bounds how fast one template
 * can accumulate tmp uploads (200 x 15MB/h), and the tmp sweep
 * (`internal.sweep-field-file-upload-tmp`) reclaims anything never finalized.
 */
export const DIRECT_TEMPLATE_FILE_UPLOAD_MAX_PER_IP = 10;
export const DIRECT_TEMPLATE_FILE_UPLOAD_MAX_PER_TOKEN = 200;
export const DIRECT_TEMPLATE_FILE_UPLOAD_WINDOW = '1h';

// With an identifier, `createRateLimit` checks the IP counter against
// `globalMax` and the identifier (link token) counter against `max`.
export const directTemplateFileUploadRateLimit = createRateLimit({
  action: 'direct-template.file-upload',
  max: DIRECT_TEMPLATE_FILE_UPLOAD_MAX_PER_TOKEN,
  globalMax: DIRECT_TEMPLATE_FILE_UPLOAD_MAX_PER_IP,
  window: DIRECT_TEMPLATE_FILE_UPLOAD_WINDOW,
});
