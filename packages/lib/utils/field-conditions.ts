import type { Field, Prisma } from '@prisma/client';
import { FieldType } from '@prisma/client';

import { AppError, AppErrorCode } from '../errors/app-error';
import { type TFieldCondition, ZCheckboxFieldMeta, ZFieldCondition } from '../types/field-meta';
import { isFieldUnsignedAndRequired } from './advanced-fields-helpers';
import { parseCheckboxCustomText } from './fields';

/**
 * The minimum shape of a field needed to resolve conditional visibility.
 */
export type FieldForConditionEvaluation = Pick<Field, 'id' | 'type' | 'fieldMeta' | 'customText'>;

type FieldConditionExtraction =
  | { present: false }
  | { present: true; valid: false }
  | { present: true; valid: true; condition: TFieldCondition };

/**
 * Inspects a raw `fieldMeta` JSON value for a `condition` property, distinguishing
 * three cases that MUST be handled differently:
 *
 * - absent (`present: false`): no condition was ever set — the field is
 *   unconditionally visible.
 * - present but malformed (`present: true, valid: false`): the `condition` key
 *   exists but its value doesn't match `ZFieldCondition` (e.g. a non-numeric
 *   `fieldId`, a missing `optionIds`). This can only happen to data that bypassed
 *   normal write-time validation (a V1 envelope, a historical row, a bug) — it
 *   must NEVER be treated the same as "absent" (which would silently make the
 *   field unconditionally visible) or silently folded into "hidden" by callers
 *   that need to tell "legitimately unmet" apart from "corrupted".
 * - present and valid (`present: true, valid: true`): normal case.
 */
export const extractFieldCondition = (fieldMeta: unknown): FieldConditionExtraction => {
  if (typeof fieldMeta !== 'object' || fieldMeta === null || !('condition' in fieldMeta)) {
    return { present: false };
  }

  const rawCondition = (fieldMeta as Record<string, unknown>).condition;

  if (rawCondition === null || rawCondition === undefined) {
    return { present: false };
  }

  const parsed = ZFieldCondition.safeParse(rawCondition);

  if (!parsed.success) {
    return { present: true, valid: false };
  }

  return { present: true, valid: true, condition: parsed.data };
};

/**
 * Convenience wrapper over `extractFieldCondition` for callers where a malformed
 * condition can safely be treated the same as "no condition" — i.e. anywhere the
 * caller is choosing whether to bother validating/acting on a condition at all,
 * not deciding whether it's safe to finalize a document. Prefer
 * `extractFieldCondition` directly wherever that distinction matters.
 */
export const getFieldCondition = (fieldMeta: unknown): TFieldCondition | null => {
  const extraction = extractFieldCondition(fieldMeta);

  return extraction.present && extraction.valid ? extraction.condition : null;
};

const getCheckboxSelectedOptionIds = (field: FieldForConditionEvaluation): number[] => {
  if (field.type !== FieldType.CHECKBOX) {
    return [];
  }

  const meta = ZCheckboxFieldMeta.safeParse(field.fieldMeta);

  if (!meta.success) {
    return [];
  }

  const values = meta.data.values ?? [];
  const customText = typeof field.customText === 'string' ? field.customText : '';
  const selectedIndices = customText ? parseCheckboxCustomText(customText) : [];

  return selectedIndices.map((index) => values[index]?.id).filter((id): id is number => id !== undefined);
};

export type FieldConditionState = { status: 'visible' } | { status: 'hidden' } | { status: 'invalid'; reason: string };

/**
 * Resolves whether `field` is currently visible, walking the condition chain
 * transitively (a field whose controller is itself hidden or invalid can never be
 * revealed, even if the controller's own checkbox happens to be checked) and
 * detecting cycles.
 *
 * Distinguishes a normal, valid-but-unmet predicate ('hidden') from a structurally
 * broken condition ('invalid': malformed, dangling reference, wrong field type, a
 * referenced option that no longer exists, or a cycle). Callers deciding whether
 * it is SAFE to finalize/seal a document must treat 'invalid' as a hard failure,
 * not as 'hidden' — see `assertValidFieldConditionGraph`. A lenient boolean read
 * (rendering, sign-attempt gating) can safely fold 'invalid' into "not visible" —
 * see `isFieldVisible` — since nothing is being finalized there.
 */
