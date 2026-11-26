import { EnvelopeType, TeamMemberRole } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getEnvelopeWhereInput } from './get-envelope-by-id';
import { getMultipleEnvelopeWhereInput } from './get-envelopes-by-ids';

// DEV-20496: every Reeve-provisioned organisation and its API tokens belong to
// one system user, so its owner arm must be bound to the token's team. Human
// users keep upstream semantics exactly.

const { apiTokenFindFirstMock, getTeamByIdMock, userFindFirstMock } = vi.hoisted(() => ({
  apiTokenFindFirstMock: vi.fn(),
  getTeamByIdMock: vi.fn(),
  userFindFirstMock: vi.fn(),
}));

vi.mock('../team/get-team', () => ({ getTeamById: getTeamByIdMock }));
vi.mock('@documenso/prisma', () => ({
  prisma: { user: { findFirst: userFindFirstMock }, apiToken: { findFirst: apiTokenFindFirstMock } },
}));

const ENV_KEY = 'REEVE_SIGN_SYSTEM_USER_EMAIL';
const SYSTEM_USER_ID = 900;
const HUMAN_USER_ID = 11;
const ORG_A_TEAM_ID = 101;

const buildSingle = async (userId: number) =>
  await getEnvelopeWhereInput({
    id: { type: 'envelopeId', id: 'envelope_org_b' },
    userId,
    teamId: ORG_A_TEAM_ID,
    type: EnvelopeType.DOCUMENT,
  });

const buildMultiple = async (userId: number) =>
  await getMultipleEnvelopeWhereInput({
    ids: { type: 'envelopeId', ids: ['envelope_org_b'] },
    userId,
    teamId: ORG_A_TEAM_ID,
    type: EnvelopeType.DOCUMENT,
  });

describe.each([
  ['getEnvelopeWhereInput', buildSingle],
  ['getMultipleEnvelopeWhereInput (POST /api/v2/envelope/get-many)', buildMultiple],
])('%s owner arm', (_name, build) => {
  const originalValue = process.env[ENV_KEY];

  beforeEach(() => {
    process.env[ENV_KEY] = 'reeve-system@reeve.test';
    getTeamByIdMock.mockReset();
    getTeamByIdMock.mockResolvedValue({
      id: ORG_A_TEAM_ID,
      currentTeamRole: TeamMemberRole.ADMIN,
      teamEmail: null,
    });
    userFindFirstMock.mockReset();
    userFindFirstMock.mockResolvedValue({ id: SYSTEM_USER_ID });
    apiTokenFindFirstMock.mockReset();
    apiTokenFindFirstMock.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  it("binds the system user's ownership to the token's team", async () => {
    const { envelopeWhereInput } = await build(SYSTEM_USER_ID);

    expect(envelopeWhereInput.OR?.[0]).toEqual({ userId: SYSTEM_USER_ID, teamId: ORG_A_TEAM_ID });
  });

  it('with no team email, every arm the system user gets is scoped to the token team', async () => {
    const { envelopeWhereInput } = await build(SYSTEM_USER_ID);

    expect(envelopeWhereInput.OR).toHaveLength(2);

    for (const arm of envelopeWhereInput.OR ?? []) {
      expect(arm).toMatchObject({ teamId: ORG_A_TEAM_ID });
    }
  });

  it("keeps a human user's owner arm unbound (upstream semantics)", async () => {
    const { envelopeWhereInput } = await build(HUMAN_USER_ID);

    expect(envelopeWhereInput.OR?.[0]).toEqual({ userId: HUMAN_USER_ID });
  });

  it('changes nothing when the system user email is unset', async () => {
    delete process.env[ENV_KEY];

    const { envelopeWhereInput } = await build(SYSTEM_USER_ID);

    expect(envelopeWhereInput.OR?.[0]).toEqual({ userId: SYSTEM_USER_ID });
  });

  it('keeps a previous system user bound after the email moves, while it holds a provisioning token', async () => {
    process.env[ENV_KEY] = 'next-system@reeve.test';
    userFindFirstMock.mockResolvedValue({ id: 901 });
    apiTokenFindFirstMock.mockImplementation(async ({ where }: { where: { userId: number } }) =>
      where.userId === SYSTEM_USER_ID ? { id: 77 } : null,
    );

    const { envelopeWhereInput } = await build(SYSTEM_USER_ID);

    expect(envelopeWhereInput.OR?.[0]).toEqual({ userId: SYSTEM_USER_ID, teamId: ORG_A_TEAM_ID });
  });

  it('keeps the team email arm', async () => {
    getTeamByIdMock.mockResolvedValue({
      id: ORG_A_TEAM_ID,
      currentTeamRole: TeamMemberRole.ADMIN,
      teamEmail: { email: 'team@org-a.test' },
    });

    const { envelopeWhereInput } = await build(SYSTEM_USER_ID);

    expect(envelopeWhereInput.OR).toHaveLength(3);
    expect(envelopeWhereInput.OR?.[2]).toEqual({ user: { email: 'team@org-a.test' } });
  });
});
