/**
 * Real-Postgres integration test proving that the envelope-row `FOR UPDATE`
 * lock added for conditional field visibility actually serializes concurrent
 * transactions, and that the production guards it protects (the checkbox
 * controller-mutation guard in `sign-envelope-field.ts`'s real tRPC route, and
 * the visibility-aware completion gate in `complete-document-with-token.ts`)
 * behave correctly under real ordering and real overlap — not a
 * hand-rolled re-implementation of either guard.
 *
 * Mock boundary (explicit): `./send-pending-email` and `jobs.triggerJob` are
 * mocked — both are unrelated notification side effects (the former fails
 * under vitest's SSR module runner for an unrelated pre-existing reason —
 * dynamic `.mjs` translation imports aren't resolvable there; the latter would
 * otherwise POST to NEXT_PRIVATE_INTERNAL_WEBAPP_URL, which on a shared
 * machine could hit an unrelated sibling worktree's dev server). Everything
 * else — the database, the envelope-row lock, the tRPC route's own resolver
 * (invoked via a real server-side caller, not reimplemented), condition
 * resolution, and consent-protection — is fully real and unmocked.
 *
 * Requires a live, migrated database reachable via NEXT_PRIVATE_DATABASE_URL
 * (see docker/development or a worktree-local instance) — run with:
 *
 *   cd packages/lib && npx dotenv -e ../../.env -- npx vitest run \
 *     server-only/document/conditional-visibility-consent.integration.test.ts
 */
import { updateEnvelopeFields } from '@documenso/lib/server-only/field/update-envelope-fields';
import { logger } from '@documenso/lib/utils/logger';
import { prisma } from '@documenso/prisma';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedTeam } from '@documenso/prisma/seed/teams';
import { signEnvelopeFieldRoute } from '@documenso/trpc/server/envelope-router/sign-envelope-field';
import { createCallerFactory, router } from '@documenso/trpc/server/trpc';
import { DocumentStatus, FieldType, RecipientRole, SendStatus, SigningStatus } from '@prisma/client';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors/app-error';
import { completeDocumentWithToken } from './complete-document-with-token';

vi.mock('./send-pending-email', () => ({ sendPendingEmail: vi.fn() }));
vi.mock('@documenso/lib/jobs/client', () => ({ jobs: { triggerJob: vi.fn() } }));

const REQUEST_METADATA = {
  requestMetadata: {},
  source: 'app' as const,
  auth: 'session' as const,
};

let ownerId: number;
let teamId: number;

