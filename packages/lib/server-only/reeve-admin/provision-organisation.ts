import { prisma } from '@documenso/prisma';
import { OrganisationType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { INTERNAL_CLAIM_ID, internalClaims } from '../../types/subscription';
import { createOrganisation } from '../organisation/create-organisation';
import { createApiToken } from '../public-api/create-api-token';
import { createTeam } from '../team/create-team';
import { deriveOrganisationUrlFromExternalReference } from './derive-organisation-url';
import { getReeveAdminSystemUser } from './get-reeve-admin-system-user';

export type ProvisionOrganisationInput = {
  name: string;
  externalReference: string;
};

export type ProvisionOrganisationResult = {
  organisationId: string;
  /** Only non-null when a new organisation was created by this call. */
  apiToken: string | null;
  created: boolean;
};

const REEVE_PROVISIONING_TOKEN_NAME = 'Reeve provisioning token';

/**
 * Idempotently provisions a Documenso organisation for a host_app tenant and
 * mints an org-scoped API token, for the service-token-guarded
 * `POST /api/reeve-admin/organisations` endpoint (DEV-4873).
 *
 * Idempotency: `external_reference` deterministically derives the
 * organisation's `url` (see `derive-organisation-url.ts`). `url` is a
 * persistent, unique, DB-backed column, so a lookup by the derived url is
 * enough to detect "already provisioned" across restarts without any new
 * schema/migration. A completed provision is defined as "organisation AND
 * team both exist" rather than just "organisation exists": if a prior call
 * created the organisation but then failed before minting the team/token
 * (a transient DB error, a crash mid-request), the org row alone would
 * otherwise permanently look "done" and every retry would return
 * `apiToken: null` forever with no way to recover. Checking for the team
 * too lets an incomplete prior attempt self-heal on the next call instead.
 *
 * Billing bypass: this calls `createOrganisation` directly instead of going
 * through `packages/trpc/server/organisation-router/create-organisation.ts`.
 * The one-free-organisation-per-user limit lives in that tRPC route handler,
 * not in `createOrganisation` itself (upstream's own
 * `createPersonalOrganisation` helper relies on the same fact), so calling
 * the lib function directly never trips it — the system user can own any
 * number of Reeve-provisioned organisations. The PLATFORM internal claim
 * marks these as platform/API-managed orgs.
 */
export const provisionOrganisation = async ({
  name,
  externalReference,
}: ProvisionOrganisationInput): Promise<ProvisionOrganisationResult> => {
  const url = deriveOrganisationUrlFromExternalReference(externalReference);

  let organisation = await prisma.organisation.findUnique({ where: { url } });

  let systemUser: Awaited<ReturnType<typeof getReeveAdminSystemUser>> | undefined;

  if (!organisation) {
    systemUser = await getReeveAdminSystemUser();

    try {
      organisation = await createOrganisation({
        userId: systemUser.id,
        name,
        type: OrganisationType.ORGANISATION,
        url,
        claim: internalClaims[INTERNAL_CLAIM_ID.PLATFORM],
      });
    } catch (err) {
      // Two concurrent requests for the same external_reference can both
      // pass the findUnique check above and race on the DB-level unique
      // constraint on `url`; createOrganisation surfaces that as
      // ALREADY_EXISTS. Fall through to the shared "does it have a team
      // yet" check below rather than assuming the race winner finished.
      if (!(err instanceof AppError && err.code === AppErrorCode.ALREADY_EXISTS)) {
        throw err;
      }

      organisation = await prisma.organisation.findUniqueOrThrow({ where: { url } });
    }
  }

  const existingTeam = await prisma.team.findFirst({ where: { organisationId: organisation.id } });

  if (existingTeam) {
    // Fully provisioned already — a true idempotent hit. The token is
    // intentionally never re-returned once minted (see the pinned
    // contract: `api_token: null` on every hit after the first).
    return { organisationId: organisation.id, apiToken: null, created: false };
  }

  systemUser ??= await getReeveAdminSystemUser();
  const teamUrl = `${url}-team`;

  await createTeam({
    userId: systemUser.id,
    teamName: name,
    teamUrl,
    organisationId: organisation.id,
    inheritMembers: true,
  });

  const team = await prisma.team.findFirstOrThrow({
    where: { organisationId: organisation.id },
  });

  const { token } = await createApiToken({
    userId: systemUser.id,
    teamId: team.id,
    tokenName: REEVE_PROVISIONING_TOKEN_NAME,
    expiresIn: null,
  });

  return { organisationId: organisation.id, apiToken: token, created: true };
};
