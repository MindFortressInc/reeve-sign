import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { buildTeamWhereQuery } from '../../utils/teams';
import { REEVE_PROVISIONED_ORGANISATION_URL_PREFIX } from './derive-organisation-url';

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
 * Reeve-provisioned organisation (`POST /api/reeve-admin/organisations`).
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

  if (teamId === undefined) {
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
      organisation: { url: { startsWith: REEVE_PROVISIONED_ORGANISATION_URL_PREFIX } },
    },
    select: { id: true },
  });

  if (!team) {
    throw forbidden;
  }

  return user.id;
};
