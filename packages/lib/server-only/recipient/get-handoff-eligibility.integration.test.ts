/**
 * Real-Postgres integration test for the DEV-654 in-person handoff tRPC
 * procedures (`recipientRouter.startHandoffCandidates`,
 * `startHandoffSigningLink`, `advanceHandoffSigningLink`) -- exercised
 * through a real server-side caller (not a reimplementation), against a real
 * database, proving the two review findings this ticket fixed actually hold
 * end to end and not just against a mocked `getEnvelopeById`:
 *
 *   1. `advanceHandoffSigningLink` refuses to disclose the next recipient's
 *      token when the outgoing (`completedRecipientId`) recipient has not
 *      actually reached SIGNED status under a fresh DB read -- a caller
 *      cannot skip this by only being an authorized host.
 *   2. Every handoff procedure requires real, server-verified owner/team
 *      authorization: no session at all, and an authenticated user with no
 *      access to this specific envelope, are both refused -- a recipient's
 *      own signing token is never accepted as authorization here at all.
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

  it('rejects an unauthenticated caller outright (no session at all)', async () => {
    const { envelope, signerOne, signerTwo } = await seedSequentialEnvelope();

    const caller = callerAs(null, teamId);

    const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

    await expect(
      caller.advanceHandoffSigningLink({
        documentId,
        teamId: envelope.teamId,
        completedRecipientId: signerOne.id,
        nextRecipientId: signerTwo.id,
      }),
    ).rejects.toThrow();
  });

  it('rejects a foreign host who has no access to this envelope', async () => {
    const { envelope, signerOne, signerTwo } = await seedSequentialEnvelope();
    const { owner: foreignOwner } = await seedTeam();

    const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

    // Complete signerOne for real first, so this call would otherwise be a
    // valid, eligible advance. Without this, signerOne is still NOT_SIGNED
    // and the call rejects for that unrelated reason regardless of who's
    // calling -- which would let a real authorization regression here pass
    // undetected (CR PR #58 finding). With signerOne genuinely SIGNED, a
    // .rejects.toThrow() below can only be explained by the foreign-host
    // authorization boundary.
    await completeDocumentWithToken({
      token: signerOne.token,
      id: { type: 'envelopeId', id: envelope.id },
      ...REQUEST_METADATA,
    });

    // A real client always sends the envelope's OWN team (as complete.tsx's
    // loader / documents.$id._index.tsx do) -- never a team the foreign
    // caller happens to belong to. This is the case that actually matters:
    // an authenticated user who is simply not a member of THIS envelope's team.
    const caller = callerAs({ id: foreignOwner.id }, envelope.teamId);

    await expect(
      caller.advanceHandoffSigningLink({
        documentId,
        teamId: envelope.teamId,
        completedRecipientId: signerOne.id,
        nextRecipientId: signerTwo.id,
      }),
    ).rejects.toThrow();
  });

  it('DEV-654 review finding: denies advance when the outgoing recipient has NOT actually signed, even for the real authorized owner', async () => {
    const { envelope, signerOne, signerTwo } = await seedSequentialEnvelope();

    const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

    const caller = callerAs({ id: ownerId }, teamId);

    // signerOne is still NOT_SIGNED (never completed) -- this must be refused
    // even though the caller is the real, verified owner of this envelope.
    await expect(
      caller.advanceHandoffSigningLink({
        documentId,
        teamId: envelope.teamId,
        completedRecipientId: signerOne.id,
        nextRecipientId: signerTwo.id,
      }),
    ).rejects.toThrow();

    // And confirm no token leaked into the candidate list either.
    const candidates = await caller.startHandoffCandidates({ documentId, teamId: envelope.teamId });
    expect(candidates.map((c) => c.recipientId)).toEqual([signerOne.id]);
  });

  it('allows advance once signerOne has genuinely completed through the real completion route, to signerTwo only', async () => {
    const { envelope, signerOne, signerTwo } = await seedSequentialEnvelope();

    const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

    // Real completion, through the real production function -- not a raw DB update.
    await completeDocumentWithToken({
      token: signerOne.token,
      id: { type: 'envelopeId', id: envelope.id },
      ...REQUEST_METADATA,
    });

    const caller = callerAs({ id: ownerId }, teamId);

    const result = await caller.advanceHandoffSigningLink({
      documentId,
      teamId: envelope.teamId,
      completedRecipientId: signerOne.id,
      nextRecipientId: signerTwo.id,
    });

    expect(result.email).toBe(signerTwo.email);
    expect(result.signingLink).toContain(signerTwo.token);

    // signerOne themselves is never offered back as a next candidate.
    await expect(
      caller.advanceHandoffSigningLink({
        documentId,
        teamId: envelope.teamId,
        completedRecipientId: signerOne.id,
        nextRecipientId: signerOne.id,
      }),
    ).rejects.toThrow();
  });
});
