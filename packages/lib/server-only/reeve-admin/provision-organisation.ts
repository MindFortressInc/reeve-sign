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
 * schema/migration.
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

  const existing = await prisma.organisation.findUnique({ where: { url } });

  if (existing) {
    return { organisationId: existing.id, apiToken: null, created: false };
  }

  const systemUser = await getReeveAdminSystemUser();

  let organisation: Awaited<ReturnType<typeof createOrganisation>>;

  try {
    organisation = await createOrganisation({
      userId: systemUser.id,
      name,
      type: OrganisationType.ORGANISATION,
      url,
      claim: internalClaims[INTERNAL_CLAIM_ID.PLATFORM],
    });
  } catch (err) {
    // Two concurrent requests for the same external_reference can both pass
    // the findUnique check above and race on the DB-level unique constraint
    // on `url`; createOrganisation surfaces that as ALREADY_EXISTS. Treat it
    // as an idempotent hit rather than an error.
    if (err instanceof AppError && err.code === AppErrorCode.ALREADY_EXISTS) {
      const raceWinner = await prisma.organisation.findUniqueOrThrow({ where: { url } });

      return { organisationId: raceWinner.id, apiToken: null, created: false };
    }

    throw err;
  }

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
