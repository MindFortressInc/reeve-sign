import { IS_OIDC_ONLY_AUTH } from '@documenso/lib/constants/auth';
import type { MiddlewareHandler } from 'hono';

import type { HonoAuthContext } from '../types/context';

/**
 * Paths (relative to the auth Hono app, i.e. before the `/api/auth` mount
 * prefix applied in `apps/remix/server/router.ts`) that must be rejected
 * server-side when `IS_OIDC_ONLY_AUTH` is on. This is defense-in-depth for
 * DEV-2904: the sign-in/sign-up UI already hides these options (DEV-2835),
 * this guard stops a hand-crafted request from reaching the handler too.
 * DEV-4741: the Google/Microsoft callbacks are guarded as well - without
 * them, an attacker driving the IdP consent flow manually could still
 * complete login even though the authorize routes are blocked.
 *
 * Deliberately NOT included (must keep working): `/oauth/authorize/oidc`,
 * `/oauth/authorize/oidc/org/:orgUrl`, `/callback/oidc`,
 * `/callback/oidc/org/:orgUrl`, `/session*`,
 * `/sign-out`, `/account*`, `/email-password/verify-email`,
 * `/email-password/resend-verify-email`, and all `/two-factor/*` routes.
 */
export const OIDC_ONLY_GUARDED_PATHS = [
  '/email-password/authorize',
  '/email-password/signup',
  '/email-password/forgot-password',
  '/email-password/reset-password',
  '/email-password/update-password',
  '/passkey/authorize',
  '/oauth/authorize/google',
  '/oauth/authorize/microsoft',
  '/callback/google',
  '/callback/microsoft',
] as const;

/**
 * Rejects requests to password/passkey/social auth routes when OIDC-only
 * auth mode is active. Mirrors the response shape of the origin-check
 * middleware in `packages/auth/server/index.ts`.
 */
export const oidcOnlyGuard: MiddlewareHandler<HonoAuthContext> = async (c, next) => {
  if (IS_OIDC_ONLY_AUTH) {
    return c.json(
      {
        message: 'Forbidden',
        statusCode: 403,
      },
      403,
    );
  }

  await next();
};