beforeAll(async () => {
  const { owner, team } = await seedTeam();

  ownerId = owner.id;
  teamId = team.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Unauthenticated server-side caller for the real `envelope.field.sign` tRPC
 * route (`sign-envelope-field.ts`) — exercises its actual resolver, including
 * the envelope-row lock and the controller-mutation consent guard, with no
 * HTTP hop and no reimplementation of either. Built from a router containing
 * ONLY this one route (not the full `envelopeRouter`, which transitively pulls
 * in ~30 unrelated routes and their own module-level side effects) so this
 * file's dependency graph stays scoped to what's actually under test.
 */
const testRouter = router({ field: { sign: signEnvelopeFieldRoute } });
const callTestRouter = createCallerFactory(testRouter);

const createSignCaller = () => {
  return callTestRouter({
    session: null,
    user: null,
    teamId: undefined,
    req: new Request('http://localhost/trpc/envelope.field.sign'),
    res: new Response(),
    metadata: { requestMetadata: {}, source: 'app', auth: null },
    logger,
  });
};

/**
 * Builds a fresh, independent PENDING V2 envelope with two recipients:
 * - `buyer`: owns a CHECKBOX field ("has a co-buyer").
 * - `coBuyer`: owns a required SIGNATURE field whose `condition` is gated on
 *   the buyer's checkbox.
 *
 * Both recipients have no signingOrder set, so DocumentMeta's default PARALLEL
 * signing order applies and either can act at any time — required for these
 * tests to exercise genuine concurrency rather than sequential-order blocking.
 */
const seedCoBuyerScenario = async () => {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });

  const document = await seedBlankDocument(owner, teamId, { internalVersion: 2 });

  const envelope = await prisma.envelope.update({
    where: { id: document.id },
    data: { status: DocumentStatus.PENDING },
  });

  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: envelope.id } });

  const buyer = await prisma.recipient.create({
    data: {
      envelopeId: envelope.id,
      email: `buyer-${nanoid()}@test.documenso.com`,
      name: 'Buyer',
      role: RecipientRole.SIGNER,
      token: nanoid(),
      sendStatus: SendStatus.SENT,
      signingStatus: SigningStatus.NOT_SIGNED,
    },
  });

  const coBuyer = await prisma.recipient.create({
    data: {
      envelopeId: envelope.id,
      email: `cobuyer-${nanoid()}@test.documenso.com`,
      name: 'Co-Buyer',
      role: RecipientRole.SIGNER,
      token: nanoid(),
      sendStatus: SendStatus.SENT,
      signingStatus: SigningStatus.NOT_SIGNED,
    },
  });

  const checkboxField = await prisma.field.create({
    data: {
      envelopeId: envelope.id,
      envelopeItemId: envelopeItem.id,
      recipientId: buyer.id,
      type: FieldType.CHECKBOX,
      page: 1,
      positionX: 0,
      positionY: 0,
      width: 5,
      height: 5,
      customText: '',
      inserted: false,
      fieldMeta: {
        type: 'checkbox',
        direction: 'vertical',
        values: [{ id: 1, checked: false, value: 'I have a co-buyer' }],
      },
    },
  });

  const signatureField = await prisma.field.create({
    data: {
      envelopeId: envelope.id,
      envelopeItemId: envelopeItem.id,
      recipientId: coBuyer.id,
      type: FieldType.SIGNATURE,
      page: 1,
      positionX: 10,
      positionY: 10,
      width: 5,
      height: 5,
      customText: '',
      inserted: false,
      fieldMeta: {
        type: 'signature',
        overflow: 'auto',
        required: true,
        condition: { fieldId: checkboxField.id, optionIds: [1] },
      },
    },
  });

  return { owner, envelope, buyer, coBuyer, checkboxField, signatureField };
};

/** SETUP-only helper (not a stand-in for the real sign route) — establishes a
 * pre-existing checkbox state before testing something else's behavior. */
const setCheckboxChecked = async (fieldId: number, checked: boolean) => {
  await prisma.field.update({
    where: { id: fieldId },
    data: {
      customText: checked ? JSON.stringify([0]) : JSON.stringify([]),
      inserted: checked,
    },
  });
};

const checkBuyerBoxThroughRealRoute = (buyerToken: string, checkboxFieldId: number) => {
  const caller = createSignCaller();

  return caller.field.sign({
    token: buyerToken,
    fieldId: checkboxFieldId,
    fieldValue: { type: FieldType.CHECKBOX, value: [0] },
  });
};

