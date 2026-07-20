import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isReeveAdminProvisioningConfigured, isReeveAdminTokenValid } from './reeve-admin-token';

const ENV_KEY = 'REEVE_SIGN_ADMIN_TOKEN';

describe('reeve-admin-token', () => {
  const originalValue = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  describe('isReeveAdminProvisioningConfigured', () => {
    it('fails closed: returns false when REEVE_SIGN_ADMIN_TOKEN is unset', () => {
      expect(isReeveAdminProvisioningConfigured()).toBe(false);
    });

    it('fails closed: returns false when REEVE_SIGN_ADMIN_TOKEN is empty string', () => {
      process.env[ENV_KEY] = '';
      expect(isReeveAdminProvisioningConfigured()).toBe(false);
    });

    it('returns true when REEVE_SIGN_ADMIN_TOKEN is set', () => {
      process.env[ENV_KEY] = 'a-real-secret-token';
      expect(isReeveAdminProvisioningConfigured()).toBe(true);
    });
  });

  describe('isReeveAdminTokenValid', () => {
    it('fails closed: rejects any token when REEVE_SIGN_ADMIN_TOKEN is unset', () => {
      expect(isReeveAdminTokenValid('anything')).toBe(false);
      expect(isReeveAdminTokenValid(null)).toBe(false);
      expect(isReeveAdminTokenValid(undefined)).toBe(false);
    });

    it('rejects a missing provided token when configured', () => {
      process.env[ENV_KEY] = 'correct-token';
      expect(isReeveAdminTokenValid(null)).toBe(false);
      expect(isReeveAdminTokenValid(undefined)).toBe(false);
      expect(isReeveAdminTokenValid('')).toBe(false);
    });

    it('rejects a wrong token when configured', () => {
      process.env[ENV_KEY] = 'correct-token';
      expect(isReeveAdminTokenValid('wrong-token')).toBe(false);
    });

    it('rejects a token that only differs in length', () => {
      process.env[ENV_KEY] = 'correct-token';
      expect(isReeveAdminTokenValid('correct-token-extra')).toBe(false);
      expect(isReeveAdminTokenValid('correct')).toBe(false);
    });

    it('accepts the exact correct token when configured', () => {
      process.env[ENV_KEY] = 'correct-token';
      expect(isReeveAdminTokenValid('correct-token')).toBe(true);
    });
  });
});
