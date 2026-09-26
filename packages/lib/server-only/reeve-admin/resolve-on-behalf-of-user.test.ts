import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    // orgs (PLATFORM claim) honour the header (upstream teams keep their own
    // opt-in delegateDocumentOwnership instead).
    expect(teamFindFirstMock).toHaveBeenCalledWith({
      where: {
        ...buildTeamWhereQuery({ teamId: 7, userId: 77 }),
        organisation: { organisationClaim: { originalSubscriptionClaimId: INTERNAL_CLAIM_ID.PLATFORM } },
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
    // Keyed on the claim, never the manager-editable `reeve-ext-` url prefix.
    expect(teamFindFirstMock.mock.calls[0][0].where.organisation).toEqual({
      organisationClaim: { originalSubscriptionClaimId: 'platform' },
    });
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
