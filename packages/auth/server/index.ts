import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { extractRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { oidcOnlyGuard } from './lib/oidc-only-guard';
import { setCsrfCookie } from './lib/session/session-cookies';
import { accountRoute } from './routes/account';
import { callbackRoute } from './routes/callback';
import { emailPasswordRoute } from './routes/email-password';
import { oauthRoute } from './routes/oauth';
import { passkeyRoute } from './routes/passkey';
import { sessionRoute } from './routes/session';
import { signOutRoute } from './routes/sign-out';
import { twoFactorRoute } from './routes/two-factor';
import type { HonoAuthContext } from './types/context';

// Note: You must chain routes for Hono RPC client to work.
export const auth = new Hono<HonoAuthContext>()
  .use(async (c, next) => {
    c.set('requestMetadata', extractRequestMetadata(c.req.raw));

    const validOrigin = new URL(NEXT_PUBLIC_WEBAPP_URL()).origin;
    const headerOrigin = c.req.header('Origin');

    if (headerOrigin && headerOrigin !== validOrigin) {
      return c.json(
        {
          message: 'Forbidden',
          statusCode: 403,
        },
        403,
      );
    }

    await next();
  })
  // DEV-2904: defense-in-depth — reject password/passkey/social auth
  // server-side when OIDC-only mode is active. Must be registered before the
  // route chain below so it short-circuits ahead of the real handlers.
  // /oauth/authorize/oidc and /oauth/authorize/oidc/org/:orgUrl are
  // intentionally not in this list and must stay open.
  .use('/email-password/authorize', oidcOnlyGuard)
  .use('/email-password/signup', oidcOnlyGuard)
  .use('/email-password/forgot-password', oidcOnlyGuard)
  .use('/email-password/reset-password', oidcOnlyGuard)
  .use('/email-password/update-password', oidcOnlyGuard)
  .use('/passkey/authorize', oidcOnlyGuard)
  .use('/oauth/authorize/google', oidcOnlyGuard)
  .use('/oauth/authorize/microsoft', oidcOnlyGuard)
  .get('/csrf', async (c) => {
    const csrfToken = await setCsrfCookie(c);

    return c.json({ csrfToken });
  })
  .route('/', sessionRoute)
  .route('/', signOutRoute)
  .route('/', accountRoute)
  .route('/callback', callbackRoute)
  .route('/oauth', oauthRoute)
  .route('/email-password', emailPasswordRoute)
  .route('/passkey', passkeyRoute)
  .route('/two-factor', twoFactorRoute);

/**
 * Handle errors.
 */
auth.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json(
      {
        code: AppErrorCode.UNKNOWN_ERROR,
        message: err.message,
        statusCode: err.status,
      },
      err.status,
    );
  }

  if (err instanceof AppError) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const statusCode = (err.statusCode || 500) as ContentfulStatusCode;

    return c.json(
      {
        code: err.code,
        message: err.message,
        statusCode: err.statusCode,
      },
      statusCode,
    );
  }

  // Handle other errors
  console.error('Unknown Error:', err);
  return c.json(
    {
      code: AppErrorCode.UNKNOWN_ERROR,
      message: 'Internal Server Error',
      statusCode: 500,
    },
    500,
  );
});

export type AuthAppType = typeof auth;
