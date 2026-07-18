import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../errors/app-error';
import { assertLocalhostFallbackAllowed } from './env';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('assertLocalhostFallbackAllowed', () => {
  it('throws an AppError in production, naming the variable and the refused fallback', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => assertLocalhostFallbackAllowed('NEXT_PRIVATE_SMTP_HOST', '127.0.0.1:2500')).toThrowError(
      /NEXT_PRIVATE_SMTP_HOST.*127\.0\.0\.1:2500/s,
    );

    try {
      assertLocalhostFallbackAllowed('NEXT_PRIVATE_SMTP_HOST', '127.0.0.1:2500');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(AppErrorCode.NOT_SETUP);
    }
  });

  it('allows the fallback in development', () => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(() => assertLocalhostFallbackAllowed('NEXT_PRIVATE_SMTP_HOST', '127.0.0.1:2500')).not.toThrow();
  });

  it('allows the fallback in test', () => {
    vi.stubEnv('NODE_ENV', 'test');

    expect(() => assertLocalhostFallbackAllowed('NEXT_PUBLIC_WEBAPP_URL', 'http://localhost:3000')).not.toThrow();
  });

  // NODE_ENV is not part of the public env payload, so the browser cannot tell
  // production from dev. Throwing there would break every render.
  it('never throws in the browser, even when NODE_ENV is production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubGlobal('window', { __ENV__: {} });

    expect(() => assertLocalhostFallbackAllowed('NEXT_PUBLIC_WEBAPP_URL', 'http://localhost:3000')).not.toThrow();
  });
});

describe('NEXT_PUBLIC_WEBAPP_URL', () => {
  // Re-imported per case so each one is isolated.
  const importWebappUrl = async (cacheBust: string) => {
    const mod = await import(`../constants/app?${cacheBust}`);

    return mod.NEXT_PUBLIC_WEBAPP_URL as () => string;
  };

  it('returns the configured URL in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_WEBAPP_URL', 'https://sign.meetreeve.com');

    const NEXT_PUBLIC_WEBAPP_URL = await importWebappUrl('a1');

    expect(NEXT_PUBLIC_WEBAPP_URL()).toBe('https://sign.meetreeve.com');
  });

  it('throws instead of minting localhost links in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_WEBAPP_URL', undefined);

    const NEXT_PUBLIC_WEBAPP_URL = await importWebappUrl('a2');

    expect(() => NEXT_PUBLIC_WEBAPP_URL()).toThrowError(/NEXT_PUBLIC_WEBAPP_URL/);
  });

  it('treats an empty string as unset in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_WEBAPP_URL', '');

    const NEXT_PUBLIC_WEBAPP_URL = await importWebappUrl('a3');

    expect(() => NEXT_PUBLIC_WEBAPP_URL()).toThrowError(/NEXT_PUBLIC_WEBAPP_URL/);
  });

  it('keeps the localhost default for local dev', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_WEBAPP_URL', undefined);

    const NEXT_PUBLIC_WEBAPP_URL = await importWebappUrl('a4');

    expect(NEXT_PUBLIC_WEBAPP_URL()).toBe('http://localhost:3000');
  });
});

describe('getBaseUrl', () => {
  const importGetBaseUrl = async (cacheBust: string) => {
    const mod = await import(`../universal/get-base-url?${cacheBust}`);

    return mod.getBaseUrl as () => string;
  };

  it('throws rather than falling back to localhost during production SSR', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_WEBAPP_URL', undefined);

    const getBaseUrl = await importGetBaseUrl('b1');

    expect(() => getBaseUrl()).toThrowError(/NEXT_PUBLIC_WEBAPP_URL/);
  });

  it('still serves the localhost default in dev', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_WEBAPP_URL', undefined);

    const getBaseUrl = await importGetBaseUrl('b2');

    expect(getBaseUrl()).toBe('http://localhost:3000');
  });
});
