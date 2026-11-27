/**
 * Real-Postgres integration test for DEV-20496. Every Reeve-provisioned
 * organisation and its API tokens belong to one Reeve system user, so before
 * this change the owner arm of `getEnvelopeWhereInput` /
 * `getMultipleEnvelopeWhereInput` (`{ userId }`, no team) let org A's token
 * read org B's system-user-owned envelope by id, and `deleteDocument`'s
 * membership check let it delete one. This suite seeds that exact shape (one
 * user, member of two organisations' teams, owning an envelope in the second)
 * and drives the real functions against a real database.
 *
 * Mock boundary (explicit): `triggerWebhook` (external HTTP egress) is mocked,
 * and so is the i18n catalog loader `deleteDocument` imports (compiled
 * catalogs are a build artefact). Everything else is real.
 *
 * Opt-in only, via RUN_DB_INTEGRATION_TESTS=true — see
 * conditional-visibility-consent.integration.test.ts's doc comment for the
 * full rationale.
 *
 *   RUN_DB_INTEGRATION_TESTS=true npx dotenv -e ../../.env -- \
 *     npx vitest run --config vitest.db-integration.config.ts
 */
import { prisma } from '@documenso/prisma';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedOrganisationMembers } from '@documenso/prisma/seed/organisations';
import { seedUser } from '@documenso/prisma/seed/users';
import { setupI18n } from '@lingui/core';
import type { Team, User } from '@prisma/client';
import { EnvelopeType, OrganisationMemberRole } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { INTERNAL_CLAIM_ID } from '../../types/subscription';
import { deleteDocument } from '../document/delete-document';
import { REEVE_PROVISIONING_TOKEN_NAME } from '../reeve-admin/get-reeve-admin-system-user';
import { getEnvelopeById } from './get-envelope-by-id';
import { getEnvelopesByIds } from './get-envelopes-by-ids';

const RUN_INTEGRATION = process.env.RUN_DB_INTEGRATION_TESTS === 'true';

vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));
vi.mock('../../client-only/providers/i18n-server', () => ({
  getI18nInstance: () => {
    const i18n = setupI18n({ locale: 'en', messages: { en: {} } });
    i18n.activate('en');

    return Promise.resolve(i18n);
  },
}));

const ENV_KEY = 'REEVE_SIGN_SYSTEM_USER_EMAIL';

let systemUser: User;
let orgBOwner: User;
let human: User;
let orgATeam: Team;
let orgBTeam: Team;

