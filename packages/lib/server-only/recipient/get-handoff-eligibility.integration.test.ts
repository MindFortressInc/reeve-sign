/**
 * Real-Postgres integration test for the DEV-654 in-person handoff tRPC
 * procedures (`recipientRouter.startHandoffCandidates`,
 * `startHandoffSigningLink`, `advanceHandoffCandidates`,
 * `advanceHandoffSigningLink`) -- exercised through a real server-side
 * caller (not a reimplementation), against a real database:
 *
 *   1. START requires real, server-verified owner/team authorization, only
 *      works before anyone has signed, and REVOKES the host's session (a
 *      real Session row) while minting the envelope-bound handoff capability
 *      -- so no signer ever holds the host's account on the handoff device.
 *   2. ADVANCE runs with no session at all, authorized only by that
 *      capability plus the completed recipient's own token; it refuses to
 *      disclose the next recipient's token until the outgoing recipient is
 *      SIGNED under a fresh DB read, and a recipient token without the
 *      capability (what every emailed recipient has) discloses nothing.
 *
 * Opt-in only, via RUN_DB_INTEGRATION_TESTS=true, mirroring
 * conditional-visibility-consent.integration.test.ts's pattern: excluded
 * from the default `vitest run` glob (vitest.config.ts), collected only by
 * vitest.db-integration.config.ts, and fails loudly (not a silent skip) if
 * selected without a real reachable/migrated database.
 *
 *   RUN_DB_INTEGRATION_TESTS=true npx dotenv -e ../../.env -- \
 *     npx vitest run --config vitest.db-integration.config.ts
 */
import { completeDocumentWithToken } from '@documenso/lib/server-only/document/complete-document-with-token';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { logger } from '@documenso/lib/utils/logger';
import { prisma } from '@documenso/prisma';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedTeam } from '@documenso/prisma/seed/teams';
import { recipientRouter } from '@documenso/trpc/server/recipient-router/router';
import { createCallerFactory } from '@documenso/trpc/server/trpc';
import { DocumentStatus, RecipientRole, SendStatus, SigningStatus } from '@prisma/client';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const RUN_INTEGRATION = process.env.RUN_DB_INTEGRATION_TESTS === 'true';

vi.mock('@documenso/lib/server-only/document/send-pending-email', () => ({ sendPendingEmail: vi.fn() }));
vi.mock('@documenso/lib/jobs/client', () => ({ jobs: { triggerJob: vi.fn() } }));

const REQUEST_METADATA = {
  requestMetadata: {},
  source: 'app' as const,
  auth: 'session' as const,
};

const callHandoffRouter = createCallerFactory(recipientRouter);

const callerAs = (user: { id: number } | null, teamId?: number) =>
  callHandoffRouter({
    session: (user ? { user } : null) as never,
    user: user as never,
    teamId,
    req: new Request('http://localhost/trpc/recipient.advanceHandoffSigningLink'),
    res: new Response(),
    metadata: { requestMetadata: {}, source: 'app', auth: user ? 'session' : null },
    logger,
  });