export const resolveFieldConditionState = (
  field: FieldForConditionEvaluation,
  allEnvelopeFields: FieldForConditionEvaluation[],
): FieldConditionState => resolveFieldConditionStateInternal(field, allEnvelopeFields, new Set());

const resolveFieldConditionStateInternal = (
  field: FieldForConditionEvaluation,
  allEnvelopeFields: FieldForConditionEvaluation[],
  visited: Set<number>,
): FieldConditionState => {
  const extraction = extractFieldCondition(field.fieldMeta);

  if (!extraction.present) {
    return { status: 'visible' };
  }

  if (!extraction.valid) {
    return { status: 'invalid', reason: `Field ${field.id} has a malformed conditional visibility configuration` };
  }

  const condition = extraction.condition;

  if (visited.has(field.id)) {
    return { status: 'invalid', reason: 'Conditional visibility graph contains a cycle' };
  }

  visited.add(field.id);

  const controllingField = allEnvelopeFields.find((candidate) => candidate.id === condition.fieldId);

  if (!controllingField) {
    return { status: 'invalid', reason: `Controlling field ${condition.fieldId} does not exist in this envelope` };
  }

  if (controllingField.type !== FieldType.CHECKBOX) {
    return { status: 'invalid', reason: `Controlling field ${condition.fieldId} is not a checkbox` };
  }

  // Transitive: the controller must itself be currently visible for its checked
  // state to be able to reveal anything downstream.
  const controllerState = resolveFieldConditionStateInternal(controllingField, allEnvelopeFields, visited);

  if (controllerState.status !== 'visible') {
    return controllerState.status === 'invalid' ? controllerState : { status: 'hidden' };
  }

  const meta = ZCheckboxFieldMeta.safeParse(controllingField.fieldMeta);
  const availableOptionIds = meta.success ? (meta.data.values ?? []).map((value) => value.id) : [];
  const missingOptionIds = condition.optionIds.filter((optionId) => !availableOptionIds.includes(optionId));

  if (missingOptionIds.length > 0) {
    return {
      status: 'invalid',
      reason: `Option(s) ${missingOptionIds.join(', ')} referenced by a condition no longer exist on controlling field ${condition.fieldId}`,
    };
  }

  const selectedOptionIds = getCheckboxSelectedOptionIds(controllingField);
  const met = condition.optionIds.some((optionId) => selectedOptionIds.includes(optionId));

  return { status: met ? 'visible' : 'hidden' };
};

/**
 * Lenient boolean visibility check for rendering and sign-attempt gating, where
 * failing closed (treating an invalid/malformed config the same as "hidden") is a
 * safe fallback: nothing is being finalized, and refusing to reveal/accept a value
 * for a field whose visibility can't be verified is the conservative, correct
 * call. Never treats a malformed condition as "unconditional" (always visible).
 *
 * There is deliberately no "frozen at completion" snapshot here: visibility is
 * always resolved live. Correctness for an already-completed recipient instead
 * comes from `findCompletedDependentsAffectedByControllerChange` REJECTING any
 * controller mutation that would change what this function returns for one of
 * their fields — so by the time this runs, live resolution is guaranteed to
 * still agree with whatever was true when that recipient completed.
 */
export const isFieldVisible = (
  field: FieldForConditionEvaluation,
  allEnvelopeFields: FieldForConditionEvaluation[],
): boolean => resolveFieldConditionState(field, allEnvelopeFields).status === 'visible';

export const filterVisibleFields = <T extends FieldForConditionEvaluation>(
  fields: T[],
  allEnvelopeFields: FieldForConditionEvaluation[],
): T[] => fields.filter((field) => isFieldVisible(field, allEnvelopeFields));

/**
 * Like `fieldsContainUnsignedRequiredField`, but a required field that is
 * currently hidden by a valid, unmet condition does not count as blocking.
 *
 * Callers MUST call `assertValidFieldConditionGraph` first (or otherwise be certain
 * the graph is valid) — this function alone cannot distinguish "legitimately
 * hidden" from "corrupted config", and treats both the same (non-blocking), which
 * is only safe once structural validity has already been asserted.
 */
export const fieldsContainUnsignedRequiredVisibleField = (
  fields: Field[],
  allEnvelopeFields: FieldForConditionEvaluation[],
): boolean => fields.some((field) => isFieldUnsignedAndRequired(field) && isFieldVisible(field, allEnvelopeFields));

