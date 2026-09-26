import { prisma } from '@documenso/prisma';
import { OrganisationMemberRole } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { addUserToOrganisation } from '../organisation/accept-organisation-invitation';
import { deriveOrganisationUrlFromExternalReference } from './derive-organisation-url';

export type EnsureOrganisationMemberInput = {
  externalReference: string;
  email: string;
  name: string;
};

export type EnsureOrganisationMemberResult = {
  userId: number;
  /** True only when this call created the Documenso user. */
  created: boolean;
};

const findUserByEmail = async (email: string) =>
  await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });

/**
 * Idempotently ensures a Documenso user for `email` and makes them a MEMBER
 * of the Reeve-provisioned organisation identified by `externalReference`
 * (DEV-12502, `POST /api/reeve-admin/organisations/{external_reference}/members`).
 *
 * The user is the real sender behind `X-Reeve-Sign-On-Behalf-Of`, so signing
 * invites read `<name> on behalf of "<org>"`. A new user is created
 * email-verified with no password and no personal organisation (they operate
 * inside the provisioned org), and nothing emails them: no verification,
 * welcome, or member-joined email (`bypassEmail`). An existing user is used
 * as-is. Membership goes through the org's internal MEMBER group, which the
 * provisioned team inherits as team role MEMBER.
 */
export const ensureOrganisationMember = async ({
  externalReference,
  email,
  name,
}: EnsureOrganisationMemberInput): Promise<EnsureOrganisationMemberResult> => {
  const organisation = await prisma.organisation.findUnique({
    where: { url: deriveOrganisationUrlFromExternalReference(externalReference) },
    include: { groups: true },
  });

  if (!organisation) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Organisation not found' });
  }

  let user = await findUserByEmail(email);
  let created = false;

  if (!user) {
    try {
      user = await prisma.user.create({
        data: { email: email.toLowerCase(), name, emailVerified: new Date() },
      });
      created = true;
    } catch (err) {
      // A concurrent request created the same user first (unique email).
      if ((err as { code?: string }).code !== 'P2002') {
        throw err;
      }

      user = await findUserByEmail(email);

      if (!user) {
        throw err;
      }
    }
  }

  const existingMember = await prisma.organisationMember.findFirst({
    where: { userId: user.id, organisationId: organisation.id },
  });

  if (!existingMember) {
    const userId = user.id;

    await addUserToOrganisation({
      userId,
      organisationId: organisation.id,
      organisationGroups: organisation.groups,
      organisationMemberRole: OrganisationMemberRole.MEMBER,
      bypassEmail: true,
    }).catch(async (err) => {
      // A concurrent request added the same membership first (unique
      // userId+organisationId): that is the idempotent outcome we wanted.
      const raced =
        (err as { code?: string }).code === 'P2002' &&
        (await prisma.organisationMember.findFirst({ where: { userId, organisationId: organisation.id } }));

      if (!raced) {
        throw err;
      }
    });
  }

  return { userId: user.id, created };
};
