import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { INTERNAL_CLAIM_ID } from '../../types/subscription';
import { env } from '../../utils/env';
import { buildTeamWhereQuery } from '../../utils/teams';

/**
 * Optional header on the API-token document-creating routes (DEV-12502, C1):
 * the email of the team member the envelope is created on behalf of. That
 * member becomes the envelope owner, so signing invites read
 * `<member> on behalf of "<org>"` instead of naming the token's system user.
 */
export const REEVE_ON_BEHALF_OF_HEADER = 'X-Reeve-Sign-On-Behalf-Of';

/**
 * Resolves `X-Reeve-Sign-On-Behalf-Of` to the user id that should own a new
 * envelope. Returns null when the header is absent (callers keep the token
 * user as owner). Throws FORBIDDEN (403) unless the email belongs to an
 * enabled member of the token's own team, and that team belongs to a
 * Reeve-provisioned organisation (`POST /api/reeve-admin/organisations`):
 * owned by the Reeve system user (`REEVE_SIGN_SYSTEM_USER_EMAIL`) and
 * carrying the PLATFORM claim. The claim alone is not provenance (a normal
 * user can buy the PLATFORM plan); only admin flows can make the system user
 * an org owner. Fails closed when the system user email is unset.
 * Ordinary Documenso teams never honour it. Callers resolve this before
 * creating anything, so a rejected header never leaves an envelope behind.
 *
 * Deliberately not upstream's `delegatedDocumentOwner`: that is gated behind
 * a per-org `delegateDocumentOwnership` setting, only exists on
 * `/envelope/create`, answers 401, and validates after the document meta
 * row is already written.
 */
export const resolveOnBehalfOfUserId = async ({
  headers,
  teamId,
}: {
  headers: Headers;
  teamId: number | undefined;
}): Promise<number | null> => {
  const email = headers.get(REEVE_ON_BEHALF_OF_HEADER)?.trim();

  if (!email) {
    return null;
  }

  const forbidden = new AppError(AppErrorCode.FORBIDDEN, {
    message: `${REEVE_ON_BEHALF_OF_HEADER} must be the email of a member of this API token's team`,
  });

  const systemUserEmail = env('REEVE_SIGN_SYSTEM_USER_EMAIL')?.trim();

  if (teamId === undefined || !systemUserEmail) {
    throw forbidden;
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, disabled: false },
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  if (!user) {
    throw forbidden;
  }

  const team = await prisma.team.findFirst({
    where: {
      ...buildTeamWhereQuery({ teamId, userId: user.id }),
      // Provenance is system-user ownership plus the PLATFORM claim
      // provisioning stamps, not the `reeve-ext-` url prefix (org managers
      // can edit their url) nor the claim alone (billable by anyone).
      organisation: {
        owner: { email: { equals: systemUserEmail, mode: 'insensitive' } },
        organisationClaim: { originalSubscriptionClaimId: INTERNAL_CLAIM_ID.PLATFORM },
      },
    },
    select: { id: true },
  });

  if (!team) {
    throw forbidden;
  }

  return user.id;
};
