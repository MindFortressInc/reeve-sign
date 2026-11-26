import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { getReeveAdminSystemUser, isReeveAdminSystemUserId } from './get-reeve-admin-system-user';

const { getUserByEmailMock, userFindFirstMock } = vi.hoisted(() => ({
  getUserByEmailMock: vi.fn(),
  userFindFirstMock: vi.fn(),
}));

vi.mock('../user/get-user-by-email', () => ({
  getUserByEmail: getUserByEmailMock,
}));

vi.mock('@documenso/prisma', () => ({
  prisma: { user: { findFirst: userFindFirstMock } },
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

// DEV-20496: the where-input builders ask this on every by-id read.
describe('isReeveAdminSystemUserId', () => {
  const originalValue = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
    userFindFirstMock.mockReset();
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  it('is false for everyone, with no lookup, when the email is unset', async () => {
    expect(await isReeveAdminSystemUserId(42)).toBe(false);
    expect(userFindFirstMock).not.toHaveBeenCalled();
  });

  it('is false when the configured email matches no user, and does not memoize the miss', async () => {
    process.env[ENV_KEY] = 'missing-system@reeve.test';
    userFindFirstMock.mockResolvedValue(null);

    expect(await isReeveAdminSystemUserId(42)).toBe(false);
    expect(await isReeveAdminSystemUserId(42)).toBe(false);
    expect(userFindFirstMock).toHaveBeenCalledTimes(2);
  });

  it('matches only the system user id, looking it up once per email', async () => {
    process.env[ENV_KEY] = '  System@Reeve.test ';
    userFindFirstMock.mockResolvedValue({ id: 42 });

    expect(await isReeveAdminSystemUserId(42)).toBe(true);
    expect(await isReeveAdminSystemUserId(7)).toBe(false);
    expect(userFindFirstMock).toHaveBeenCalledTimes(1);
    // The same lookup getUserByEmail (and so provisioning) uses.
    expect(userFindFirstMock).toHaveBeenCalledWith({ where: { email: 'system@reeve.test' }, select: { id: true } });
  });

  it('re-resolves when the configured email changes', async () => {
    process.env[ENV_KEY] = 'first-system@reeve.test';
    userFindFirstMock.mockResolvedValueOnce({ id: 1 });
    expect(await isReeveAdminSystemUserId(1)).toBe(true);

    process.env[ENV_KEY] = 'second-system@reeve.test';
    userFindFirstMock.mockResolvedValueOnce({ id: 2 });
    expect(await isReeveAdminSystemUserId(1)).toBe(false);
    expect(await isReeveAdminSystemUserId(2)).toBe(true);
  });

  it('looks the id up again once the memo expires, so a moved email takes effect', async () => {
    vi.useFakeTimers();

    try {
      process.env[ENV_KEY] = 'moved-system@reeve.test';
      userFindFirstMock.mockResolvedValueOnce({ id: 1 });
      expect(await isReeveAdminSystemUserId(1)).toBe(true);

      // The operator moves the address to another account.
      userFindFirstMock.mockResolvedValueOnce({ id: 2 });
      vi.advanceTimersByTime(59_000);
      expect(await isReeveAdminSystemUserId(1)).toBe(true);

      vi.advanceTimersByTime(2_000);
      expect(await isReeveAdminSystemUserId(1)).toBe(false);
      expect(await isReeveAdminSystemUserId(2)).toBe(true);
      expect(userFindFirstMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when the lookup itself fails, so callers fail closed', async () => {
    process.env[ENV_KEY] = 'db-down-system@reeve.test';
    userFindFirstMock.mockRejectedValue(new Error('connection refused'));

    await expect(isReeveAdminSystemUserId(42)).rejects.toThrow('connection refused');
  });
});
