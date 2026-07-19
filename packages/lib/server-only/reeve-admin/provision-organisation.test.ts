import { OrganisationType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { INTERNAL_CLAIM_ID, internalClaims } from '../../types/subscription';
import { deriveOrganisationUrlFromExternalReference } from './derive-organisation-url';

const {
  findUniqueMock,
  findUniqueOrThrowMock,
  findFirstMock,
  findFirstOrThrowMock,
  apiTokenFindFirstMock,
  createOrganisationMock,
  createTeamMock,
  createApiTokenMock,
  getReeveAdminSystemUserMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  findUniqueOrThrowMock: vi.fn(),
  findFirstMock: vi.fn(),
  findFirstOrThrowMock: vi.fn(),
  apiTokenFindFirstMock: vi.fn(),
  createOrganisationMock: vi.fn(),
  createTeamMock: vi.fn(),
  createApiTokenMock: vi.fn(),
  getReeveAdminSystemUserMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    organisation: {
      findUnique: findUniqueMock,
      findUniqueOrThrow: findUniqueOrThrowMock,
    },
    team: {
      findFirst: findFirstMock,
      findFirstOrThrow: findFirstOrThrowMock,
    },
    apiToken: {
      findFirst: apiTokenFindFirstMock,
    },
  },
}));

vi.mock('../organisation/create-organisation', () => ({
  createOrganisation: createOrganisationMock,
}));

vi.mock('../team/create-team', () => ({
  createTeam: createTeamMock,
}));

vi.mock('../public-api/create-api-token', () => ({
  createApiToken: createApiTokenMock,
}));

vi.mock('./get-reeve-admin-system-user', () => ({
  getReeveAdminSystemUser: getReeveAdminSystemUserMock,
}));

// Imported after the mocks above so the module under test picks them up.
const { provisionOrganisation } = await import('./provision-organisation');

const SYSTEM_USER = { id: 999, email: 'reeve-provisioner@meetreeve.com' };

