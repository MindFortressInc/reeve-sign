import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import {
  getReeveAdminSystemUser,
  isReeveAdminSystemUserEmail,
  isReeveAdminSystemUserId,
  REEVE_PROVISIONING_TOKEN_NAME,
} from './get-reeve-admin-system-user';

const { apiTokenFindFirstMock, getUserByEmailMock, userFindFirstMock } = vi.hoisted(() => ({
  apiTokenFindFirstMock: vi.fn(),
  getUserByEmailMock: vi.fn(),
  userFindFirstMock: vi.fn(),
}));

vi.mock('../user/get-user-by-email', () => ({
  getUserByEmail: getUserByEmailMock,
}));

vi.mock('@documenso/prisma', () => ({
  prisma: { user: { findFirst: userFindFirstMock }, apiToken: { findFirst: apiTokenFindFirstMock } },
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
    apiTokenFindFirstMock.mockReset();
    apiTokenFindFirstMock.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  it('is false for a user with no provisioning token, with no email lookup, when the email is unset', async () => {
    expect(await isReeveAdminSystemUserId(42)).toBe(false);
    expect(userFindFirstMock).not.toHaveBeenCalled();
  });

  it('keeps a provisioning-token holder bound when the email is unset', async () => {
    apiTokenFindFirstMock.mockImplementation(async ({ where }: { where: { userId: number } }) =>
      where.userId === 42 ? { id: 5 } : null,
    );

    expect(await isReeveAdminSystemUserId(42)).toBe(true);
    expect(await isReeveAdminSystemUserId(7)).toBe(false);
    expect(userFindFirstMock).not.toHaveBeenCalled();
    expect(apiTokenFindFirstMock).toHaveBeenCalledWith({
      where: { userId: 42, name: REEVE_PROVISIONING_TOKEN_NAME },
      select: { id: true },
    });
  });

  it('fails closed (NOT_SETUP) when the configured email matches no user, and does not memoize the miss', async () => {
    process.env[ENV_KEY] = 'missing-system@reeve.test';
    userFindFirstMock.mockResolvedValue(null);

    await expect(isReeveAdminSystemUserId(42)).rejects.toMatchObject({ code: AppErrorCode.NOT_SETUP });
    await expect(isReeveAdminSystemUserId(42)).rejects.toMatchObject({ code: AppErrorCode.NOT_SETUP });
    expect(userFindFirstMock).toHaveBeenCalledTimes(2);
  });

  it('a renamed system user fails closed once the memo expires', async () => {
    vi.useFakeTimers();

    try {
      process.env[ENV_KEY] = 'renamed-system@reeve.test';
      userFindFirstMock.mockResolvedValueOnce({ id: 3 });
      expect(await isReeveAdminSystemUserId(3)).toBe(true);

      userFindFirstMock.mockResolvedValueOnce(null);
      vi.advanceTimersByTime(61_000);
      await expect(isReeveAdminSystemUserId(3)).rejects.toMatchObject({ code: AppErrorCode.NOT_SETUP });
    } finally {
      vi.useRealTimers();
    }
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

  it('keeps the previous system user bound while it still holds a provisioning token', async () => {
    process.env[ENV_KEY] = 'previous-system@reeve.test';
    userFindFirstMock.mockResolvedValueOnce({ id: 1 });
    expect(await isReeveAdminSystemUserId(1)).toBe(true);

    // The operator moves the setting to another account; user 1's org-scoped
    // tokens are still valid.
    process.env[ENV_KEY] = 'next-system@reeve.test';
    userFindFirstMock.mockResolvedValueOnce({ id: 2 });
    apiTokenFindFirstMock.mockImplementation(async ({ where }: { where: { userId: number } }) =>
      where.userId === 1 ? { id: 77 } : null,
    );

    expect(await isReeveAdminSystemUserId(1)).toBe(true);
    expect(await isReeveAdminSystemUserId(2)).toBe(true);
    expect(await isReeveAdminSystemUserId(7)).toBe(false);
    expect(apiTokenFindFirstMock).toHaveBeenCalledWith({
      where: { userId: 1, name: REEVE_PROVISIONING_TOKEN_NAME },
      select: { id: true },
    });
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

describe('isReeveAdminSystemUserEmail', () => {
  const originalValue = process.env[ENV_KEY];

  beforeEach(() => {
    process.env[ENV_KEY] = 'email-check-system@reeve.test';
    userFindFirstMock.mockReset();
    userFindFirstMock.mockImplementation(async ({ where }: { where: { email: string } }) => {
      if (where.email === 'email-check-system@reeve.test') {
        return { id: 50 };
      }

      return where.email === 'human@org-a.test' ? { id: 51 } : null;
    });
    apiTokenFindFirstMock.mockReset();
    apiTokenFindFirstMock.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  it("is true for the system user's address", async () => {
    expect(await isReeveAdminSystemUserEmail('email-check-system@reeve.test')).toBe(true);
  });

  it("is false for a human's address and for an address no user has", async () => {
    expect(await isReeveAdminSystemUserEmail('human@org-a.test')).toBe(false);
    expect(await isReeveAdminSystemUserEmail('nobody@org-a.test')).toBe(false);
  });

  it("is true for a previous system user's address while it holds a provisioning token", async () => {
    apiTokenFindFirstMock.mockImplementation(async ({ where }: { where: { userId: number } }) =>
      where.userId === 51 ? { id: 77 } : null,
    );

    expect(await isReeveAdminSystemUserEmail('human@org-a.test')).toBe(true);
  });
});
