/**
 * Real-Postgres integration test for `createDocumentFromDirectTemplate`'s
 * conditional-visibility handling. This function is the ONE write path that
 * cannot reuse the envelope-row-lock pattern the other server-only paths use
 * (there is no pre-existing envelope row to lock — the whole envelope is
 * created and the direct recipient marked SIGNED in the same transaction),
 * and it previously had its own hand-rolled, DIVERGENT visibility predicate
 * (`isDirectTemplateFieldConditionMet`) that used the wrong (V1-string)
 * checkbox value encoding and never matched V2's actual numeric-INDEX
 * encoding. It now projects the submission onto the SAME shared
 * `isFieldVisible`/`resolveFieldConditionState` graph resolution every other
 * write path uses (`projectDirectRecipientFields`). This suite proves that
 * end-to-end against a real submission, not a re-implementation of the
 * predicate under test.
 *
 * Specifically exercises (real DB, real handler, not reimplemented):
 * - the native V2 checkbox payload encoding: `customText`/submitted `value`
 *   is a JSON array of selected option INDICES, not option ids and not a
 *   V1-style value-string array. Both controllers in the seeded chain use
 *   option ids that deliberately diverge from their array index, so a
 *   handler that confused index with id would fail to reveal the chain.
 * - a two-hop transitive condition chain (signature depends on checkbox B,
 *   which itself depends on checkbox A) — `resolveFieldConditionState`'s
 *   transitive walk, not just a single-hop check.
 * - a required signature field that's hidden by an unmet (possibly
 *   multi-hop) condition: an omitted value must NOT block creation.
 * - the same field once its full condition chain is met: an omitted value
 *   MUST block creation.
 * - the post-remap authoritative guard (`assertValidFieldConditionGraph` +
 *   `fieldsContainUnsignedRequiredVisibleField`, run after
 *   `remapFieldConditionReferences`): a successful creation proves the
 *   condition reference was correctly rewritten from the TEMPLATE field's id
 *   to the newly-created envelope field's id (a broken remap would leave a
 *   dangling reference to an id that doesn't exist in the new envelope, and
 *   the guard would throw) — asserted explicitly by comparing the persisted
 *   `condition.fieldId` against both the old (template) and new (envelope)
 *   controller ids.
 *
 * Mock boundary (explicit): `sendDocument` (PDF-sealing/email-send pipeline —
 * a large, unrelated side effect covered by its own tests) and
 * `triggerWebhook` (external HTTP egress) are mocked; `jobs.triggerJob` is
 * mocked for the same cross-worktree-network reason as the sibling
 * conditional-visibility-consent suite. Everything else — the database, the
 * envelope/recipient/field creation, condition-graph remapping, and
 * visibility resolution — is fully real and unmocked.
 *
 * Opt-in only, via RUN_DB_INTEGRATION_TESTS=true — see
 * conditional-visibility-consent.integration.test.ts's doc comment for the
 * full rationale (mirrored here, not restated).
 *
 *   RUN_DB_INTEGRATION_TESTS=true npx dotenv -e ../../.env -- \
 *     npx vitest run --config vitest.db-integration.config.ts
 */
import { prisma } from '@documenso/prisma';
import { seedTeam } from '@documenso/prisma/seed/teams';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { FieldType } from '@prisma/client';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDocumentFromDirectTemplate } from './create-document-from-direct-template';

const RUN_INTEGRATION = process.env.RUN_DB_INTEGRATION_TESTS === 'true';

vi.mock('../document/send-document', () => ({ sendDocument: vi.fn() }));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));
vi.mock('@documenso/lib/jobs/client', () => ({ jobs: { triggerJob: vi.fn() } }));

const REQUEST_METADATA = {
  requestMetadata: {},
  source: 'app' as const,
  auth: 'session' as const,
};

let ownerId: number;
let teamId: number;

