import { prisma } from '@documenso/prisma';
import type { Organisation } from '@prisma/client';
import { OrganisationType, WebhookTriggerEvents } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { INTERNAL_CLAIM_ID, internalClaims } from '../../types/subscription';
import { env } from '../../utils/env';
import { createOrganisation } from '../organisation/create-organisation';
import { createApiToken } from '../public-api/create-api-token';
import { createTeam } from '../team/create-team';
import { deriveOrganisationUrlFromExternalReference } from './derive-organisation-url';
import { getReeveAdminSystemUser } from './get-reeve-admin-system-user';

export type ProvisionOrganisationInput = {
  name: string;
  externalReference: string;
  /** Optional team webhook to ensure on the org's team (DEV-12502). */
  webhook?: { url: string; secret: string };
};

export type ProvisionOrganisationResult = {
  organisationId: string;
  /** Only non-null when a new organisation was created by this call. */
  apiToken: string | null;
  created: boolean;
};

const REEVE_PROVISIONING_TOKEN_NAME = 'Reeve provisioning token';

/**
 * An org matched by the derived `reeve-ext-` url is only ours if the system
 * user owns it: org managers can edit their url, so a foreign org can squat
 * a derived value. Rejects it before any PLATFORM-claim/type/webhook write.
 */
const assertOwnedBySystemUser = (organisation: { owner: { email: string } }) => {
  const systemUserEmail = env('REEVE_SIGN_SYSTEM_USER_EMAIL')?.trim().toLowerCase();

  if (!systemUserEmail) {
    throw new AppError(AppErrorCode.NOT_SETUP, { message: 'REEVE_SIGN_SYSTEM_USER_EMAIL is not set.' });
  }

  if (organisation.owner.email.trim().toLowerCase() !== systemUserEmail) {
    throw new AppError(AppErrorCode.ALREADY_EXISTS, {
      message: 'Organisation url is taken by a non-Reeve organisation',
    });
  }
};

/**
 * The events reeve-agents' `/webhooks/documenso` receives today: the exact
 * set on the prod team-3 webhook row (DEV-12502). Completion and
 * rejection/cancellation resume sign gates; the rest are telemetry.
 */
export const REEVE_WEBHOOK_EVENT_TRIGGERS = [
  WebhookTriggerEvents.DOCUMENT_SENT,
  WebhookTriggerEvents.DOCUMENT_OPENED,
  WebhookTriggerEvents.DOCUMENT_SIGNED,
  WebhookTriggerEvents.DOCUMENT_COMPLETED,
  WebhookTriggerEvents.DOCUMENT_REJECTED,
  WebhookTriggerEvents.DOCUMENT_CANCELLED,
];

/**
 * Idempotently ensures the team has a webhook for `url`: creates it, or
 * brings a drifted one (secret, events, disabled) back in line. It never
 * creates a second one for the same (team, url). It does not reconcile
 * duplicates made outside this path (e.g. by hand in the Documenso UI).
 */
