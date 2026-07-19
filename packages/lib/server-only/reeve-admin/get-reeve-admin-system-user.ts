import { AppError, AppErrorCode } from '../../errors/app-error';
import { env } from '../../utils/env';
import { getUserByEmail } from '../user/get-user-by-email';

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