describe('provisionOrganisation', () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    findUniqueOrThrowMock.mockReset();
    findFirstMock.mockReset();
    findFirstOrThrowMock.mockReset();
    apiTokenFindFirstMock.mockReset();
    createOrganisationMock.mockReset();
    createTeamMock.mockReset();
    createApiTokenMock.mockReset();
    getReeveAdminSystemUserMock.mockReset();
    getReeveAdminSystemUserMock.mockResolvedValue(SYSTEM_USER);
  });

  it('idempotent hit: org + team + token all already exist -> returns the existing org, creates nothing', async () => {
    const url = deriveOrganisationUrlFromExternalReference('host_app:tenant-123');

    findUniqueMock.mockResolvedValue({ id: 'org_existing', url });
    findFirstMock.mockResolvedValue({ id: 7, organisationId: 'org_existing' });
    apiTokenFindFirstMock.mockResolvedValue({ id: 1, teamId: 7 });

    const result = await provisionOrganisation({ name: 'Tenant 123', externalReference: 'host_app:tenant-123' });

    expect(result).toEqual({ organisationId: 'org_existing', apiToken: null, created: false });
    expect(createOrganisationMock).not.toHaveBeenCalled();
    expect(createTeamMock).not.toHaveBeenCalled();
    expect(createApiTokenMock).not.toHaveBeenCalled();
  });

  it('same external_reference twice: second call is idempotent (no duplicate org)', async () => {
    const externalReference = 'host_app:tenant-123';
    const url = deriveOrganisationUrlFromExternalReference(externalReference);

    // First call: nothing exists yet.
    findUniqueMock.mockResolvedValueOnce(null);
    createOrganisationMock.mockResolvedValueOnce({ id: 'org_new', url });
    findFirstMock.mockResolvedValueOnce(null); // no team yet
    createTeamMock.mockResolvedValueOnce(undefined);
    findFirstOrThrowMock.mockResolvedValueOnce({ id: 7, organisationId: 'org_new' });
    createApiTokenMock.mockResolvedValueOnce({ id: 1, token: 'api_first_token' });

    const first = await provisionOrganisation({ name: 'Tenant 123', externalReference });

    expect(first).toEqual({ organisationId: 'org_new', apiToken: 'api_first_token', created: true });
    expect(createOrganisationMock).toHaveBeenCalledTimes(1);

    // Second call: the org (and its team, and its token) now exist
    // (persistent, DB-backed lookup by the deterministically-derived url —
    // not in-memory).
    findUniqueMock.mockResolvedValueOnce({ id: 'org_new', url });
    findFirstMock.mockResolvedValueOnce({ id: 7, organisationId: 'org_new' });
    apiTokenFindFirstMock.mockResolvedValueOnce({ id: 1, teamId: 7 });

    const second = await provisionOrganisation({ name: 'Tenant 123', externalReference });

    expect(second).toEqual({ organisationId: 'org_new', apiToken: null, created: false });
    // Still only ever called once across both requests -> no duplicate org.
    expect(createOrganisationMock).toHaveBeenCalledTimes(1);
    expect(createTeamMock).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh organisation, team, and org-scoped api token when none exists', async () => {
    const externalReference = 'host_app:tenant-456';
    const url = deriveOrganisationUrlFromExternalReference(externalReference);

    findUniqueMock.mockResolvedValue(null);
    createOrganisationMock.mockResolvedValue({ id: 'org_456', url });
    findFirstMock.mockResolvedValue(null);
    createTeamMock.mockResolvedValue(undefined);
    findFirstOrThrowMock.mockResolvedValue({ id: 42, organisationId: 'org_456' });
    createApiTokenMock.mockResolvedValue({ id: 2, token: 'api_scoped_token' });

    const result = await provisionOrganisation({ name: 'Tenant 456', externalReference });

    expect(result).toEqual({ organisationId: 'org_456', apiToken: 'api_scoped_token', created: true });

    // Billing-bypass: created via the reused createOrganisation lib directly
    // (never through the tRPC route's free-org-limit check), using the
    // PLATFORM internal claim, owned by the system user.
    expect(createOrganisationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: SYSTEM_USER.id,
        type: OrganisationType.ORGANISATION,
        claim: internalClaims[INTERNAL_CLAIM_ID.PLATFORM],
        url,
      }),
    );

    // Token-scoping: the minted token must be scoped to the team that
    // belongs to the org we just created, not some other team.
    expect(createApiTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: SYSTEM_USER.id,
        teamId: 42,
      }),
    );
    expect(findFirstOrThrowMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organisationId: 'org_456' }) }),
    );
  });

  it('billing-bypass: provisions organisation N+1 for the system user without any free-org limit check', async () => {
    findUniqueMock.mockResolvedValue(null);
    findFirstMock.mockResolvedValue(null);
    findFirstOrThrowMock.mockResolvedValue({ id: 1, organisationId: 'org_x' });
    createApiTokenMock.mockResolvedValue({ id: 1, token: 'api_token' });

    for (let i = 0; i < 5; i += 1) {
      createOrganisationMock.mockResolvedValueOnce({ id: `org_${i}`, url: `reeve-ext-${i}` });

      const result = await provisionOrganisation({
        name: `Tenant ${i}`,
        externalReference: `host_app:tenant-${i}`,
      });

      expect(result.created).toBe(true);
    }

    // Org #6 (index 5, i.e. N+1 relative to a hypothetical 1-free-org limit)
    // still provisions successfully.
    expect(createOrganisationMock).toHaveBeenCalledTimes(5);
  });

  it('handles a create race safely: ALREADY_EXISTS from createOrganisation resolves to the (already-complete) winner', async () => {
    const externalReference = 'host_app:tenant-race';
    const url = deriveOrganisationUrlFromExternalReference(externalReference);

    findUniqueMock.mockResolvedValueOnce(null);
    createOrganisationMock.mockRejectedValueOnce(
      new AppError(AppErrorCode.ALREADY_EXISTS, { message: 'Organisation URL already exists' }),
    );
    findUniqueOrThrowMock.mockResolvedValueOnce({ id: 'org_race_winner', url });
    // The concurrent winner request finished its own team/token setup
    // before we observed ALREADY_EXISTS, so this is a true idempotent hit.
    findFirstMock.mockResolvedValueOnce({ id: 9, organisationId: 'org_race_winner' });
    apiTokenFindFirstMock.mockResolvedValueOnce({ id: 5, teamId: 9 });

    const result = await provisionOrganisation({ name: 'Tenant Race', externalReference });

    expect(result).toEqual({ organisationId: 'org_race_winner', apiToken: null, created: false });
    expect(createTeamMock).not.toHaveBeenCalled();
    expect(createApiTokenMock).not.toHaveBeenCalled();
  });

  it('self-heals a partial prior failure: org exists but its team/token step never completed', async () => {
    const externalReference = 'host_app:tenant-partial';
    const url = deriveOrganisationUrlFromExternalReference(externalReference);

    // The organisation row survives from a prior call whose createTeam or
    // createApiToken step failed (e.g. a transient DB error) after
    // createOrganisation had already committed.
    findUniqueMock.mockResolvedValue({ id: 'org_partial', url });
    findFirstMock.mockResolvedValueOnce(null); // no team yet -> incomplete
    createTeamMock.mockResolvedValueOnce(undefined);
    findFirstOrThrowMock.mockResolvedValueOnce({ id: 11, organisationId: 'org_partial' });
    createApiTokenMock.mockResolvedValueOnce({ id: 3, token: 'api_healed_token' });

    const result = await provisionOrganisation({ name: 'Tenant Partial', externalReference });

    // A real, non-null token is delivered — the caller is not permanently
    // stranded just because the organisation row already existed.
    expect(result).toEqual({ organisationId: 'org_partial', apiToken: 'api_healed_token', created: true });
    expect(createOrganisationMock).not.toHaveBeenCalled();
    expect(createTeamMock).toHaveBeenCalledWith(expect.objectContaining({ organisationId: 'org_partial' }));
    expect(createApiTokenMock).toHaveBeenCalledWith(expect.objectContaining({ userId: SYSTEM_USER.id, teamId: 11 }));
  });

  it('self-heals a deeper partial failure: org + team exist but the token was never minted', async () => {
    const externalReference = 'host_app:tenant-partial-token';
    const url = deriveOrganisationUrlFromExternalReference(externalReference);

    // The team row survives from a prior call whose createApiToken step
    // failed/crashed after createTeam had already committed. Team-existence
    // alone must NOT be treated as "fully provisioned" — the token is the
    // deliverable the caller actually needs.
    findUniqueMock.mockResolvedValue({ id: 'org_partial_token', url });
    findFirstMock.mockResolvedValue({ id: 21, organisationId: 'org_partial_token' });
    apiTokenFindFirstMock.mockResolvedValueOnce(null); // team exists, but no token yet
    createApiTokenMock.mockResolvedValueOnce({ id: 4, token: 'api_healed_token_2' });

    const result = await provisionOrganisation({ name: 'Tenant Partial Token', externalReference });

    expect(result).toEqual({ organisationId: 'org_partial_token', apiToken: 'api_healed_token_2', created: true });
    // The team already existed -> never re-created.
    expect(createOrganisationMock).not.toHaveBeenCalled();
    expect(createTeamMock).not.toHaveBeenCalled();
    // But the missing token IS minted, scoped to the existing team.
    expect(createApiTokenMock).toHaveBeenCalledWith(expect.objectContaining({ userId: SYSTEM_USER.id, teamId: 21 }));
  });

  it('fails loud when the system user cannot be resolved, without creating anything', async () => {
    findUniqueMock.mockResolvedValue(null);
    getReeveAdminSystemUserMock.mockRejectedValue(
      new AppError(AppErrorCode.NOT_SETUP, { message: 'REEVE_SIGN_SYSTEM_USER_EMAIL is not set.' }),
    );

    await expect(
      provisionOrganisation({ name: 'Tenant Fail', externalReference: 'host_app:tenant-fail' }),
    ).rejects.toThrow(AppError);

    expect(createOrganisationMock).not.toHaveBeenCalled();
  });
});