describe("Reeve system user's by-id access is bound to the token's team (real Postgres)", () => {
  const originalValue = process.env[ENV_KEY];

  beforeAll(async () => {
    // Fail loudly, not a silent skip, when the dedicated config runs without
    // the flag (same gate as get-handoff-eligibility.integration.test.ts).
    if (!RUN_INTEGRATION) {
      throw new Error(
        'RUN_DB_INTEGRATION_TESTS=true environment variable must be set to run database integration tests',
      );
    }

    const orgA = await seedUser({ name: 'Reeve System' });
    const orgB = await seedUser({ name: 'Org B owner' });

    systemUser = orgA.user;
    orgBOwner = orgB.user;
    orgATeam = orgA.team;
    orgBTeam = orgB.team;

    // Production shape: the system user is in every Reeve-provisioned org.
    await seedOrganisationMembers({
      members: [{ email: systemUser.email, organisationRole: OrganisationMemberRole.ADMIN }],
      organisationId: orgB.organisation.id,
    });

    // A human who belongs to both orgs, for the unchanged-upstream case.
    const [seededHuman] = await seedOrganisationMembers({
      members: [{ organisationRole: OrganisationMemberRole.MEMBER }],
      organisationId: orgA.organisation.id,
    });

    human = seededHuman;

    await seedOrganisationMembers({
      members: [{ email: human.email, organisationRole: OrganisationMemberRole.MEMBER }],
      organisationId: orgB.organisation.id,
    });

    process.env[ENV_KEY] = systemUser.email;
  });

  afterAll(async () => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }

    await prisma.$disconnect();
  });

  it("get-many with org A's system-user token returns no row for an org B envelope", async () => {
    const orgBEnvelope = await seedBlankDocument(systemUser, orgBTeam.id);

    const rows = await getEnvelopesByIds({
      ids: { type: 'envelopeId', ids: [orgBEnvelope.id] },
      userId: systemUser.id,
      teamId: orgATeam.id,
      type: EnvelopeType.DOCUMENT,
    });

    expect(rows).toEqual([]);
  });

  it("by-id read with org A's system-user token is NOT_FOUND for an org B envelope", async () => {
    const orgBEnvelope = await seedBlankDocument(systemUser, orgBTeam.id);

    await expect(
      getEnvelopeById({
        id: { type: 'envelopeId', id: orgBEnvelope.id },
        userId: systemUser.id,
        teamId: orgATeam.id,
        type: EnvelopeType.DOCUMENT,
      }),
    ).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });
  });

  it("org B's own system-user token still reads it, by id and via get-many", async () => {
    const orgBEnvelope = await seedBlankDocument(systemUser, orgBTeam.id);

    const envelope = await getEnvelopeById({
      id: { type: 'envelopeId', id: orgBEnvelope.id },
      userId: systemUser.id,
      teamId: orgBTeam.id,
      type: EnvelopeType.DOCUMENT,
    });

    expect(envelope.id).toBe(orgBEnvelope.id);

    const rows = await getEnvelopesByIds({
      ids: { type: 'envelopeId', ids: [orgBEnvelope.id] },
      userId: systemUser.id,
      teamId: orgBTeam.id,
      type: EnvelopeType.DOCUMENT,
    });

    expect(rows.map((row) => row.id)).toEqual([orgBEnvelope.id]);
  });

  it("a human's cross-team owner access is unchanged (upstream semantics)", async () => {
    const humanOrgBEnvelope = await seedBlankDocument(human, orgBTeam.id);

    const rows = await getEnvelopesByIds({
      ids: { type: 'envelopeId', ids: [humanOrgBEnvelope.id] },
      userId: human.id,
      teamId: orgATeam.id,
      type: EnvelopeType.DOCUMENT,
    });

    expect(rows.map((row) => row.id)).toEqual([humanOrgBEnvelope.id]);

    const envelope = await getEnvelopeById({
      id: { type: 'envelopeId', id: humanOrgBEnvelope.id },
      userId: human.id,
      teamId: orgATeam.id,
      type: EnvelopeType.DOCUMENT,
    });

    expect(envelope.id).toBe(humanOrgBEnvelope.id);
  });

  it("deleteDocument with org A's system-user token refuses an org B envelope and leaves it in place", async () => {
    const orgBEnvelope = await seedBlankDocument(systemUser, orgBTeam.id);

    await expect(
      deleteDocument({
        id: { type: 'envelopeId', id: orgBEnvelope.id },
        userId: systemUser.id,
        teamId: orgATeam.id,
        requestMetadata: { requestMetadata: {}, source: 'apiV2', auth: 'api' },
      }),
    ).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });

    const row = await prisma.envelope.findUnique({ where: { id: orgBEnvelope.id } });

    expect(row).not.toBeNull();
    expect(row?.deletedAt).toBeNull();
  });

  it("deleteDocument with org B's own system-user token still deletes it", async () => {
    const orgBEnvelope = await seedBlankDocument(systemUser, orgBTeam.id);

    await deleteDocument({
      id: { type: 'envelopeId', id: orgBEnvelope.id },
      userId: systemUser.id,
      teamId: orgBTeam.id,
      requestMetadata: { requestMetadata: {}, source: 'apiV2', auth: 'api' },
    });

    const row = await prisma.envelope.findUnique({ where: { id: orgBEnvelope.id } });

    expect(row === null || row.deletedAt !== null).toBe(true);
  });

  it('a previous system user that still holds a provisioning token stays bound after the email moves', async () => {
    const orgBEnvelope = await seedBlankDocument(systemUser, orgBTeam.id);

    await prisma.apiToken.create({
      data: {
        name: REEVE_PROVISIONING_TOKEN_NAME,
        token: `integration-${systemUser.id}-${Date.now()}`,
        userId: systemUser.id,
        teamId: orgATeam.id,
      },
    });

    process.env[ENV_KEY] = orgBOwner.email;

    try {
      const rows = await getEnvelopesByIds({
        ids: { type: 'envelopeId', ids: [orgBEnvelope.id] },
        userId: systemUser.id,
        teamId: orgATeam.id,
        type: EnvelopeType.DOCUMENT,
      });

      expect(rows).toEqual([]);

      await expect(
        getEnvelopeById({
          id: { type: 'envelopeId', id: orgBEnvelope.id },
          userId: systemUser.id,
          teamId: orgATeam.id,
          type: EnvelopeType.DOCUMENT,
        }),
      ).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });

      await expect(
        deleteDocument({
          id: { type: 'envelopeId', id: orgBEnvelope.id },
          userId: systemUser.id,
          teamId: orgATeam.id,
          requestMetadata: { requestMetadata: {}, source: 'apiV2', auth: 'api' },
        }),
      ).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });
    } finally {
      process.env[ENV_KEY] = systemUser.email;
    }
  });
  it('a previous system user stays bound after the email moves and its provisioning tokens are deleted', async () => {
    const orgBEnvelope = await seedBlankDocument(systemUser, orgBTeam.id);

    // Production shape: provisioning stamps the PLATFORM claim on every org it
    // creates for the system user.
    await prisma.organisationClaim.updateMany({
      where: { organisation: { teams: { some: { id: orgATeam.id } } } },
      data: { originalSubscriptionClaimId: INTERNAL_CLAIM_ID.PLATFORM },
    });

    await prisma.apiToken.deleteMany({ where: { userId: systemUser.id, name: REEVE_PROVISIONING_TOKEN_NAME } });

    // The ordinary token the system user still holds for org A.
    await prisma.apiToken.create({
      data: {
        name: 'ops token',
        token: `integration-ops-${systemUser.id}-${Date.now()}`,
        userId: systemUser.id,
        teamId: orgATeam.id,
      },
    });

    process.env[ENV_KEY] = orgBOwner.email;

    try {
      const rows = await getEnvelopesByIds({
        ids: { type: 'envelopeId', ids: [orgBEnvelope.id] },
        userId: systemUser.id,
        teamId: orgATeam.id,
        type: EnvelopeType.DOCUMENT,
      });

      expect(rows).toEqual([]);

      await expect(
        getEnvelopeById({
          id: { type: 'envelopeId', id: orgBEnvelope.id },
          userId: systemUser.id,
          teamId: orgATeam.id,
          type: EnvelopeType.DOCUMENT,
        }),
      ).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });

      await expect(
        deleteDocument({
          id: { type: 'envelopeId', id: orgBEnvelope.id },
          userId: systemUser.id,
          teamId: orgATeam.id,
          requestMetadata: { requestMetadata: {}, source: 'apiV2', auth: 'api' },
        }),
      ).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });
    } finally {
      process.env[ENV_KEY] = systemUser.email;
    }
  });

  it("an email that matches no user leaves a human's by-id reads working and a marked system user bound", async () => {
    const humanOrgBEnvelope = await seedBlankDocument(human, orgBTeam.id);
    const systemOrgBEnvelope = await seedBlankDocument(systemUser, orgBTeam.id);

    await prisma.organisationClaim.updateMany({
      where: { organisation: { teams: { some: { id: orgATeam.id } } } },
      data: { originalSubscriptionClaimId: INTERNAL_CLAIM_ID.PLATFORM },
    });

    // The configured account was renamed or deleted.
    process.env[ENV_KEY] = `stale-system-${Date.now()}@reeve.test`;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const envelope = await getEnvelopeById({
        id: { type: 'envelopeId', id: humanOrgBEnvelope.id },
        userId: human.id,
        teamId: orgATeam.id,
        type: EnvelopeType.DOCUMENT,
      });

      expect(envelope.id).toBe(humanOrgBEnvelope.id);

      const humanRows = await getEnvelopesByIds({
        ids: { type: 'envelopeId', ids: [humanOrgBEnvelope.id] },
        userId: human.id,
        teamId: orgATeam.id,
        type: EnvelopeType.DOCUMENT,
      });

      expect(humanRows.map((row) => row.id)).toEqual([humanOrgBEnvelope.id]);

      const systemRows = await getEnvelopesByIds({
        ids: { type: 'envelopeId', ids: [systemOrgBEnvelope.id] },
        userId: systemUser.id,
        teamId: orgATeam.id,
        type: EnvelopeType.DOCUMENT,
      });

      expect(systemRows).toEqual([]);

      await expect(
        getEnvelopeById({
          id: { type: 'envelopeId', id: systemOrgBEnvelope.id },
          userId: systemUser.id,
          teamId: orgATeam.id,
          type: EnvelopeType.DOCUMENT,
        }),
      ).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });
    } finally {
      errorSpy.mockRestore();
      process.env[ENV_KEY] = systemUser.email;
    }
  });
});
