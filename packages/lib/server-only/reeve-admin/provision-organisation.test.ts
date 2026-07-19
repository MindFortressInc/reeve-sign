import { OrganisationType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { INTERNAL_CLAIM_ID, internalClaims } from '../../types/subscription';
import { deriveOrganisationUrlFromExternalReference } from './derive-organisation-url';

const {
  findUniqueMock,
  findUniqueOrThrowMock,
  findFirstOrThrowMock,
  createOrganisationMock,
  createTeamMock,
  createApiTokenMock,
  getReeveAdminSystemUserMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  findUniqueOrThrowMock: vi.fn(),
  findFirstOrThrowMock: vi.fn(),
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
      findFirstOrThrow: findFirstOrThrowMock,
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
    findFirstOrThrowMock.mockReset();
    createOrganisationMock.mockReset();
    createTeamMock.mockReset();
    createApiTokenMock.mockReset();
    getReeveAdminSystemUserMock.mockReset();
    getReeveAdminSystemUserMock.mockResolvedValue(SYSTEM_USER);
  });

  it('idempotent hit: returns the existing org and does not create anything', async () => {
    const url = deriveOrganisationUrlFromExternalReference('host_app:tenant-123');

    findUniqueMock.mockResolvedValue({ id: 'org_existing', url });

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
    createTeamMock.mockResolvedValueOnce(undefined);
    findFirstOrThrowMock.mockResolvedValueOnce({ id: 7, organisationId: 'org_new' });
    createApiTokenMock.mockResolvedValueOnce({ id: 1, token: 'api_first_token' });

    const first = await provisionOrganisation({ name: 'Tenant 123', externalReference });

    expect(first).toEqual({ organisationId: 'org_new', apiToken: 'api_first_token', created: true });
    expect(createOrganisationMock).toHaveBeenCalledTimes(1);

    // Second call: the org now exists (persistent, DB-backed lookup by the
    // deterministically-derived url — not in-memory).
    findUniqueMock.mockResolvedValueOnce({ id: 'org_new', url });

    const second = await provisionOrganisation({ name: 'Tenant 123', externalReference });

    expect(second).toEqual({ organisationId: 'org_new', apiToken: null, created: false });
    // Still only ever called once across both requests -> no duplicate org.
    expect(createOrganisationMock).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh organisation, team, and org-scoped api token when none exists', async () => {
    const externalReference = 'host_app:tenant-456';
    const url = deriveOrganisationUrlFromExternalReference(externalReference);

    findUniqueMock.mockResolvedValue(null);
    createOrganisationMock.mockResolvedValue({ id: 'org_456', url });
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

  it('handles a create race safely: ALREADY_EXISTS from createOrganisation resolves to the winner, not an error', async () => {
    const externalReference = 'host_app:tenant-race';
    const url = deriveOrganisationUrlFromExternalReference(externalReference);

    findUniqueMock.mockResolvedValueOnce(null);
    createOrganisationMock.mockRejectedValueOnce(
      new AppError(AppErrorCode.ALREADY_EXISTS, { message: 'Organisation URL already exists' }),
    );
    findUniqueOrThrowMock.mockResolvedValueOnce({ id: 'org_race_winner', url });

    const result = await provisionOrganisation({ name: 'Tenant Race', externalReference });

    expect(result).toEqual({ organisationId: 'org_race_winner', apiToken: null, created: false });
    expect(createTeamMock).not.toHaveBeenCalled();
    expect(createApiTokenMock).not.toHaveBeenCalled();
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
