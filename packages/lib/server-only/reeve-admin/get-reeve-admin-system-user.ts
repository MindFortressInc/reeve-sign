import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { env } from '../../utils/env';
import { getUserByEmail } from '../user/get-user-by-email';

/**
 * How long a resolved system-user id is trusted before it is looked up again,
 * so moving the email to another account takes effect without a restart.
 */
const SYSTEM_USER_MEMO_TTL_MS = 60_000;

let memoizedSystemUser: { email: string; id: number; expiresAt: number } | null = null;

let hasWarnedUnset = false;

/**
 * Whether `userId` is the Reeve system user (DEV-20496). Every
 * Reeve-provisioned organisation and its API tokens belong to this one user,
 * so access checks that trust "the caller owns it" or "the caller is a member
 * of the envelope's team" must also bind it to the token's team.
 *
 * It resolves the same account as `getReeveAdminSystemUser` (the one
 * provisioning assigns organisations to): the lowercased email, matched
 * exactly, as `getUserByEmail` does.
 *
 * Unlike `getReeveAdminSystemUser` this never throws for configuration: an
 * unset email, or one that matches no user, means no user is treated as the
 * system user, so upstream Documenso deployments are unchanged. Both cases are
 * logged, because a Reeve deployment that drops the setting loses the binding.
 * A database error still throws, so a caller fails closed. The resolved id is
 * memoized per configured email for `SYSTEM_USER_MEMO_TTL_MS`; a miss is not
 * memoized.
 */
export const isReeveAdminSystemUserId = async (userId: number): Promise<boolean> => {
  const email = env('REEVE_SIGN_SYSTEM_USER_EMAIL')?.trim().toLowerCase();

  if (!email) {
    if (!hasWarnedUnset) {
      hasWarnedUnset = true;
      console.warn('[reeve-admin] REEVE_SIGN_SYSTEM_USER_EMAIL is unset; system-user team binding is inactive');
    }

    return false;
  }

  if (memoizedSystemUser?.email !== email || memoizedSystemUser.expiresAt <= Date.now()) {
    const user = await prisma.user.findFirst({
      where: { email },
      select: { id: true },
    });

    if (!user) {
      console.error(
        `[reeve-admin] REEVE_SIGN_SYSTEM_USER_EMAIL is set to "${email}" but no matching user exists; system-user team binding is inactive`,
      );

      return false;
    }

    memoizedSystemUser = { email, id: user.id, expiresAt: Date.now() + SYSTEM_USER_MEMO_TTL_MS };
  }

  return memoizedSystemUser.id === userId;
};

/**
 * Resolves the system user that owns every organisation provisioned via
 * `POST /api/reeve-admin/organisations` (DEV-4873). This is deliberately not
 * a real human account.
 *
 * Fails loud (never silently falls back) when `REEVE_SIGN_SYSTEM_USER_EMAIL`
 * is unset or does not resolve to an existing Documenso user, per the
 * DEV-4300 fail-loud convention.
 */
export const getReeveAdminSystemUser = async () => {
  const email = env('REEVE_SIGN_SYSTEM_USER_EMAIL');

  if (!email) {
    throw new AppError(AppErrorCode.NOT_SETUP, {
      message:
        'REEVE_SIGN_SYSTEM_USER_EMAIL is not set. Set it to the email of the Documenso user that should own Reeve-provisioned organisations.',
    });
  }

  try {
    return await getUserByEmail({ email });
  } catch {
    throw new AppError(AppErrorCode.NOT_SETUP, {
      message: `REEVE_SIGN_SYSTEM_USER_EMAIL is set to "${email}" but no matching Documenso user exists. Create this user before provisioning organisations.`,
    });
  }
};
