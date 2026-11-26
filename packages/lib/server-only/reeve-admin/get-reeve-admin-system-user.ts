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
 * The name provisioning gives the org-scoped API token it mints for the system
 * user. `isReeveAdminSystemUserId` keys the system user's persistent identity
 * on it, so renaming it would unbind every token already minted.
 */
export const REEVE_PROVISIONING_TOKEN_NAME = 'Reeve provisioning token';

/**
 * Whether `userId` is the Reeve system user (DEV-20496). Every
 * Reeve-provisioned organisation and its API tokens belong to this one user,
 * so access checks that trust "the caller owns it" or "the caller is a member
 * of the envelope's team" must also bind it to the token's team.
 *
 * That is the account `REEVE_SIGN_SYSTEM_USER_EMAIL` names now (the one
 * `getReeveAdminSystemUser` resolves for provisioning: the lowercased email,
 * matched exactly, as `getUserByEmail` does), or any user that holds a token
 * provisioning minted. The second half is the persistent identity: moving the
 * email to another account leaves the previous system user's tokens valid,
 * and its envelopes owned by it, so those tokens must stay bound to their team.
 *
 * An unset email leaves only the persistent identity: a user holding a
 * provisioning token stays bound, so a Reeve deployment that drops the setting
 * keeps its tokens team-bound, and upstream Documenso deployments (which mint
 * no such token) are unchanged. The unset setting is logged once. A configured email
 * that matches no user throws NOT_SETUP, like `getReeveAdminSystemUser`, so
 * the caller fails closed instead of treating a renamed system user (whose
 * tokens still carry its id) as a human. A database error also throws. The
 * resolved id is memoized per configured email for `SYSTEM_USER_MEMO_TTL_MS`;
 * a miss is not memoized.
 */
export const isReeveAdminSystemUserId = async (userId: number): Promise<boolean> => {
  const email = env('REEVE_SIGN_SYSTEM_USER_EMAIL')?.trim().toLowerCase();

  if (!email) {
    if (!hasWarnedUnset) {
      hasWarnedUnset = true;
      console.warn(
        '[reeve-admin] REEVE_SIGN_SYSTEM_USER_EMAIL is unset; only provisioning-token holders stay team-bound',
      );
    }

    return await holdsProvisioningToken(userId);
  }

  if (memoizedSystemUser?.email !== email || memoizedSystemUser.expiresAt <= Date.now()) {
    const user = await prisma.user.findFirst({
      where: { email },
      select: { id: true },
    });

    if (!user) {
      throw new AppError(AppErrorCode.NOT_SETUP, {
        message: `REEVE_SIGN_SYSTEM_USER_EMAIL is set to "${email}" but no matching Documenso user exists.`,
      });
    }

    memoizedSystemUser = { email, id: user.id, expiresAt: Date.now() + SYSTEM_USER_MEMO_TTL_MS };
  }

  if (memoizedSystemUser.id === userId) {
    return true;
  }

  return await holdsProvisioningToken(userId);
};

const holdsProvisioningToken = async (userId: number) => {
  const provisioningToken = await prisma.apiToken.findFirst({
    where: { userId, name: REEVE_PROVISIONING_TOKEN_NAME },
    select: { id: true },
  });

  return Boolean(provisioningToken);
};

/**
 * Whether the user whose address is exactly `email` is the Reeve system user
 * (DEV-20496). The where-input builders' team-email arm matches envelopes by
 * their owner's address, so a team whose verified team email is the system
 * user's address must only reach that user's envelopes in its own team.
 */
export const isReeveAdminSystemUserEmail = async (email: string): Promise<boolean> => {
  const user = await prisma.user.findFirst({
    where: { email },
    select: { id: true },
  });

  return user ? await isReeveAdminSystemUserId(user.id) : false;
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