describe('DEV-654 handoff procedures -- real Postgres integration', () => {
  let ownerId: number;
  let teamId: number;

  beforeAll(async () => {
    // Fail loudly, not a silent skip: this file is already excluded from the
    // default `vitest run` glob (vitest.config.ts) and only collected by the
    // dedicated vitest.db-integration.config.ts, so a plain `describe.skipIf`
    // gate on the opt-in flag let running that dedicated config without
    // RUN_DB_INTEGRATION_TESTS=true finish "successfully" without ever
    // exercising the handoff behavior it exists to prove (CR PR #58 finding).
    if (!RUN_INTEGRATION) {
      throw new Error(
        'RUN_DB_INTEGRATION_TESTS=true environment variable must be set to run database integration tests',
      );
    }

    const { owner, team } = await seedTeam();
    ownerId = owner.id;
    teamId = team.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** A fresh, independent PENDING V2 envelope with two SEQUENTIAL SIGNER recipients. */
  const seedSequentialEnvelope = async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    const document = await seedBlankDocument(owner, teamId, { internalVersion: 2 });

    const envelope = await prisma.envelope.update({
      where: { id: document.id },
      data: { status: DocumentStatus.PENDING },
    });

    await prisma.documentMeta.update({
      where: { id: envelope.documentMetaId },
      data: { signingOrder: 'SEQUENTIAL' },
    });

    const signerOne = await prisma.recipient.create({
      data: {
        envelopeId: envelope.id,
        email: `signer1-${nanoid()}@test.documenso.com`,
        name: 'Signer One',
        role: RecipientRole.SIGNER,
        token: nanoid(),
        signingOrder: 1,
        sendStatus: SendStatus.SENT,
        signingStatus: SigningStatus.NOT_SIGNED,
      },
    });

    const signerTwo = await prisma.recipient.create({
      data: {
        envelopeId: envelope.id,
        email: `signer2-${nanoid()}@test.documenso.com`,
        name: 'Signer Two',
        role: RecipientRole.SIGNER,
        token: nanoid(),
        signingOrder: 2,
        sendStatus: SendStatus.SENT,
        signingStatus: SigningStatus.NOT_SIGNED,
      },
    });

    return { envelope, signerOne, signerTwo };
  };

  /** A real Session row, so START's revocation (and its session guard) run against the database. */
  const sessionFor = async (userId: number) =>
    prisma.session.create({
      data: {
        sessionToken: nanoid(),
        userId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

  const ownerSession = async () => sessionFor(ownerId);

  const sessionCaller = (session: { id: string; userId: number }, callerTeamId = teamId) =>
    callHandoffRouter({
      session: session as never,
      user: { id: session.userId } as never,
      teamId: callerTeamId,
      req: new Request('http://localhost/trpc/recipient.startHandoffSigningLink'),
      res: new Response(),
      metadata: { requestMetadata: {}, source: 'app', auth: 'session' },
      logger,
    });

  const ownerCaller = (session: { id: string; userId: number }) => sessionCaller(session);

  it('START: rejects an unauthenticated caller and a foreign host who has no access to this envelope', async () => {
    const { envelope, signerOne } = await seedSequentialEnvelope();
    const { owner: foreignOwner } = await seedTeam();

    const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);
    const input = { documentId, teamId: envelope.teamId, recipientId: signerOne.id };

    await expect(callerAs(null, teamId).startHandoffSigningLink(input)).rejects.toThrow();

    // The foreign caller sends the envelope's OWN team, as a real client
    // would, so the refusal comes from getEnvelopeById's membership check.
    const foreignSession = await sessionFor(foreignOwner.id);

    // getEnvelopeById's team-membership check is what refuses it.
    await expect(sessionCaller(foreignSession, envelope.teamId).startHandoffSigningLink(input)).rejects.toThrow(
      'Team not found',
    );

    // Refused at the membership check -- the foreign host's session is untouched.
    expect(await prisma.session.findUnique({ where: { id: foreignSession.id } })).not.toBeNull();
  });

  it('START: discloses the first signer, mints a capability and revokes the host session on this device', async () => {
    const { envelope, signerOne } = await seedSequentialEnvelope();
    const session = await ownerSession();

    const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

    const result = await ownerCaller(session).startHandoffSigningLink({
      documentId,
      teamId: envelope.teamId,
      recipientId: signerOne.id,
    });

    expect(result.signingLink).toContain(signerOne.token);
    expect(result.handoffCapability).toBeTruthy();

    expect(await prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
  });

  it('ADVANCE: a recipient token without the capability discloses nothing, and an unsigned outgoing recipient blocks advance', async () => {
    const { envelope, signerOne, signerTwo } = await seedSequentialEnvelope();

    const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

    const { handoffCapability } = await ownerCaller(await ownerSession()).startHandoffSigningLink({
      documentId,
      teamId: envelope.teamId,
      recipientId: signerOne.id,
    });

    const device = callerAs(null);

    await expect(
      device.advanceHandoffSigningLink({
        handoffCapability: 'not-a-capability',
        completedRecipientToken: signerOne.token,
        nextRecipientId: signerTwo.id,
      }),
    ).rejects.toThrow();

    // signerOne is still NOT_SIGNED -- refused even with the real capability.
    await expect(
      device.advanceHandoffSigningLink({
        handoffCapability,
        completedRecipientToken: signerOne.token,
        nextRecipientId: signerTwo.id,
      }),
    ).rejects.toThrow();

    expect(
      await device.advanceHandoffCandidates({ handoffCapability, completedRecipientToken: signerOne.token }),
    ).toEqual([]);
  });

  it('ADVANCE: once signerOne genuinely completes, the session-less device advances to signerTwo only, and START is closed', async () => {
    const { envelope, signerOne, signerTwo } = await seedSequentialEnvelope();

    const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

    const { handoffCapability } = await ownerCaller(await ownerSession()).startHandoffSigningLink({
      documentId,
      teamId: envelope.teamId,
      recipientId: signerOne.id,
    });

    // Real completion, through the real production function -- not a raw DB update.
    await completeDocumentWithToken({
      token: signerOne.token,
      id: { type: 'envelopeId', id: envelope.id },
      ...REQUEST_METADATA,
    });

    const device = callerAs(null);

    const result = await device.advanceHandoffSigningLink({
      handoffCapability,
      completedRecipientToken: signerOne.token,
      nextRecipientId: signerTwo.id,
    });

    expect(result.email).toBe(signerTwo.email);
    expect(result.signingLink).toContain(signerTwo.token);

    // signerOne themselves is never offered back as a next candidate.
    await expect(
      device.advanceHandoffSigningLink({
        handoffCapability,
        completedRecipientToken: signerOne.token,
        nextRecipientId: signerOne.id,
      }),
    ).rejects.toThrow();

    // START boundary: with signerOne signed, a host can no longer START mid-envelope.
    const hostAgain = ownerCaller(await ownerSession());

    expect(await hostAgain.startHandoffCandidates({ documentId, teamId: envelope.teamId })).toEqual([]);
    await expect(
      hostAgain.startHandoffSigningLink({ documentId, teamId: envelope.teamId, recipientId: signerTwo.id }),
    ).rejects.toThrow();
  });
});
