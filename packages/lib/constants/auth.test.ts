import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const OIDC_ENV = {
  NEXT_PRIVATE_OIDC_WELL_KNOWN: 'https://idp.example.com/.well-known/openid-configuration',
  NEXT_PRIVATE_OIDC_CLIENT_ID: 'client-id',
  NEXT_PRIVATE_OIDC_CLIENT_SECRET: 'client-secret',
};

describe('IS_OIDC_ONLY_AUTH', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('is false when OIDC SSO is not configured', async () => {
    delete process.env.NEXT_PRIVATE_OIDC_WELL_KNOWN;
    delete process.env.NEXT_PRIVATE_OIDC_CLIENT_ID;
    delete process.env.NEXT_PRIVATE_OIDC_CLIENT_SECRET;

    const { IS_OIDC_ONLY_AUTH, IS_OIDC_SSO_ENABLED } = await import('./auth');

    expect(IS_OIDC_SSO_ENABLED).toBe(false);
    expect(IS_OIDC_ONLY_AUTH).toBe(false);
  });

  it('defaults to true when OIDC SSO is configured and no override is set', async () => {
    Object.assign(process.env, OIDC_ENV);
    delete process.env.NEXT_PRIVATE_OIDC_ONLY_AUTH;

    const { IS_OIDC_ONLY_AUTH, IS_OIDC_SSO_ENABLED } = await import('./auth');

    expect(IS_OIDC_SSO_ENABLED).toBe(true);
    expect(IS_OIDC_ONLY_AUTH).toBe(true);
  });

  it('is false when explicitly opted out via NEXT_PRIVATE_OIDC_ONLY_AUTH=false', async () => {
    Object.assign(process.env, OIDC_ENV);
    process.env.NEXT_PRIVATE_OIDC_ONLY_AUTH = 'false';

    const { IS_OIDC_ONLY_AUTH, IS_OIDC_SSO_ENABLED } = await import('./auth');

    expect(IS_OIDC_SSO_ENABLED).toBe(true);
    expect(IS_OIDC_ONLY_AUTH).toBe(false);
  });

  it('stays false when OIDC is not configured even if the override is set to true-ish values', async () => {
    delete process.env.NEXT_PRIVATE_OIDC_WELL_KNOWN;
    delete process.env.NEXT_PRIVATE_OIDC_CLIENT_ID;
    delete process.env.NEXT_PRIVATE_OIDC_CLIENT_SECRET;
    process.env.NEXT_PRIVATE_OIDC_ONLY_AUTH = 'true';

    const { IS_OIDC_ONLY_AUTH } = await import('./auth');

    expect(IS_OIDC_ONLY_AUTH).toBe(false);
  });
});