/**
 * Hard gate for completion/seal time: throws if ANY field in `fields` has a
 * structurally invalid condition (malformed/dangling/wrong-type/missing-option/
 * cycle). Completion and sealing must never silently treat a corrupted graph as
 * "hidden, hence exempt" — that would let a broken configuration masquerade as
 * success.
 */
export const assertValidFieldConditionGraph = (
  fields: FieldForConditionEvaluation[],
  allEnvelopeFields: FieldForConditionEvaluation[],
): void => {
  for (const field of fields) {
    if (!extractFieldCondition(field.fieldMeta).present) {
      continue;
    }

    const state = resolveFieldConditionState(field, allEnvelopeFields);

    if (state.status === 'invalid') {
      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message: `Field ${field.id} has an invalid conditional visibility configuration and cannot be completed: ${state.reason}`,
      });
    }
  }
};

export type FieldWithRecipient = FieldForConditionEvaluation & { recipientId: number | null };

/**
 * Given a checkbox controller about to change from its current stored state to
 * `proposedCustomText`, finds every field belonging to an ALREADY-SIGNED
 * recipient (per `signedRecipientIds`) whose resolved visibility would differ
 * between the current and proposed state — transitively, so a change several
 * links up an already-hidden chain that wouldn't itself reveal anything is
 * correctly ignored.
 *
 * A non-empty result means the mutation MUST be rejected outright: applying it
 * would either newly require a field an already-completed recipient was never
 * asked to fill in (hidden -> visible), or silently drop a field — and any value
 * or signature it holds — that recipient already completed with (visible ->
 * hidden). Freezing a snapshot at completion time and leaving the mutation to
 * proceed is NOT an adequate substitute: it lets the checkbox's final state and
 * the document's actual signed content permanently disagree.
 */
export const findCompletedDependentsAffectedByControllerChange = ({
  controllerFieldId,
  proposedCustomText,
  allEnvelopeFields,
  signedRecipientIds,
}: {
  controllerFieldId: number;
  proposedCustomText: string;
  allEnvelopeFields: FieldWithRecipient[];
  signedRecipientIds: ReadonlySet<number>;
}): FieldWithRecipient[] => {
  const proposedFields = allEnvelopeFields.map((field) =>
    field.id === controllerFieldId ? { ...field, customText: proposedCustomText } : field,
  );

  return allEnvelopeFields.filter((field) => {
    if (field.recipientId === null || !signedRecipientIds.has(field.recipientId)) {
      return false;
    }

    if (!extractFieldCondition(field.fieldMeta).present) {
      return false;
    }

    const before = resolveFieldConditionState(field, allEnvelopeFields).status;

    const proposedField = proposedFields.find((candidate) => candidate.id === field.id);

    if (!proposedField) {
      return false;
    }

    const after = resolveFieldConditionState(proposedField, proposedFields).status;

    return before !== after;
  });
};

export type FieldConditionRefCandidate = Pick<Field, 'id' | 'type' | 'fieldMeta'>;

/**
 * Validates a proposed `condition` before it is persisted onto `targetFieldId`.
 *
 * `targetFieldId` is `null` when the field gaining the condition does not have a
 * database id yet (e.g. it is being created in the same batch). Self-reference and
 * cycle checks are skipped in that case since a not-yet-persisted field cannot
 * already be part of any condition chain.
 */
export const validateFieldConditionRef = ({
  targetFieldId,
  condition,
  envelopeFields,
}: {
  targetFieldId: number | null;
  condition: TFieldCondition;
  envelopeFields: FieldConditionRefCandidate[];
}): void => {
  if (targetFieldId !== null && condition.fieldId === targetFieldId) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'A field cannot have a conditional visibility that depends on itself',
    });
  }

  const controllingField = envelopeFields.find((field) => field.id === condition.fieldId);

  if (!controllingField) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Conditional visibility references field ${condition.fieldId}, which does not exist in this envelope`,
    });
  }

  if (controllingField.type !== FieldType.CHECKBOX) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Conditional visibility can only depend on a checkbox field',
    });
  }

  const meta = ZCheckboxFieldMeta.safeParse(controllingField.fieldMeta);
  const availableOptionIds = meta.success ? (meta.data.values ?? []).map((value) => value.id) : [];

  const invalidOptionIds = condition.optionIds.filter((optionId) => !availableOptionIds.includes(optionId));

  if (invalidOptionIds.length > 0) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Conditional visibility references option(s) that do not exist on the controlling checkbox: ${invalidOptionIds.join(', ')}`,
    });
  }

  if (targetFieldId === null) {
    return;
  }

  // Cycle detection: walk the condition graph starting at the controller. If it
  // ever reaches back to the target field, this edge would create a cycle.
  const visited = new Set<number>();
  let current: FieldConditionRefCandidate | undefined = controllingField;

  while (current) {
    if (current.id === targetFieldId) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Conditional visibility cannot form a cycle',
      });
    }

    if (visited.has(current.id)) {
      break;
    }

    visited.add(current.id);

    const nextCondition = getFieldCondition(current.fieldMeta);

    current = nextCondition ? envelopeFields.find((field) => field.id === nextCondition.fieldId) : undefined;
  }
};

