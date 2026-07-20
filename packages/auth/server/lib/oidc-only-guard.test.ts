import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Integration test against the REAL composed Hono auth app
 * (`packages/auth/server/index.ts`), not a stand-in. Every module in that
 * app's import graph is exercised exactly as it is at runtime; the only
 * thing this file controls is env vars (which flip `IS_OIDC_ONLY_AUTH`) and
 * `global.fetch` (so the OIDC discovery call in the pass-through case
 * doesn't hit the network).
 *
 * None of these requests reach a database: the 403 cases are stopped by
 * `oidcOnlyGuard` before any route handler runs, and the pass-through cases
 * either fail schema validation before the handler runs or - for
 * /oauth/authorize/oidc - never touch Prisma at all.
 */

const ORIGINAL_ENV = { ...process.env };

const OIDC_ENV = {
  NEXT_PRIVATE_OIDC_WELL_KNOWN: 'https://idp.example.com/.well-known/openid-configuration',
  NEXT_PRIVATE_OIDC_CLIENT_ID: 'client-id',
  NEXT_PRIVATE_OIDC_CLIENT_SECRET: 'client-secret',
};

const FORBIDDEN_BODY = { message: 'Forbidden', statusCode: 403 };

const BLOCKED_ROUTES: Array<{ path: string; method: 'POST' }> = [
  { path: '/email-password/authorize', method: 'POST' },
  { path: '/email-password/signup', method: 'POST' },
  { path: '/email-password/forgot-password', method: 'POST' },
  { path: '/email-password/reset-password', method: 'POST' },
  { path: '/email-password/update-password', method: 'POST' },
  { path: '/passkey/authorize', method: 'POST' },
  { path: '/oauth/authorize/google', method: 'POST' },
  { path: '/oauth/authorize/microsoft', method: 'POST' },
];

async function loadAuthApp() {
  const mod = await import('../index');

  return mod.auth;
}

function emptyJsonRequest(): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  };
}

describe('oidcOnlyGuard wired into packages/auth/server/index.ts', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  describe('when IS_OIDC_ONLY_AUTH is true', () => {
    beforeEach(() => {
      Object.assign(process.env, OIDC_ENV);
      delete process.env.NEXT_PRIVATE_OIDC_ONLY_AUTH;
    });

    it.each(BLOCKED_ROUTES)('rejects $method $path with 403 Forbidden', async ({ path, method }) => {
      const auth = await loadAuthApp();

      const res = await auth.request(path, { method, headers: { 'content-type': 'application/json' } });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual(FORBIDDEN_BODY);
    });

    it('does not touch /oauth/authorize/oidc - it still returns a redirect payload', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                authorization_endpoint: 'https://idp.example.com/authorize',
                token_endpoint: 'https://idp.example.com/token',
                scopes_supported: ['openid', 'email', 'profile'],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        ),
      );

      const auth = await loadAuthApp();

      const res = await auth.request('/oauth/authorize/oidc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.redirectUrl).toBe('string');
      expect(body.redirectUrl).toContain('https://idp.example.com/authorize');
    });

    it('does not touch /oauth/authorize/oidc/org/:orgUrl path shape (guard list excludes it)', async () => {
      const { OIDC_ONLY_GUARDED_PATHS } = await import('./oidc-only-guard');

      expect(OIDC_ONLY_GUARDED_PATHS).not.toContain('/oauth/authorize/oidc');
      expect(OIDC_ONLY_GUARDED_PATHS.some((p) => p.includes('oidc'))).toBe(false);
    });
  });

  describe('when IS_OIDC_ONLY_AUTH is false', () => {
    it.each(BLOCKED_ROUTES)('does not return the guard 403 for $method $path when OIDC is unconfigured', async ({
      path,
    }) => {
      delete process.env.NEXT_PRIVATE_OIDC_WELL_KNOWN;
      delete process.env.NEXT_PRIVATE_OIDC_CLIENT_ID;
      delete process.env.NEXT_PRIVATE_OIDC_CLIENT_SECRET;

      const auth = await loadAuthApp();

      const res = await auth.request(path, emptyJsonRequest());

      // Falls through to real validation/handler logic instead (schema
      // validation failure or a differently-shaped AppError) - never the
      // guard's Forbidden envelope.
      expect(res.status).not.toBe(403);

      const body = await res.json().catch(() => null);
      expect(body).not.toEqual(FORBIDDEN_BODY);
    });

    it.each(BLOCKED_ROUTES)('does not return the guard 403 for $method $path when explicitly opted out', async ({
      path,
    }) => {
      Object.assign(process.env, OIDC_ENV);
      process.env.NEXT_PRIVATE_OIDC_ONLY_AUTH = 'false';

      const auth = await loadAuthApp();

      const res = await auth.request(path, emptyJsonRequest());

      expect(res.status).not.toBe(403);

      const body = await res.json().catch(() => null);
      expect(body).not.toEqual(FORBIDDEN_BODY);
    });
  });
});