describe('completion locking (real Postgres)', () => {
  it('rejects a duplicate/racing completion of the same recipient instead of both succeeding', async () => {
    const { envelope, coBuyer } = await seedCoBuyerScenario();

    // Box left unchecked: CoBuyer's dependent signature field is hidden and
    // exempt, so completion succeeds without it.
    const complete = () =>
      completeDocumentWithToken({
        token: coBuyer.token,
        id: { type: 'envelopeId', id: envelope.id },
        ...REQUEST_METADATA,
      });

    const results = await Promise.allSettled([complete(), complete()]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const rejectedReason = rejected[0].status === 'rejected' ? String(rejected[0].reason) : '';
    expect(rejectedReason).toMatch(/already signed/i);

    const finalRecipient = await prisma.recipient.findUniqueOrThrow({ where: { id: coBuyer.id } });
    expect(finalRecipient.signingStatus).toBe(SigningStatus.SIGNED);
  });

  it('exempts a required field hidden by an unmet condition from blocking completion', async () => {
    const { envelope, coBuyer } = await seedCoBuyerScenario();

    // Checkbox left unchecked (default) => dependent signature field hidden.
    await expect(
      completeDocumentWithToken({
        token: coBuyer.token,
        id: { type: 'envelopeId', id: envelope.id },
        ...REQUEST_METADATA,
      }),
    ).resolves.toBeUndefined();

    const finalRecipient = await prisma.recipient.findUniqueOrThrow({ where: { id: coBuyer.id } });
    expect(finalRecipient.signingStatus).toBe(SigningStatus.SIGNED);
  });

  it('still blocks completion on a required field once its condition is met', async () => {
    const { envelope, coBuyer, checkboxField } = await seedCoBuyerScenario();

    await setCheckboxChecked(checkboxField.id, true);

    await expect(
      completeDocumentWithToken({
        token: coBuyer.token,
        id: { type: 'envelopeId', id: envelope.id },
        ...REQUEST_METADATA,
      }),
    ).rejects.toThrow(/unsigned fields/i);

    const finalRecipient = await prisma.recipient.findUniqueOrThrow({ where: { id: coBuyer.id } });
    expect(finalRecipient.signingStatus).toBe(SigningStatus.NOT_SIGNED);
  });

  it(
    "rejects an authoring edit that would retype away a completed recipient's controller " +
      '(consent protection) instead of silently clearing their condition',
    async () => {
      const { owner, envelope, coBuyer, checkboxField } = await seedCoBuyerScenario();

      // CoBuyer completes while the box is off: their signature field is
      // legitimately hidden + exempt.
      await completeDocumentWithToken({
        token: coBuyer.token,
        id: { type: 'envelopeId', id: envelope.id },
        ...REQUEST_METADATA,
      });

      const finalRecipientBefore = await prisma.recipient.findUniqueOrThrow({ where: { id: coBuyer.id } });
      expect(finalRecipientBefore.signingStatus).toBe(SigningStatus.SIGNED);

      // The sender now tries to retype Buyer's (not-yet-interacted) checkbox to
      // a TEXT field. Silently doing so would make CoBuyer's condition dangling
      // (cascade-cleared to unconditional), which would spring the field open
      // as required-but-unsigned for a recipient who can never sign again.
      await expect(
        updateEnvelopeFields({
          userId: owner.id,
          teamId,
          id: { type: 'envelopeId', id: envelope.id },
          fields: [{ id: checkboxField.id, type: FieldType.TEXT, fieldMeta: { type: 'text' } }],
          requestMetadata: REQUEST_METADATA,
        }),
      ).rejects.toThrow(AppError);

      // The checkbox field, and CoBuyer's condition, must be untouched.
      const checkboxAfter = await prisma.field.findUniqueOrThrow({ where: { id: checkboxField.id } });
      expect(checkboxAfter.type).toBe(FieldType.CHECKBOX);
    },
  );

  it('allows the same retype once the dependent recipient has NOT yet completed (graceful cascade-clear)', async () => {
    const { owner, envelope, checkboxField, signatureField } = await seedCoBuyerScenario();

    // Nobody has completed yet — retyping the checkbox should succeed and
    // silently clear the now-dangling condition on the dependent field.
    await expect(
      updateEnvelopeFields({
        userId: owner.id,
        teamId,
        id: { type: 'envelopeId', id: envelope.id },
        fields: [{ id: checkboxField.id, type: FieldType.TEXT, fieldMeta: { type: 'text' } }],
        requestMetadata: REQUEST_METADATA,
      }),
    ).resolves.toBeDefined();

    const checkboxAfter = await prisma.field.findUniqueOrThrow({ where: { id: checkboxField.id } });
    expect(checkboxAfter.type).toBe(FieldType.TEXT);

    const signatureAfter = await prisma.field.findUniqueOrThrow({ where: { id: signatureField.id } });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    expect((signatureAfter.fieldMeta as { condition?: unknown } | null)?.condition ?? null).toBeNull();
  });
});

describe('real sign-route controller guard vs completion (real Postgres, real tRPC caller)', () => {
  it('ordering: completed dependent THEN controller change — the real sign route rejects it', async () => {
    const { envelope, buyer, coBuyer, checkboxField } = await seedCoBuyerScenario();

    await completeDocumentWithToken({
      token: coBuyer.token,
      id: { type: 'envelopeId', id: envelope.id },
      ...REQUEST_METADATA,
    });

    await expect(checkBuyerBoxThroughRealRoute(buyer.token, checkboxField.id)).rejects.toThrow(
      /already completed signing/i,
    );

    const finalCheckbox = await prisma.field.findUniqueOrThrow({ where: { id: checkboxField.id } });
    expect(finalCheckbox.inserted).toBe(false);
  });

  it('ordering: controller change THEN completed dependent — completion now correctly requires it', async () => {
    const { envelope, buyer, coBuyer, checkboxField } = await seedCoBuyerScenario();

    await expect(checkBuyerBoxThroughRealRoute(buyer.token, checkboxField.id)).resolves.toBeDefined();

    const checkedField = await prisma.field.findUniqueOrThrow({ where: { id: checkboxField.id } });
    expect(checkedField.inserted).toBe(true);

    await expect(
      completeDocumentWithToken({
        token: coBuyer.token,
        id: { type: 'envelopeId', id: envelope.id },
        ...REQUEST_METADATA,
      }),
    ).rejects.toThrow(/unsigned fields/i);

    const finalRecipient = await prisma.recipient.findUniqueOrThrow({ where: { id: coBuyer.id } });
    expect(finalRecipient.signingStatus).toBe(SigningStatus.NOT_SIGNED);
  });

  it('overlap: the real sign route racing a real completion never lets both win, and never leaves an inconsistent state', async () => {
    const { envelope, buyer, coBuyer, checkboxField } = await seedCoBuyerScenario();

    // Fired via Promise.all (not sequential awaits) so both promises begin
    // running — and both `prisma.$transaction` calls issue their
    // `FOR UPDATE` lock request — before either is awaited, giving genuine
    // overlap at the Postgres level rather than an artificially ordered test.
    const [checkResult, completeResult] = await Promise.allSettled([
      checkBuyerBoxThroughRealRoute(buyer.token, checkboxField.id),
      completeDocumentWithToken({
        token: coBuyer.token,
        id: { type: 'envelopeId', id: envelope.id },
        ...REQUEST_METADATA,
      }),
    ]);

    const checkSucceeded = checkResult.status === 'fulfilled';
    const completeSucceeded = completeResult.status === 'fulfilled';

    // The lock must admit exactly one side: whichever transaction commits
    // first is fully visible to the other by the time it re-reads under the
    // lock, so the loser's own guard must reject it — never both succeed, and
    // the lock must never starve both.
    expect(checkSucceeded).toBe(!completeSucceeded);

    const finalRecipient = await prisma.recipient.findUniqueOrThrow({ where: { id: coBuyer.id } });
    const finalCheckbox = await prisma.field.findUniqueOrThrow({ where: { id: checkboxField.id } });

    // The hard invariant this whole feature exists to enforce: it is NEVER
    // acceptable for the box to end up checked while CoBuyer ended up SIGNED
    // with their required dependent field still unsigned.
    if (finalCheckbox.inserted && finalRecipient.signingStatus === SigningStatus.SIGNED) {
      const signatureField = await prisma.field.findFirstOrThrow({
        where: { envelopeId: envelope.id, recipientId: coBuyer.id, type: FieldType.SIGNATURE },
      });

      expect(signatureField.inserted).toBe(true);
    }
  });
});
