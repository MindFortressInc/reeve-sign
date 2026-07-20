import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IS_CREDITS_METERING_ENABLED,
  REEVE_CREDITS_API_URL,
  REEVE_CREDITS_TIMEOUT_MS,
  REEVE_SIGN_HOST_KEY,
  REEVE_SIGN_SEND_CREDITS_COST,
} from './credits';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('IS_CREDITS_METERING_ENABLED', () => {
  it('is disabled when neither env var is set', () => {
    vi.stubEnv('REEVE_CREDITS_API_URL', '');
    vi.stubEnv('REEVE_SIGN_HOST_KEY', '');

    expect(IS_CREDITS_METERING_ENABLED()).toBe(false);
  });

  it('is disabled when only the URL is set', () => {
    vi.stubEnv('REEVE_CREDITS_API_URL', 'https://api.meetreeve.com');
    vi.stubEnv('REEVE_SIGN_HOST_KEY', '');

    expect(IS_CREDITS_METERING_ENABLED()).toBe(false);
  });

  it('is disabled when only the host key is set', () => {
    vi.stubEnv('REEVE_CREDITS_API_URL', '');
    vi.stubEnv('REEVE_SIGN_HOST_KEY', 'sign_hostkey_123');

    expect(IS_CREDITS_METERING_ENABLED()).toBe(false);
  });

  it('is enabled when both env vars are set', () => {
    vi.stubEnv('REEVE_CREDITS_API_URL', 'https://api.meetreeve.com');
    vi.stubEnv('REEVE_SIGN_HOST_KEY', 'sign_hostkey_123');

    expect(IS_CREDITS_METERING_ENABLED()).toBe(true);
    expect(REEVE_CREDITS_API_URL()).toBe('https://api.meetreeve.com');
    expect(REEVE_SIGN_HOST_KEY()).toBe('sign_hostkey_123');
  });
});

describe('REEVE_SIGN_SEND_CREDITS_COST', () => {
  it('defaults to 500 (the commerce_bootstrap.py SSOT rate) when unset', () => {
    vi.stubEnv('REEVE_SIGN_SEND_CREDITS_COST', '');

    expect(REEVE_SIGN_SEND_CREDITS_COST()).toBe(500);
  });

  it('respects an env override', () => {
    vi.stubEnv('REEVE_SIGN_SEND_CREDITS_COST', '750');

    expect(REEVE_SIGN_SEND_CREDITS_COST()).toBe(750);
  });

  it('falls back to the default for a non-numeric override', () => {
    vi.stubEnv('REEVE_SIGN_SEND_CREDITS_COST', 'not-a-number');

    expect(REEVE_SIGN_SEND_CREDITS_COST()).toBe(500);
  });

  it('falls back to the default for a zero or negative override', () => {
    vi.stubEnv('REEVE_SIGN_SEND_CREDITS_COST', '0');
    expect(REEVE_SIGN_SEND_CREDITS_COST()).toBe(500);

    vi.stubEnv('REEVE_SIGN_SEND_CREDITS_COST', '-10');
    expect(REEVE_SIGN_SEND_CREDITS_COST()).toBe(500);
  });
});

describe('REEVE_CREDITS_TIMEOUT_MS', () => {
  it('defaults to 10000ms when unset', () => {
    vi.stubEnv('REEVE_CREDITS_TIMEOUT_MS', '');

    expect(REEVE_CREDITS_TIMEOUT_MS()).toBe(10_000);
  });

  it('respects an env override', () => {
    vi.stubEnv('REEVE_CREDITS_TIMEOUT_MS', '5000');

    expect(REEVE_CREDITS_TIMEOUT_MS()).toBe(5000);
  });
});