/**
 * Finds fields among `candidateFields` whose condition is malformed or
 * structurally invalid given `allEnvelopeFieldsAfterChange` (the field set as it
 * will exist AFTER a pending deletion/replacement/option-removal is applied).
 * Used to cascade-clear dependents so a write never *leaves behind* a
 * dangling/broken condition, whether the change is a single field delete, a bulk
 * replace, a recipient delete (which cascades to all of their fields), or a
 * controlling checkbox losing an option — and opportunistically self-heals any
 * pre-existing malformed condition it encounters along the way.
 */
export const findFieldsWithDanglingConditions = <T extends FieldForConditionEvaluation>(
  candidateFields: T[],
  allEnvelopeFieldsAfterChange: FieldForConditionEvaluation[],
): T[] =>
  candidateFields.filter((field) => {
    if (!extractFieldCondition(field.fieldMeta).present) {
      return false;
    }

    return resolveFieldConditionState(field, allEnvelopeFieldsAfterChange).status === 'invalid';
  });

/**
 * Splits a set of fields that WOULD have their condition cascade-cleared (per
 * `findFieldsWithDanglingConditions`) into those it's safe to silently clear
 * (their owning recipient hasn't completed yet — a graceful UX nicety) and those
 * that must instead cause the whole authoring mutation to be REJECTED: a field
 * belonging to an already-signed recipient was frozen into "hidden, hence exempt"
 * (or "visible, hence signed") at their completion time, and silently rewriting
 * its condition now would either strand a required-but-now-unsatisfiable field
 * forever (the recipient can never come back), or misrepresent what they actually
 * consented to. There is no safe automatic resolution for that case — the
 * authoring change itself (deleting/retyping a controller, removing an option,
 * deleting a recipient, replacing a field set) must be rejected outright.
 */
export const partitionDanglingDependentsBySignedRecipient = <T extends FieldWithRecipient>(
  danglingDependents: T[],
  signedRecipientIds: ReadonlySet<number>,
): { safeToClear: T[]; mustReject: T[] } => {
  const mustReject: T[] = [];
  const safeToClear: T[] = [];

  for (const field of danglingDependents) {
    if (field.recipientId !== null && signedRecipientIds.has(field.recipientId)) {
      mustReject.push(field);
    } else {
      safeToClear.push(field);
    }
  }

  return { safeToClear, mustReject };
};

/**
 * For a full-replace bulk field write (the v2 native editor's autosave semantics:
 * every currently-existing field must be resent in `incomingFields` or it is
 * deleted), resolves each field's `condition`:
 *
 * - A condition being newly set or changed this save is validated strictly and
 *   throws (via `validateFieldConditionRef`) if invalid, or if `internalVersion`
 *   isn't 2 (conditional visibility is V2-only) — the user is actively creating a
 *   bad reference and should see an error.
 * - A condition unchanged from what's already persisted (including a pre-existing
 *   malformed one), but left invalid purely because some OTHER field in the same
 *   batch was removed or retyped (or was already malformed before this save):
 *   silently dropped rather than blocking the whole autosave (matches the
 *   graceful cascade-clear behavior of deleting a field through the dedicated
 *   delete route) UNLESS the field belongs to an already-signed recipient, in
 *   which case silently clearing it would alter their frozen obligations/consent
 *   — the whole batch is rejected instead.
 *
 * Returns `incomingFields` with any collaterally-invalid conditions cleared.
 */
export const resolveBulkFieldConditions = <
  T extends { id?: number | null; type: FieldType; fieldMeta?: unknown; recipientId: number },