describe.skipIf(!RUN_INTEGRATION)('createDocumentFromDirectTemplate — conditional visibility (real Postgres)', () => {
  beforeAll(async () => {
    const { owner, team } = await seedTeam();

    ownerId = owner.id;
    teamId = team.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * Builds a V2 direct-link template owned by the direct-template recipient
   * with a two-hop conditional chain:
   *
   *   checkboxA (unconditional, options: id 101 "No" / id 102 "Enable B")
   *     -> checkboxB (condition: A's option 102, options: id 201 "No" / id 202 "Enable C")
   *       -> signatureC (required, condition: B's option 202)
   *
   * Both controllers' option ARRAY INDEX (0/1) deliberately diverges from
   * the option's stable id (101/102, 201/202) so a handler confusing "index"
   * with "id" cannot accidentally pass.
   */
  const seedConditionalDirectTemplate = async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });

    const template = await seedDirectTemplate({ userId: owner.id, teamId, internalVersion: 2 });

    const directRecipient = template.recipients.find(
      (recipient) => recipient.id === template.directLink?.directTemplateRecipientId,
    );

    if (!directRecipient || !template.directLink) {
      throw new Error('Direct template recipient/link not found');
    }

    const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: template.id } });

    const checkboxA = await prisma.field.create({
      data: {
        envelopeId: template.id,
        envelopeItemId: envelopeItem.id,
        recipientId: directRecipient.id,
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
          values: [
            { id: 101, checked: false, value: 'No' },
            { id: 102, checked: false, value: 'Enable B' },
          ],
        },
      },
    });

    const checkboxB = await prisma.field.create({
      data: {
        envelopeId: template.id,
        envelopeItemId: envelopeItem.id,
        recipientId: directRecipient.id,
        type: FieldType.CHECKBOX,
        page: 1,
        positionX: 10,
        positionY: 0,
        width: 5,
        height: 5,
        customText: '',
        inserted: false,
        fieldMeta: {
          type: 'checkbox',
          direction: 'vertical',
          values: [
            { id: 201, checked: false, value: 'No' },
            { id: 202, checked: false, value: 'Enable C' },
          ],
          condition: { fieldId: checkboxA.id, optionIds: [102] },
        },
      },
    });

    const signatureC = await prisma.field.create({
      data: {
        envelopeId: template.id,
        envelopeItemId: envelopeItem.id,
        recipientId: directRecipient.id,
        type: FieldType.SIGNATURE,
        page: 1,
        positionX: 20,
        positionY: 0,
        width: 5,
        height: 5,
        customText: '',
        inserted: false,
        fieldMeta: {
          type: 'signature',
          overflow: 'auto',
          required: true,
          condition: { fieldId: checkboxB.id, optionIds: [202] },
        },
      },
    });

    const freshTemplate = await prisma.envelope.findUniqueOrThrow({ where: { id: template.id } });

    return {
      freshTemplate,
      directLinkToken: template.directLink.token,
      checkboxA,
      checkboxB,
      signatureC,
    };
  };

  it('accepts an omitted signature when the leaf field is transitively hidden two hops up, with the native numeric-index checkbox payload left unchecked', async () => {
    const { freshTemplate, directLinkToken, checkboxA, checkboxB, signatureC } = await seedConditionalDirectTemplate();

    const result = await createDocumentFromDirectTemplate({
      directRecipientEmail: `direct-${nanoid()}@test.documenso.com`,
      directTemplateToken: directLinkToken,
      templateUpdatedAt: freshTemplate.updatedAt,
      requestMetadata: REQUEST_METADATA,
      signedFieldValues: [
        { token: directLinkToken, fieldId: checkboxA.id, value: JSON.stringify([]) },
        { token: directLinkToken, fieldId: checkboxB.id, value: JSON.stringify([]) },
        { token: directLinkToken, fieldId: signatureC.id, value: undefined },
      ],
    });

    const persistedSignature = await prisma.field.findFirstOrThrow({
      where: { envelopeId: result.envelopeId, type: FieldType.SIGNATURE },
      include: { signature: true },
    });

    expect(persistedSignature.inserted).toBe(false);
    expect(persistedSignature.signature).toBeNull();
  });

  it('rejects an omitted signature once the full two-hop checkbox chain reveals it, using native numeric-index payloads that diverge from option ids', async () => {
    const { freshTemplate, directLinkToken, checkboxA, checkboxB, signatureC } = await seedConditionalDirectTemplate();

    await expect(
      createDocumentFromDirectTemplate({
        directRecipientEmail: `direct-${nanoid()}@test.documenso.com`,
        directTemplateToken: directLinkToken,
        templateUpdatedAt: freshTemplate.updatedAt,
        requestMetadata: REQUEST_METADATA,
        signedFieldValues: [
          // Index 1 (native V2 encoding) selects the option with STABLE id
          // 102 ("Enable B") on checkboxA, and id 202 ("Enable C") on
          // checkboxB — NOT option id 1, which doesn't exist on either
          // controller. A handler that confused index with id would fail to
          // reveal the chain and wrongly accept the omitted signature.
          { token: directLinkToken, fieldId: checkboxA.id, value: JSON.stringify([1]) },
          { token: directLinkToken, fieldId: checkboxB.id, value: JSON.stringify([1]) },
          { token: directLinkToken, fieldId: signatureC.id, value: undefined },
        ],
      }),
    ).rejects.toThrow(/signature/i);
  });

  it('accepts and reveals the full two-hop chain end-to-end, persisting native numeric-index payloads and remapping condition references to the NEW envelope field ids', async () => {
    const { freshTemplate, directLinkToken, checkboxA, checkboxB, signatureC } = await seedConditionalDirectTemplate();

    const result = await createDocumentFromDirectTemplate({
      directRecipientEmail: `direct-${nanoid()}@test.documenso.com`,
      directTemplateToken: directLinkToken,
      templateUpdatedAt: freshTemplate.updatedAt,
      requestMetadata: REQUEST_METADATA,
      signedFieldValues: [
        { token: directLinkToken, fieldId: checkboxA.id, value: JSON.stringify([1]) },
        { token: directLinkToken, fieldId: checkboxB.id, value: JSON.stringify([1]) },
        { token: directLinkToken, fieldId: signatureC.id, value: 'Direct Signer', isBase64: false },
      ],
    });

    const persistedFields = await prisma.field.findMany({
      where: { envelopeId: result.envelopeId },
      include: { signature: true },
    });

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const readValuesIds = (field: (typeof persistedFields)[number]) =>
      (field.fieldMeta as { values?: { id: number }[] } | null)?.values?.map((v) => v.id) ?? [];

    const persistedCheckboxA = persistedFields.find(
      (f) => f.type === FieldType.CHECKBOX && readValuesIds(f).includes(101),
    );
    const persistedCheckboxB = persistedFields.find(
      (f) => f.type === FieldType.CHECKBOX && readValuesIds(f).includes(201),
    );
    const persistedSignature = persistedFields.find((f) => f.type === FieldType.SIGNATURE);

    expect(persistedCheckboxA?.inserted).toBe(true);
    expect(persistedCheckboxA?.customText).toBe(JSON.stringify([1]));

    expect(persistedCheckboxB?.inserted).toBe(true);
    expect(persistedCheckboxB?.customText).toBe(JSON.stringify([1]));

    expect(persistedSignature?.inserted).toBe(true);
    expect(persistedSignature?.signature?.typedSignature).toBe('Direct Signer');

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const signatureCondition = (
      persistedSignature?.fieldMeta as { condition?: { fieldId: number; optionIds: number[] } } | null
    )?.condition;

    expect(signatureCondition?.optionIds).toEqual([202]);
    expect(signatureCondition?.fieldId).toBe(persistedCheckboxB?.id);
    // Proves the reference was actually REMAPPED, not left dangling at the
    // OLD template field's id (which wouldn't exist in the new envelope —
    // `assertValidFieldConditionGraph` would have thrown and this whole
    // creation would have rejected instead of reaching this assertion).
    expect(signatureCondition?.fieldId).not.toBe(checkboxB.id);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const checkboxBCondition = (
      persistedCheckboxB?.fieldMeta as { condition?: { fieldId: number; optionIds: number[] } } | null
    )?.condition;

    expect(checkboxBCondition?.optionIds).toEqual([102]);
    expect(checkboxBCondition?.fieldId).toBe(persistedCheckboxA?.id);
    expect(checkboxBCondition?.fieldId).not.toBe(checkboxA.id);
  });
});
