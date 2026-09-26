import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { INTERNAL_CLAIM_ID } from '../../types/subscription';
import { buildTeamWhereQuery } from '../../utils/teams';

const { userFindFirstMock, teamFindFirstMock } = vi.hoisted(() => ({
  userFindFirstMock: vi.fn(),
  teamFindFirstMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: { findFirst: userFindFirstMock },
    team: { findFirst: teamFindFirstMock },
  },
}));

const { REEVE_ON_BEHALF_OF_HEADER, resolveOnBehalfOfUserId } = await import('./resolve-on-behalf-of-user');

const SYSTEM_USER_EMAIL = 'reeve-provisioner@meetreeve.com';

const REEVE_ORGANISATION_FILTER = {
  owner: { email: { equals: SYSTEM_USER_EMAIL, mode: 'insensitive' } },
  organisationClaim: { originalSubscriptionClaimId: INTERNAL_CLAIM_ID.PLATFORM },
};

const headersWith = (value?: string) => new Headers(value === undefined ? {} : { [REEVE_ON_BEHALF_OF_HEADER]: value });

const expectForbidden = async (promise: Promise<unknown>) => {
  const err = await promise.catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(AppErrorCode.FORBIDDEN);
};

describe('resolveOnBehalfOfUserId', () => {
  beforeEach(() => {
    userFindFirstMock.mockReset();
    teamFindFirstMock.mockReset();
    vi.stubEnv('REEVE_SIGN_SYSTEM_USER_EMAIL', SYSTEM_USER_EMAIL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the pinned C1 header name', () => {
    expect(REEVE_ON_BEHALF_OF_HEADER).toBe('X-Reeve-Sign-On-Behalf-Of');
  });

  it('returns null without touching the DB when the header is absent or blank', async () => {
    expect(await resolveOnBehalfOfUserId({ headers: headersWith(), teamId: 7 })).toBeNull();
    expect(await resolveOnBehalfOfUserId({ headers: headersWith('   '), teamId: 7 })).toBeNull();

    expect(userFindFirstMock).not.toHaveBeenCalled();
    expect(teamFindFirstMock).not.toHaveBeenCalled();
  });

  it("returns the member's user id when the email belongs to a member of the token's team", async () => {
    userFindFirstMock.mockResolvedValue({ id: 77 });
    teamFindFirstMock.mockResolvedValue({ id: 7 });

    const userId = await resolveOnBehalfOfUserId({ headers: headersWith(' Matt@MindFortress.com '), teamId: 7 });

    expect(userId).toBe(77);
    expect(userFindFirstMock).toHaveBeenCalledWith({
      where: { email: { equals: 'Matt@MindFortress.com', mode: 'insensitive' }, disabled: false },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    // Membership is scoped to the token's team, and only Reeve-provisioned
    // orgs (system-user owned + PLATFORM claim) honour the header (upstream
    // teams keep their own opt-in delegateDocumentOwnership instead).
    expect(teamFindFirstMock).toHaveBeenCalledWith({
      where: {
        ...buildTeamWhereQuery({ teamId: 7, userId: 77 }),
        organisation: REEVE_ORGANISATION_FILTER,
      },
      select: { id: true },
    });
  });

  it('403s for a disabled user (the lookup excludes them)', async () => {
    userFindFirstMock.mockResolvedValue(null);

    await expectForbidden(resolveOnBehalfOfUserId({ headers: headersWith('disabled@mindfortress.com'), teamId: 7 }));
    expect(userFindFirstMock.mock.calls[0][0].where.disabled).toBe(false);
  });

  it("403s on a team that is not Reeve-provisioned, even for a real member (the team query doesn't match)", async () => {
    userFindFirstMock.mockResolvedValue({ id: 3 });
    teamFindFirstMock.mockResolvedValue(null);

    await expectForbidden(resolveOnBehalfOfUserId({ headers: headersWith('matt@mindfortress.com'), teamId: 3 }));
    // Keyed on system-user ownership + claim, never the manager-editable
    // `reeve-ext-` url prefix.
    expect(teamFindFirstMock.mock.calls[0][0].where.organisation).toEqual(REEVE_ORGANISATION_FILTER);
  });

  it('403s on a non-Reeve org that bought the PLATFORM plan (the claim alone is not provenance)', async () => {
    userFindFirstMock.mockResolvedValue({ id: 3 });
    teamFindFirstMock.mockResolvedValue(null);

    await expectForbidden(resolveOnBehalfOfUserId({ headers: headersWith('matt@mindfortress.com'), teamId: 3 }));
    // The PLATFORM claim is paired with ownership by the Reeve system user,
    // which ordinary organisation creation and billing can never assign.
    expect(teamFindFirstMock.mock.calls[0][0].where.organisation.owner).toEqual({
      email: { equals: SYSTEM_USER_EMAIL, mode: 'insensitive' },
    });
  });

  it('403s without touching the DB when REEVE_SIGN_SYSTEM_USER_EMAIL is unset (fails closed)', async () => {
    vi.stubEnv('REEVE_SIGN_SYSTEM_USER_EMAIL', '');

    await expectForbidden(resolveOnBehalfOfUserId({ headers: headersWith('matt@mindfortress.com'), teamId: 7 }));

    expect(userFindFirstMock).not.toHaveBeenCalled();
    expect(teamFindFirstMock).not.toHaveBeenCalled();
  });

  it('403s for an email with no Documenso user', async () => {
    userFindFirstMock.mockResolvedValue(null);

    await expectForbidden(resolveOnBehalfOfUserId({ headers: headersWith('stranger@example.com'), teamId: 7 }));
  });

  it("403s for a real user who is not a member of the token's team", async () => {
    userFindFirstMock.mockResolvedValue({ id: 99 });
    teamFindFirstMock.mockResolvedValue(null);

    await expectForbidden(resolveOnBehalfOfUserId({ headers: headersWith('other-org@example.com'), teamId: 7 }));
  });

  it('403s when the token has no team to scope the lookup to', async () => {
    await expectForbidden(
      resolveOnBehalfOfUserId({ headers: headersWith('matt@mindfortress.com'), teamId: undefined }),
    );

    expect(userFindFirstMock).not.toHaveBeenCalled();
  });
});