>(
  incomingFields: T[],
  existingFields: FieldWithRecipient[],
  { internalVersion, signedRecipientIds }: { internalVersion: number; signedRecipientIds: ReadonlySet<number> },
): T[] => {
  // Full-replace semantics: an existing field absent from `incomingFields` is
  // about to be DELETED, not left unchanged — it must drop out of the reference
  // graph so anything still pointing at it resolves as dangling below.
  const existingFieldsAfterUpdate: FieldWithRecipient[] = existingFields
    .filter((existingField) => incomingFields.some((field) => field.id === existingField.id))
    .map((existingField) => {
      const update = incomingFields.find((field) => field.id === existingField.id);

      if (!update) {
        return existingField;
      }

      return {
        ...existingField,
        type: update.type ?? existingField.type,
        fieldMeta: update.fieldMeta !== undefined ? update.fieldMeta : existingField.fieldMeta,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      } as FieldWithRecipient;
    });

  return incomingFields.map((field) => {
    const existing = existingFields.find((candidate) => candidate.id === field.id);
    const existingExtraction = existing ? extractFieldCondition(existing.fieldMeta) : { present: false as const };
    const incomingExtraction =
      field.fieldMeta !== undefined ? extractFieldCondition(field.fieldMeta) : existingExtraction;

    if (!incomingExtraction.present) {
      return field;
    }

    const existingRaw = existingExtraction.present
      ? existingExtraction.valid
        ? existingExtraction.condition
        : 'malformed'
      : null;
    const incomingRaw = incomingExtraction.valid ? incomingExtraction.condition : 'malformed';

    const conditionUnchanged = JSON.stringify(existingRaw) === JSON.stringify(incomingRaw);

    if (!conditionUnchanged) {
      // Actively being set/changed this save.
      if (internalVersion !== 2) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'Conditional visibility is only supported for V2 envelopes',
        });
      }

      // A malformed incoming value can only arise from a caller bypassing the
      // typed request schema (e.g. raw API usage) — reject it the same as any
      // other invalid reference.
      if (!incomingExtraction.valid) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'Conditional visibility is malformed',
        });
      }

      validateFieldConditionRef({
        targetFieldId: field.id ?? null,
        condition: incomingExtraction.condition,
        envelopeFields: existingFieldsAfterUpdate,
      });

      return field;
    }

    const evaluationField = {
      id: field.id ?? -1,
      type: field.type,
      fieldMeta: field.fieldMeta ?? existing?.fieldMeta ?? null,
      customText: '',
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    } as FieldForConditionEvaluation;

    const stillValid = resolveFieldConditionState(evaluationField, existingFieldsAfterUpdate).status !== 'invalid';

    if (stillValid) {
      return field;
    }

    if (signedRecipientIds.has(field.recipientId)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message:
          'This change cannot be applied because it would change a requirement or remove consent for a recipient who has already completed signing',
      });
    }

    const baseMeta = field.fieldMeta ?? existing?.fieldMeta;
    const currentMeta = typeof baseMeta === 'object' && baseMeta !== null ? baseMeta : {};

    return {
      ...field,
      fieldMeta: { ...currentMeta, condition: null },
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    } as T;
  });
};

/**
 * After duplicating/instantiating fields with fresh ids, rewrites any
 * `fieldMeta.condition.fieldId` on the new rows to point at the corresponding new
 * field instead of the original (now foreign) one. A reference that has no entry
 * in the map (should not happen for a same-envelope condition, but defensive), or
 * that was already malformed on the source field, is dropped rather than copied
 * forward.
 */
export const remapFieldConditionReferences = async ({
  tx,
  newFields,
  oldFieldIdToNewFieldId,
}: {
  tx: Prisma.TransactionClient;
  newFields: Field[];
  oldFieldIdToNewFieldId: Record<number, number>;
}): Promise<void> => {
  for (const field of newFields) {
    const extraction = extractFieldCondition(field.fieldMeta);

    if (!extraction.present) {
      continue;
    }

    const currentMeta = typeof field.fieldMeta === 'object' && field.fieldMeta !== null ? field.fieldMeta : {};

    const remappedFieldId = extraction.valid ? oldFieldIdToNewFieldId[extraction.condition.fieldId] : undefined;
    const newCondition =
      extraction.valid && remappedFieldId !== undefined ? { ...extraction.condition, fieldId: remappedFieldId } : null;

    await tx.field.update({
      where: { id: field.id },
      data: {
        fieldMeta: {
          ...currentMeta,
          condition: newCondition,
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        } as PrismaJson.FieldMeta,
      },
    });
  }
};
