import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { verifyEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/verify-embedding-presign-token';
import { getTeamById } from '@documenso/lib/server-only/team/get-team';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, TemplateType } from '@prisma/client';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HonoEnv } from '../../router';
import { filesRoute } from './files';

/**
 * DEV-20496: the Reeve system user owns, and is a member of, every
 * Reeve-provisioned team. A presign token minted from org A's API token must
 * not read org B's envelope PDF by id. Human users keep their membership-based
 * access. Drives the real Hono routes; the session, the presign verification,
 * the database and the storage read are stubbed.
 */

vi.mock('@documenso/lib/client-only/providers/i18n-server', () => ({
  loadCatalog: vi.fn(async (lang: string) => ({ [lang]: {} })),
  allI18nInstances: Promise.resolve({}),
  getI18nInstance: vi.fn(async () => ({ _: (message: unknown) => message })),
}));

vi.mock('@documenso/auth/server/lib/utils/get-session', () => ({ getOptionalSession: vi.fn() }));

vi.mock('@documenso/lib/server-only/embedding-presign/verify-embedding-presign-token', () => ({
  verifyEmbeddingPresignToken: vi.fn(),
}));

// Membership alone: the system user, like a multi-team human, belongs to both teams.
vi.mock('@documenso/lib/server-only/team/get-team', () => ({ getTeamById: vi.fn() }));

vi.mock('@documenso/lib/universal/upload/get-file.server', () => ({ getFileServerSide: vi.fn() }));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    apiToken: { findFirst: vi.fn() },
    organisation: { findFirst: vi.fn() },
    envelope: { findFirst: vi.fn() },
    envelopeItem: { findFirst: vi.fn() },
  },
}));

const ENV_KEY = 'REEVE_SIGN_SYSTEM_USER_EMAIL';
const SYSTEM_USER_ID = 900;
const HUMAN_USER_ID = 11;
const ORG_A_TEAM_ID = 101;
const ORG_B_TEAM_ID = 202;

const app = new Hono<HonoEnv>().route('/api/files', filesRoute);

const documentData = { id: 'data_1', type: 'BYTES_64', data: 'c2lnbmVk', initialData: 'aW5pdGlhbA==' };

const envelopeIn = (teamId: number) => ({
  id: 'envelope_1',
  type: EnvelopeType.DOCUMENT,
  templateType: TemplateType.PRIVATE,
  status: DocumentStatus.DRAFT,
  teamId,
  envelopeItems: [{ id: 'item_1', title: 'NDA', documentData }],
});

const presignFor = (userId: number, teamId: number) =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  vi
    .mocked(verifyEmbeddingPresignToken)
    .mockResolvedValue({ userId, teamId } as unknown as Awaited<ReturnType<typeof verifyEmbeddingPresignToken>>);

const envelopeLives = (teamId: number) => {
  const envelope = envelopeIn(teamId);

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  vi.mocked(prisma.envelope.findFirst).mockResolvedValue(envelope as never);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  vi.mocked(prisma.envelopeItem.findFirst).mockResolvedValue({
    id: 'item_1',
    envelopeId: envelope.id,
    documentDataId: documentData.id,
    documentData,
    envelope: { id: envelope.id, type: envelope.type, teamId, templateType: envelope.templateType },
  } as never);
};

const routes = [
  [
    'GET /envelope/:id/envelopeItem/:itemId?token=',
    () => '/api/files/envelope/envelope_1/envelopeItem/item_1?token=pre_x',
  ],
  [
    'GET /envelope/:id/envelopeItem/:itemId/dataId/:dataId/:version/item.pdf?presignToken=',
    () => '/api/files/envelope/envelope_1/envelopeItem/item_1/dataId/data_1/current/item.pdf?presignToken=pre_x',
  ],
] as const;

describe.each(routes)('%s', (_name, path) => {
  const originalValue = process.env[ENV_KEY];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env[ENV_KEY] = 'reeve-system@reeve.test';
    vi.mocked(getOptionalSession).mockResolvedValue({ isAuthenticated: false, session: null, user: null });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: SYSTEM_USER_ID } as never);
    vi.mocked(prisma.apiToken.findFirst).mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    vi.mocked(getTeamById).mockResolvedValue({ id: ORG_B_TEAM_ID } as never);
    vi.mocked(getFileServerSide).mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  it("refuses the system user's org A token on an org B envelope", async () => {
    presignFor(SYSTEM_USER_ID, ORG_A_TEAM_ID);
    envelopeLives(ORG_B_TEAM_ID);

    const res = await app.request(`http://localhost${path()}`);

    expect([403, 404]).toContain(res.status);
    expect(getFileServerSide).not.toHaveBeenCalled();
  });

  it("serves the system user's token on its own team's envelope", async () => {
    presignFor(SYSTEM_USER_ID, ORG_A_TEAM_ID);
    envelopeLives(ORG_A_TEAM_ID);

    const res = await app.request(`http://localhost${path()}`);

    expect(res.status).toBe(200);
  });

  it("refuses a previous system user's org A token on an org B envelope after the email moves", async () => {
    process.env[ENV_KEY] = 'next-system@reeve.test';
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 901 } as never);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    vi.mocked(prisma.apiToken.findFirst).mockResolvedValue({ id: 77 } as never);
    presignFor(SYSTEM_USER_ID, ORG_A_TEAM_ID);
    envelopeLives(ORG_B_TEAM_ID);

    const res = await app.request(`http://localhost${path()}`);

    expect([403, 404]).toContain(res.status);
    expect(getFileServerSide).not.toHaveBeenCalled();
  });

  it("keeps a human member's cross-team access (upstream semantics)", async () => {
    presignFor(HUMAN_USER_ID, ORG_A_TEAM_ID);
    envelopeLives(ORG_B_TEAM_ID);

    const res = await app.request(`http://localhost${path()}`);

    expect(res.status).toBe(200);
  });
});
