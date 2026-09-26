import { OrganisationGroupType, OrganisationMemberRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { deriveOrganisationUrlFromExternalReference } from './derive-organisation-url';

const {
  organisationFindUniqueMock,
  userFindFirstMock,
  userCreateMock,
  organisationMemberFindFirstMock,
  organisationMemberCreateMock,
  triggerJobMock,
} = vi.hoisted(() => ({
  organisationFindUniqueMock: vi.fn(),
  userFindFirstMock: vi.fn(),
  userCreateMock: vi.fn(),
  organisationMemberFindFirstMock: vi.fn(),
  organisationMemberCreateMock: vi.fn(),
  triggerJobMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    organisation: { findUnique: organisationFindUniqueMock },
    user: { findFirst: userFindFirstMock, create: userCreateMock },
    organisationMember: { findFirst: organisationMemberFindFirstMock, create: organisationMemberCreateMock },
  },
}));

// Every email Documenso sends goes through a background job; asserting this
// is never triggered is how "no invite/welcome/verification email" is pinned.
vi.mock('../../jobs/client', () => ({
  jobs: { triggerJob: triggerJobMock },
}));

const { ensureOrganisationMember } = await import('./ensure-organisation-member');

const EXTERNAL_REFERENCE = 'org-mindfortress';

const ORG = {
  id: 'org_mf',
  url: deriveOrganisationUrlFromExternalReference(EXTERNAL_REFERENCE),
  groups: [
    {
      id: 'grp_admin',
      type: OrganisationGroupType.INTERNAL_ORGANISATION,
      organisationRole: OrganisationMemberRole.ADMIN,
    },
    {
      id: 'grp_member',
      type: OrganisationGroupType.INTERNAL_ORGANISATION,
      organisationRole: OrganisationMemberRole.MEMBER,
    },
  ],
};

describe('ensureOrganisationMember', () => {
  beforeEach(() => {
    for (const mock of [
      organisationFindUniqueMock,
      userFindFirstMock,
      userCreateMock,
      organisationMemberFindFirstMock,
      organisationMemberCreateMock,
      triggerJobMock,
    ]) {
      mock.mockReset();
    }
  });

  it('throws NOT_FOUND for an unknown external_reference and creates nothing', async () => {
    organisationFindUniqueMock.mockResolvedValue(null);

    const promise = ensureOrganisationMember({
      externalReference: 'org-unknown',
      email: 'matt@mindfortress.com',
      name: 'Matt Rhodes',
    });

    await expect(promise).rejects.toThrow(AppError);
    await promise.catch((err) => expect((err as AppError).code).toBe(AppErrorCode.NOT_FOUND));
    expect(organisationFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { url: deriveOrganisationUrlFromExternalReference('org-unknown') } }),
    );
    expect(userCreateMock).not.toHaveBeenCalled();
    expect(organisationMemberCreateMock).not.toHaveBeenCalled();
  });

  it('new user: creates an email-verified, passwordless user and adds them to the org MEMBER group, sending no email', async () => {
    organisationFindUniqueMock.mockResolvedValue(ORG);
    userFindFirstMock.mockResolvedValue(null);
    userCreateMock.mockResolvedValue({ id: 77, email: 'matt@mindfortress.com', name: 'Matt Rhodes' });
    organisationMemberFindFirstMock.mockResolvedValue(null);

    const result = await ensureOrganisationMember({
      externalReference: EXTERNAL_REFERENCE,
      email: 'Matt@MindFortress.com',
      name: 'Matt Rhodes',
    });

    expect(result).toEqual({ userId: 77, created: true });

    const createArgs = userCreateMock.mock.calls[0][0];
    expect(createArgs.data).toEqual({
      email: 'matt@mindfortress.com',
      name: 'Matt Rhodes',
      emailVerified: expect.any(Date),
    });
    expect(createArgs.data).not.toHaveProperty('password');

    // Membership via the org's internal MEMBER group -> MEMBER on the team
    // (provisioned teams inherit org members).
    expect(organisationMemberCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 77,
        organisationId: 'org_mf',
        organisationGroupMembers: { create: expect.objectContaining({ groupId: 'grp_member' }) },
      }),
    });
    expect(triggerJobMock).not.toHaveBeenCalled();
  });

  it('existing user who is not yet a member: adds membership only, created=false, no email', async () => {
    organisationFindUniqueMock.mockResolvedValue(ORG);
    userFindFirstMock.mockResolvedValue({ id: 3, email: 'matt@mindfortress.com', name: 'Matt Rhodes' });
    organisationMemberFindFirstMock.mockResolvedValue(null);

    const result = await ensureOrganisationMember({
      externalReference: EXTERNAL_REFERENCE,
      email: 'matt@mindfortress.com',
      name: 'Matt Rhodes',
    });

    expect(result).toEqual({ userId: 3, created: false });
    expect(userFindFirstMock).toHaveBeenCalledWith({
      where: { email: { equals: 'matt@mindfortress.com', mode: 'insensitive' } },
    });
    expect(userCreateMock).not.toHaveBeenCalled();
    expect(organisationMemberCreateMock).toHaveBeenCalledTimes(1);
    expect(triggerJobMock).not.toHaveBeenCalled();
  });

  it('is idempotent: an existing member is left untouched', async () => {
    organisationFindUniqueMock.mockResolvedValue(ORG);
    userFindFirstMock.mockResolvedValue({ id: 3, email: 'matt@mindfortress.com', name: 'Matt Rhodes' });
    organisationMemberFindFirstMock.mockResolvedValue({ id: 'member_1', userId: 3, organisationId: 'org_mf' });

    const result = await ensureOrganisationMember({
      externalReference: EXTERNAL_REFERENCE,
      email: 'matt@mindfortress.com',
      name: 'Matt Rhodes',
    });

    expect(result).toEqual({ userId: 3, created: false });
    expect(userCreateMock).not.toHaveBeenCalled();
    expect(organisationMemberCreateMock).not.toHaveBeenCalled();
    expect(triggerJobMock).not.toHaveBeenCalled();
  });

  it('handles a concurrent create of the same user (unique email) by re-reading the winner', async () => {
    organisationFindUniqueMock.mockResolvedValue(ORG);
    userFindFirstMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 88, email: 'new@mindfortress.com', name: 'New' });
    userCreateMock.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    organisationMemberFindFirstMock.mockResolvedValue({ id: 'member_2', userId: 88, organisationId: 'org_mf' });

    const result = await ensureOrganisationMember({
      externalReference: EXTERNAL_REFERENCE,
      email: 'new@mindfortress.com',
      name: 'New',
    });

    expect(result).toEqual({ userId: 88, created: false });
  });
  it('handles a concurrent membership create (unique userId+organisationId) as an idempotent success', async () => {
    organisationFindUniqueMock.mockResolvedValue(ORG);
    userFindFirstMock.mockResolvedValue({ id: 3, email: 'matt@mindfortress.com', name: 'Matt Rhodes' });
    organisationMemberFindFirstMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'member_race', userId: 3, organisationId: 'org_mf' });
    organisationMemberCreateMock.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );

    const result = await ensureOrganisationMember({
      externalReference: EXTERNAL_REFERENCE,
      email: 'matt@mindfortress.com',
      name: 'Matt Rhodes',
    });

    expect(result).toEqual({ userId: 3, created: false });
  });
});
