import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { getReeveAdminSystemUser } from './get-reeve-admin-system-user';

const { getUserByEmailMock } = vi.hoisted(() => ({
  getUserByEmailMock: vi.fn(),
}));

vi.mock('../user/get-user-by-email', () => ({
  getUserByEmail: getUserByEmailMock,
}));

const ENV_KEY = 'REEVE_SIGN_SYSTEM_USER_EMAIL';

describe('getReeveAdminSystemUser', () => {
  const originalValue = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
    getUserByEmailMock.mockReset();
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  it('fails loud when REEVE_SIGN_SYSTEM_USER_EMAIL is unset', async () => {
    await expect(getReeveAdminSystemUser()).rejects.toThrow(AppError);
    expect(getUserByEmailMock).not.toHaveBeenCalled();
  });

  it('fails loud when the configured system user does not exist', async () => {
    process.env[ENV_KEY] = 'reeve-provisioner@meetreeve.com';
    getUserByEmailMock.mockRejectedValue(new Error('No user found'));

    await expect(getReeveAdminSystemUser()).rejects.toThrow(AppError);

    try {
      await getReeveAdminSystemUser();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe(AppErrorCode.NOT_SETUP);
    }
  });

  it('resolves the user when configured correctly', async () => {
    process.env[ENV_KEY] = 'reeve-provisioner@meetreeve.com';
    getUserByEmailMock.mockResolvedValue({ id: 42, email: 'reeve-provisioner@meetreeve.com' });

    const user = await getReeveAdminSystemUser();

    expect(user.id).toBe(42);
    expect(getUserByEmailMock).toHaveBeenCalledWith({ email: 'reeve-provisioner@meetreeve.com' });
  });
});
