/**
 * Real-Postgres integration test for `duplicateEnvelope`'s conditional-visibility
 * field-reference remap. Field-to-field condition references (`fieldMeta.condition.fieldId`)
 * were, before this feature, never remapped anywhere in the codebase on
 * duplication (only `envelopeItemId` had a remap pattern) — a naive `createMany`
 * copy would leave every dependent field's condition pointing at the OLD
 * envelope's controller id, which doesn't exist in the new envelope, silently
 * breaking visibility (or, worse, coincidentally colliding with an unrelated
 * field id in the new envelope). `duplicate-envelope.ts` now creates fields
 * individually (not via `createMany`) to recover each new field's real id and
 * calls the shared `remapFieldConditionReferences` helper. This suite proves
 * that against a real database and the real function, for both the "duplicate
 * document" and "duplicate as template" paths (`overrides.duplicateAsTemplate`).
 *
 * Mock boundary (explicit): `triggerWebhook` (external HTTP egress) is mocked —
 * unrelated to the remap logic under test. Everything else — the database,
 * envelope/recipient/field duplication, and condition-reference remapping — is
 * fully real and unmocked.
 *
 * Opt-in only, via RUN_DB_INTEGRATION_TESTS=true — see
 * conditional-visibility-consent.integration.test.ts's doc comment for the
 * full rationale (mirrored here, not restated).
 *
 *   RUN_DB_INTEGRATION_TESTS=true npx dotenv -e ../../.env -- \
 *     npx vitest run --config vitest.db-integration.config.ts
 */
import { prisma } from '@documenso/prisma';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedTeam } from '@documenso/prisma/seed/teams';
import { DocumentStatus, EnvelopeType, FieldType } from '@prisma/client';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { duplicateEnvelope } from './duplicate-envelope';

const RUN_INTEGRATION = process.env.RUN_DB_INTEGRATION_TESTS === 'true';

vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));

let ownerId: number;
let teamId: number;

describe.skipIf(!RUN_INTEGRATION)('duplicateEnvelope — conditional visibility remap (real Postgres)', () => {
  beforeAll(async () => {
    const { owner, team } = await seedTeam();

    ownerId = owner.id;
    teamId = team.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * Seeds a PENDING V2 envelope with a single recipient owning a checkbox
   * controller and a dependent SIGNATURE field conditioned on it.
   */
  const seedConditionalEnvelope = async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });

    const document = await seedBlankDocument(owner, teamId, { internalVersion: 2 });

    const envelope = await prisma.envelope.update({
      where: { id: document.id },
      data: { status: DocumentStatus.PENDING },
    });

    const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: envelope.id } });

    const recipient = await prisma.recipient.create({
      data: {
        envelopeId: envelope.id,
        email: `signer-${nanoid()}@test.documenso.com`,
        name: 'Signer',
        role: 'SIGNER',
        token: nanoid(),
        sendStatus: 'SENT',
        signingStatus: 'NOT_SIGNED',
      },
    });

    const checkboxField = await prisma.field.create({
      data: {
        envelopeId: envelope.id,
        envelopeItemId: envelopeItem.id,
        recipientId: recipient.id,
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
          values: [{ id: 501, checked: false, value: 'Enable dependent field' }],
        },
      },
    });

    const dependentField = await prisma.field.create({
      data: {
        envelopeId: envelope.id,
        envelopeItemId: envelopeItem.id,
        recipientId: recipient.id,
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
          condition: { fieldId: checkboxField.id, optionIds: [501] },
        },
      },
    });

    return { envelope, checkboxField, dependentField };
  };

  it('remaps the dependent field condition to the NEW duplicated field ids when duplicating a document', async () => {
    const { envelope, checkboxField, dependentField } = await seedConditionalEnvelope();

    const { id: duplicatedEnvelopeId } = await duplicateEnvelope({
      id: { type: 'envelopeId', id: envelope.id },
      userId: ownerId,
      teamId,
    });

    expect(duplicatedEnvelopeId).not.toBe(envelope.id);

    const duplicatedFields = await prisma.field.findMany({ where: { envelopeId: duplicatedEnvelopeId } });

    expect(duplicatedFields).toHaveLength(2);

    const duplicatedCheckbox = duplicatedFields.find((f) => f.type === FieldType.CHECKBOX);
    const duplicatedDependent = duplicatedFields.find((f) => f.type === FieldType.SIGNATURE);

    expect(duplicatedCheckbox).toBeDefined();
    expect(duplicatedDependent).toBeDefined();

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const condition = (
      duplicatedDependent?.fieldMeta as { condition?: { fieldId: number; optionIds: number[] } } | null
    )?.condition;

    expect(condition?.optionIds).toEqual([501]);
    expect(condition?.fieldId).toBe(duplicatedCheckbox?.id);
    // Proves the reference was actually REMAPPED to the new envelope's field,
    // not left dangling at the OLD envelope's controller id (which doesn't
    // exist in the duplicated envelope's field set).
    expect(condition?.fieldId).not.toBe(checkboxField.id);
    expect(duplicatedDependent?.id).not.toBe(dependentField.id);

    // The remapped reference must actually resolve within the NEW envelope
    // (this is what `resolveFieldConditionState` depends on at read time).
    expect(duplicatedFields.some((f) => f.id === condition?.fieldId)).toBe(true);
  });

  it('remaps the dependent field condition to the NEW field ids when duplicating as a template', async () => {
    const { envelope, checkboxField, dependentField } = await seedConditionalEnvelope();

    const { id: duplicatedTemplateId, envelope: duplicatedTemplate } = await duplicateEnvelope({
      id: { type: 'envelopeId', id: envelope.id },
      userId: ownerId,
      teamId,
      overrides: { duplicateAsTemplate: true },
    });

    expect(duplicatedTemplate.type).toBe(EnvelopeType.TEMPLATE);

    const duplicatedFields = await prisma.field.findMany({ where: { envelopeId: duplicatedTemplateId } });

    const duplicatedCheckbox = duplicatedFields.find((f) => f.type === FieldType.CHECKBOX);
    const duplicatedDependent = duplicatedFields.find((f) => f.type === FieldType.SIGNATURE);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const condition = (
      duplicatedDependent?.fieldMeta as { condition?: { fieldId: number; optionIds: number[] } } | null
    )?.condition;

    expect(condition?.fieldId).toBe(duplicatedCheckbox?.id);
    expect(condition?.fieldId).not.toBe(checkboxField.id);
    expect(duplicatedDependent?.id).not.toBe(dependentField.id);
  });
});