const ensureTeamWebhook = async ({
  teamId,
  userId,
  webhook,
}: {
  teamId: number;
  userId: number;
  webhook: { url: string; secret: string };
}) => {
  // Webhook has no unique (teamId, webhookUrl) constraint, so serialise
  // find-then-create per (team, url) or two concurrent re-POSTs could both
  // create one and every event would be delivered twice.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reeve-webhook:${teamId}:${webhook.url}`}))`;

    const existing = await tx.webhook.findFirst({ where: { teamId, webhookUrl: webhook.url } });

    if (!existing) {
      await tx.webhook.create({
        data: {
          webhookUrl: webhook.url,
          secret: webhook.secret,
          eventTriggers: REEVE_WEBHOOK_EVENT_TRIGGERS,
          enabled: true,
          userId,
          teamId,
        },
      });

      return;
    }

    const hasSameEvents =
      existing.eventTriggers.length === REEVE_WEBHOOK_EVENT_TRIGGERS.length &&
      REEVE_WEBHOOK_EVENT_TRIGGERS.every((event) => existing.eventTriggers.includes(event));

    if (existing.enabled && existing.secret === webhook.secret && hasSameEvents) {
      return;
    }

    await tx.webhook.update({
      where: { id: existing.id },
      data: { secret: webhook.secret, eventTriggers: REEVE_WEBHOOK_EVENT_TRIGGERS, enabled: true },
    });
  });
};

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
 * team AND api token all exist" rather than just "organisation exists": a
 * prior call can fail partway through (transient DB error, crash
 * mid-request) after committing the org, or after committing the team but
 * before minting the token. Either partial state would otherwise
 * permanently look "done" on retry and return `apiToken: null` forever with
 * no way to ever recover a token. Checking each step lets an incomplete
 * prior attempt self-heal — completing exactly the steps that didn't
 * finish — on the next call instead.
 *
 * Billing bypass: this calls `createOrganisation` directly instead of going
 * through `packages/trpc/server/organisation-router/create-organisation.ts`.
 * The one-free-organisation-per-user limit lives in that tRPC route handler,
 * not in `createOrganisation` itself (upstream's own
 * `createPersonalOrganisation` helper relies on the same fact), so calling
 * the lib function directly never trips it — the system user can own any
 * number of Reeve-provisioned organisations. The PLATFORM internal claim
 * marks these as platform/API-managed orgs.
 *
 * Sender naming (DEV-12502): orgs are `ORGANISATION` type with org-level
 * `includeSenderDetails=true`, so signing invites read
 * `<owner> on behalf of "<team>"`. A re-POST upgrades an org provisioned
 * before this (or edited since) to that state, re-stamps the PLATFORM claim
 * that `resolveOnBehalfOfUserId` keys provenance on, and ensures the
 * optional team webhook.
 */
export const provisionOrganisation = async ({
  name,
  externalReference,
  webhook,
}: ProvisionOrganisationInput): Promise<ProvisionOrganisationResult> => {
  const url = deriveOrganisationUrlFromExternalReference(externalReference);

  const existingOrganisation = await prisma.organisation.findUnique({
    where: { url },
    include: {
      owner: { select: { email: true } },
      organisationGlobalSettings: { select: { includeSenderDetails: true } },
      organisationClaim: { select: { originalSubscriptionClaimId: true } },
    },
  });

  if (existingOrganisation) {
    assertOwnedBySystemUser(existingOrganisation);
  }

  if (
    existingOrganisation &&
    (existingOrganisation.type !== OrganisationType.ORGANISATION ||
      !existingOrganisation.organisationGlobalSettings.includeSenderDetails ||
      existingOrganisation.organisationClaim.originalSubscriptionClaimId !== INTERNAL_CLAIM_ID.PLATFORM)
  ) {
    await prisma.organisation.update({
      where: { id: existingOrganisation.id },
      data: {
        type: OrganisationType.ORGANISATION,
        organisationGlobalSettings: { update: { includeSenderDetails: true } },
        organisationClaim: { update: { originalSubscriptionClaimId: INTERNAL_CLAIM_ID.PLATFORM } },
      },
    });
  }

  let organisation: Organisation | null = existingOrganisation;

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

      const raceWinner = await prisma.organisation.findUniqueOrThrow({
        where: { url },
        include: { owner: { select: { email: true } } },
      });

      assertOwnedBySystemUser(raceWinner);
      organisation = raceWinner;
    }
  }

  let team = await prisma.team.findFirst({ where: { organisationId: organisation.id } });

  if (!team) {
    systemUser ??= await getReeveAdminSystemUser();
    const teamUrl = `${url}-team`;

    await createTeam({
      userId: systemUser.id,
      teamName: name,
      teamUrl,
      organisationId: organisation.id,
      inheritMembers: true,
    });

    team = await prisma.team.findFirstOrThrow({
      where: { organisationId: organisation.id },
    });
  }

  if (webhook) {
    await ensureTeamWebhook({ teamId: team.id, userId: organisation.ownerUserId, webhook });
  }

  const existingToken = await prisma.apiToken.findFirst({ where: { teamId: team.id } });

  if (existingToken) {
    // Fully provisioned already — a true idempotent hit. The token is
    // intentionally never re-returned once minted (see the pinned
    // contract: `api_token: null` on every hit after the first).
    return { organisationId: organisation.id, apiToken: null, created: false };
  }

  systemUser ??= await getReeveAdminSystemUser();

  const { token } = await createApiToken({
    userId: systemUser.id,
    teamId: team.id,
    tokenName: REEVE_PROVISIONING_TOKEN_NAME,
    expiresIn: null,
  });

  return { organisationId: organisation.id, apiToken: token, created: true };
};
