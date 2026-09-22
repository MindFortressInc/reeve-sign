import type { Field } from '@prisma/client';
import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { AppError } from '../errors/app-error';
import {
  assertValidFieldConditionGraph,
  extractFieldCondition,
  fieldsContainUnsignedRequiredVisibleField,
  filterVisibleFields,
  findCompletedDependentsAffectedByControllerChange,
  findFieldsWithDanglingConditions,
  getFieldCondition,
  isFieldVisible,
  resolveBulkFieldConditions,
  resolveFieldConditionState,
  validateFieldConditionRef,
} from './field-conditions';

const makeField = (
  overrides: Omit<Partial<Field>, 'fieldMeta'> & { id: number; type: FieldType; fieldMeta?: unknown },
): Field => {
  return {
    secondaryId: `field_${overrides.id}`,
    envelopeId: 'envelope_1',
    envelopeItemId: 'envelope_item_1',
    recipientId: 1,
    page: 1,
    positionX: 0,
    positionY: 0,
    width: 5,
    height: 5,
    customText: '',
    inserted: false,
    fieldMeta: null,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  } as Field;
};

const checkboxField = (id: number, customText: string, valueIds: number[] = [1], extra: Partial<Field> = {}) =>
  makeField({
    id,
    type: FieldType.CHECKBOX,
    customText,
    fieldMeta: {
      type: 'checkbox',
      direction: 'vertical',
      values: valueIds.map((valueId) => ({ id: valueId, checked: false, value: `Option ${valueId}` })),
    },
    ...extra,
  });

const dependentField = (id: number, conditionFieldId: number, optionIds: number[] = [1], extra: Partial<Field> = {}) =>
  makeField({
    id,
    type: FieldType.SIGNATURE,
    fieldMeta: {
      type: 'signature',
      overflow: 'auto',
      condition: { fieldId: conditionFieldId, optionIds },
    },
    ...extra,
  });

describe('extractFieldCondition / getFieldCondition', () => {
  it('reports absent when there is no condition key', () => {
    expect(extractFieldCondition({ type: 'signature' })).toEqual({ present: false });
    expect(extractFieldCondition(null)).toEqual({ present: false });
    expect(extractFieldCondition({ type: 'signature', condition: null })).toEqual({ present: false });
  });

  it('reports valid for a well-formed condition', () => {
    expect(extractFieldCondition({ type: 'signature', condition: { fieldId: 1, optionIds: [1] } })).toEqual({
      present: true,
      valid: true,
      condition: { fieldId: 1, optionIds: [1] },
    });
  });

  it('distinguishes malformed-but-present from absent', () => {
    expect(extractFieldCondition({ type: 'signature', condition: { fieldId: 'bad', optionIds: [1] } })).toEqual({
      present: true,
      valid: false,
    });
    expect(extractFieldCondition({ type: 'signature', condition: { fieldId: 1 } })).toEqual({
      present: true,
      valid: false,
    });
    expect(extractFieldCondition({ type: 'signature', condition: { fieldId: 1, optionIds: [] } })).toEqual({
      present: true,
      valid: false,
    });
    expect(extractFieldCondition({ type: 'signature', condition: 'not-an-object' })).toEqual({
      present: true,
      valid: false,
    });
  });

  it('getFieldCondition folds malformed into null (convenience only, not for finalization gates)', () => {
    expect(getFieldCondition({ type: 'signature', condition: { fieldId: 'bad', optionIds: [1] } })).toBeNull();
    expect(getFieldCondition({ type: 'signature', condition: { fieldId: 1, optionIds: [1] } })).toEqual({
      fieldId: 1,
      optionIds: [1],
    });
  });
});

describe('resolveFieldConditionState', () => {
  it('is visible when there is no condition', () => {
    expect(resolveFieldConditionState(makeField({ id: 1, type: FieldType.TEXT }), [])).toEqual({
      status: 'visible',
    });
  });

  it('is visible when the controlling checkbox has the target option checked', () => {
    const controller = checkboxField(1, JSON.stringify([0]), [10]);
    const dependent = dependentField(2, 1, [10]);

    expect(resolveFieldConditionState(dependent, [controller, dependent])).toEqual({ status: 'visible' });
  });

  it('is hidden (a valid, unmet predicate) when the option is not checked', () => {
    const controller = checkboxField(1, JSON.stringify([]), [10]);
    const dependent = dependentField(2, 1, [10]);

    expect(resolveFieldConditionState(dependent, [controller, dependent])).toEqual({ status: 'hidden' });
  });

  it('resolves the selected option by stable id, not positional index, across reordering', () => {
    const controller = checkboxField(1, JSON.stringify([1]), [20, 10]);
    const dependent = dependentField(2, 1, [10]);

    expect(resolveFieldConditionState(dependent, [controller, dependent]).status).toBe('visible');
  });

  it('is invalid — not silently visible or hidden — for a malformed persisted condition', () => {
    const malformed = makeField({
      id: 2,
      type: FieldType.SIGNATURE,
      fieldMeta: { type: 'signature', overflow: 'auto', condition: { fieldId: 'not-a-number', optionIds: [1] } },
    });

    expect(resolveFieldConditionState(malformed, [malformed]).status).toBe('invalid');
  });

  it('is invalid for a condition key present but not object-shaped', () => {
    const malformed = makeField({
      id: 2,
      type: FieldType.SIGNATURE,
      fieldMeta: { type: 'signature', overflow: 'auto', condition: 'yes-please' },
    });

    expect(resolveFieldConditionState(malformed, [malformed]).status).toBe('invalid');
  });

  it('is invalid (not merely hidden) when the controlling field is dangling', () => {
    const dependent = dependentField(2, 999, [10]);

    expect(resolveFieldConditionState(dependent, [dependent]).status).toBe('invalid');
  });

  it('is invalid when the controlling field is not a checkbox', () => {
    const controller = makeField({ id: 1, type: FieldType.TEXT, customText: 'hi' });
    const dependent = dependentField(2, 1, [10]);

    expect(resolveFieldConditionState(dependent, [controller, dependent]).status).toBe('invalid');
  });

  it('is invalid when a referenced option id no longer exists on the controller', () => {
    const controller = checkboxField(1, JSON.stringify([0]), [10]);
    const dependent = dependentField(2, 1, [999]);

    expect(resolveFieldConditionState(dependent, [controller, dependent]).status).toBe('invalid');
  });

  it('is invalid, not a crash, when the controlling checkbox has malformed customText (bad JSON)', () => {
    const controller = checkboxField(1, 'not valid json{{', [10]);
    const dependent = dependentField(2, 1, [10]);

    const state = resolveFieldConditionState(dependent, [controller, dependent]);

    expect(state.status).toBe('invalid');
  });

  it('is invalid, not a crash, when the controlling checkbox customText is valid JSON but not an array', () => {
    const controller = checkboxField(1, '5', [10]);
    const dependent = dependentField(2, 1, [10]);

    const state = resolveFieldConditionState(dependent, [controller, dependent]);

    expect(state.status).toBe('invalid');
  });

  it('is invalid when the condition graph contains a cycle', () => {
    const fieldA = makeField({
      id: 1,
      type: FieldType.CHECKBOX,
      customText: JSON.stringify([0]),
      fieldMeta: {
        type: 'checkbox',
        direction: 'vertical',
        values: [{ id: 10, checked: false, value: 'A' }],
        condition: { fieldId: 2, optionIds: [20] },
      },
    });
    const fieldB = makeField({
      id: 2,
      type: FieldType.CHECKBOX,
      customText: JSON.stringify([0]),
      fieldMeta: {
        type: 'checkbox',
        direction: 'vertical',
        values: [{ id: 20, checked: false, value: 'B' }],
        condition: { fieldId: 1, optionIds: [10] },
      },
    });

    expect(resolveFieldConditionState(fieldA, [fieldA, fieldB]).status).toBe('invalid');
  });

  it('transitively hides a field whose controller is itself hidden, even if the downstream checkbox is checked', () => {
    const fieldA = checkboxField(1, JSON.stringify([]), [10]);
    const fieldB = makeField({
      id: 2,
      type: FieldType.CHECKBOX,
      customText: JSON.stringify([0]),
      fieldMeta: {
        type: 'checkbox',
        direction: 'vertical',
        values: [{ id: 20, checked: false, value: 'B option' }],
        condition: { fieldId: 1, optionIds: [10] },
      },
    });
    const fieldC = dependentField(3, 2, [20]);

    const all = [fieldA, fieldB, fieldC];

    expect(resolveFieldConditionState(fieldB, all)).toEqual({ status: 'hidden' });
    expect(resolveFieldConditionState(fieldC, all)).toEqual({ status: 'hidden' });
  });

  it('reveals a transitive chain when every link is satisfied', () => {
    const fieldA = checkboxField(1, JSON.stringify([0]), [10]);
    const fieldB = makeField({
      id: 2,
      type: FieldType.CHECKBOX,
      customText: JSON.stringify([0]),
      fieldMeta: {
        type: 'checkbox',
        direction: 'vertical',
        values: [{ id: 20, checked: false, value: 'B option' }],
        condition: { fieldId: 1, optionIds: [10] },
      },
    });
    const fieldC = dependentField(3, 2, [20]);

    expect(resolveFieldConditionState(fieldC, [fieldA, fieldB, fieldC]).status).toBe('visible');
  });
});

describe('isFieldVisible / filterVisibleFields', () => {
  it('never treats a malformed condition as unconditional (always visible)', () => {
    const malformed = makeField({
      id: 2,
      type: FieldType.SIGNATURE,
      fieldMeta: { type: 'signature', overflow: 'auto', condition: { fieldId: 'nope' } },
    });

    expect(isFieldVisible(malformed, [malformed])).toBe(false);
  });

  it('filters out fields whose condition is not met', () => {
    const controller = checkboxField(1, JSON.stringify([]), [10]);
    const dependent = dependentField(2, 1, [10]);

    expect(filterVisibleFields([controller, dependent], [controller, dependent])).toEqual([controller]);
  });

  it('keeps fields whose condition is met', () => {
    const controller = checkboxField(1, JSON.stringify([0]), [10]);
    const dependent = dependentField(2, 1, [10]);

    expect(isFieldVisible(dependent, [controller, dependent])).toBe(true);
  });
});

describe('fieldsContainUnsignedRequiredVisibleField', () => {
  it('does not block on a required field hidden by a valid unmet condition', () => {
    const controller = checkboxField(1, JSON.stringify([]), [10]);
    const hiddenRequiredDependent = makeField({
      id: 2,
      type: FieldType.SIGNATURE,
      inserted: false,
      fieldMeta: { type: 'signature', overflow: 'auto', required: true, condition: { fieldId: 1, optionIds: [10] } },
    });

    expect(
      fieldsContainUnsignedRequiredVisibleField([hiddenRequiredDependent], [controller, hiddenRequiredDependent]),
    ).toBe(false);
  });

  it('still blocks on a required visible field', () => {
    const controller = checkboxField(1, JSON.stringify([0]), [10]);
    const visibleRequiredDependent = makeField({
      id: 2,
      type: FieldType.SIGNATURE,
      inserted: false,
      fieldMeta: { type: 'signature', overflow: 'auto', required: true, condition: { fieldId: 1, optionIds: [10] } },
    });

    expect(
      fieldsContainUnsignedRequiredVisibleField([visibleRequiredDependent], [controller, visibleRequiredDependent]),
    ).toBe(true);
  });
});

describe('assertValidFieldConditionGraph', () => {
  it('does not throw for a valid graph, whether met or unmet', () => {
    const controller = checkboxField(1, JSON.stringify([]), [10]);
    const dependent = dependentField(2, 1, [10]);

    expect(() => assertValidFieldConditionGraph([dependent], [controller, dependent])).not.toThrow();
  });

  it('throws — does not silently succeed as "hidden" — for a malformed persisted condition', () => {
    const malformed = makeField({
      id: 2,
      type: FieldType.SIGNATURE,
      fieldMeta: { type: 'signature', overflow: 'auto', condition: { fieldId: 'nope', optionIds: [1] } },
    });

    expect(() => assertValidFieldConditionGraph([malformed], [malformed])).toThrow(AppError);
  });

  it('throws for a dangling reference instead of silently treating it as hidden', () => {
    const dependent = dependentField(2, 999, [10]);

    expect(() => assertValidFieldConditionGraph([dependent], [dependent])).toThrow(AppError);
  });

  it('throws for a cycle', () => {
    const fieldA = makeField({
      id: 1,
      type: FieldType.CHECKBOX,
      fieldMeta: {
        type: 'checkbox',
        direction: 'vertical',
        values: [{ id: 10, checked: false, value: 'A' }],
        condition: { fieldId: 2, optionIds: [20] },
      },
    });
    const fieldB = makeField({
      id: 2,
      type: FieldType.CHECKBOX,
      fieldMeta: {
        type: 'checkbox',
        direction: 'vertical',
        values: [{ id: 20, checked: false, value: 'B' }],
        condition: { fieldId: 1, optionIds: [10] },
      },
    });

    expect(() => assertValidFieldConditionGraph([fieldA, fieldB], [fieldA, fieldB])).toThrow(AppError);
  });
});

describe('findCompletedDependentsAffectedByControllerChange', () => {
  it('flags a completed dependent that would flip hidden -> visible (off -> on)', () => {
    // Buyer's checkbox is currently off; CoBuyer already completed with their
    // dependent signature field legitimately hidden+exempt.
    const controller = checkboxField(1, JSON.stringify([]), [10], { recipientId: 9 });
    const coBuyerSignature = dependentField(2, 1, [10], { recipientId: 2, inserted: false });

    const affected = findCompletedDependentsAffectedByControllerChange({
      controllerFieldId: 1,
      proposedCustomText: JSON.stringify([0]), // Buyer is about to check the box
      allEnvelopeFields: [controller, coBuyerSignature],
      signedRecipientIds: new Set([2]), // CoBuyer already signed
    });

    expect(affected.map((f) => f.id)).toEqual([2]);
  });

  it('flags a completed dependent that would flip visible -> hidden (on -> off), which would drop consent', () => {
    const controller = checkboxField(1, JSON.stringify([0]), [10], { recipientId: 9 });
    const coBuyerSignature = dependentField(2, 1, [10], { recipientId: 2, inserted: true, customText: 'signed' });

    const affected = findCompletedDependentsAffectedByControllerChange({
      controllerFieldId: 1,
      proposedCustomText: JSON.stringify([]), // Buyer is about to uncheck the box
      allEnvelopeFields: [controller, coBuyerSignature],
      signedRecipientIds: new Set([2]),
    });

    expect(affected.map((f) => f.id)).toEqual([2]);
  });

  it('flags the same off -> on transition even when the controller itself is being uninserted (proposedCustomText empty)', () => {
    // "Uninsert" on a checkbox that currently satisfies a completed dependent's
    // condition is itself a visible -> hidden mutation and must be caught too.
    const controller = checkboxField(1, JSON.stringify([0]), [10], { recipientId: 9 });
    const coBuyerSignature = dependentField(2, 1, [10], { recipientId: 2, inserted: true, customText: 'signed' });

    const affected = findCompletedDependentsAffectedByControllerChange({
      controllerFieldId: 1,
      proposedCustomText: '', // uninsert
      allEnvelopeFields: [controller, coBuyerSignature],
      signedRecipientIds: new Set([2]),
    });

    expect(affected.map((f) => f.id)).toEqual([2]);
  });

  it('does not flag a dependent belonging to a recipient who has not completed yet', () => {
    const controller = checkboxField(1, JSON.stringify([]), [10], { recipientId: 9 });
    const coBuyerSignature = dependentField(2, 1, [10], { recipientId: 2, inserted: false });

    const affected = findCompletedDependentsAffectedByControllerChange({
      controllerFieldId: 1,
      proposedCustomText: JSON.stringify([0]),
      allEnvelopeFields: [controller, coBuyerSignature],
      signedRecipientIds: new Set(), // CoBuyer has NOT signed yet
    });

    expect(affected).toEqual([]);
  });

  it('does not flag a completed dependent whose visibility is unaffected by this change', () => {
    const controller = checkboxField(1, JSON.stringify([0]), [10], { recipientId: 9 });
    // A second, unrelated checkbox option toggling doesn't touch this dependent.
    const unrelatedController = checkboxField(3, JSON.stringify([]), [30], { recipientId: 9 });
    const coBuyerSignature = dependentField(2, 1, [10], { recipientId: 2, inserted: true, customText: 'signed' });

    const affected = findCompletedDependentsAffectedByControllerChange({
      controllerFieldId: 3,
      proposedCustomText: JSON.stringify([0]),
      allEnvelopeFields: [controller, unrelatedController, coBuyerSignature],
      signedRecipientIds: new Set([2]),
    });

    expect(affected).toEqual([]);
  });

  it('transitively flags a completed grandchild dependent', () => {
    const fieldA = checkboxField(1, JSON.stringify([]), [10], { recipientId: 9 });
    const fieldB = makeField({
      id: 2,
      type: FieldType.CHECKBOX,
      recipientId: 9,
      customText: JSON.stringify([0]),
      fieldMeta: {
        type: 'checkbox',
        direction: 'vertical',
        values: [{ id: 20, checked: false, value: 'B option' }],
        condition: { fieldId: 1, optionIds: [10] },
      },
    });
    const fieldC = dependentField(3, 2, [20], { recipientId: 5, inserted: false });

    const affected = findCompletedDependentsAffectedByControllerChange({
      controllerFieldId: 1,
      proposedCustomText: JSON.stringify([0]),
      allEnvelopeFields: [fieldA, fieldB, fieldC],
      signedRecipientIds: new Set([5]),
    });

    expect(affected.map((f) => f.id)).toEqual([3]);
  });
});

describe('findFieldsWithDanglingConditions', () => {
  it('finds a dependent left dangling after its controller is removed', () => {
    const dependent = dependentField(2, 1, [10]);

    expect(findFieldsWithDanglingConditions([dependent], [dependent])).toEqual([dependent]);
  });

  it('finds a dependent left dangling after its referenced option is removed', () => {
    const controllerAfterOptionRemoved = checkboxField(1, JSON.stringify([]), [999]);
    const dependent = dependentField(2, 1, [10]);

    expect(findFieldsWithDanglingConditions([dependent], [controllerAfterOptionRemoved, dependent])).toEqual([
      dependent,
    ]);
  });

  it('self-heals a pre-existing malformed condition', () => {
    const malformed = makeField({
      id: 2,
      type: FieldType.SIGNATURE,
      fieldMeta: { type: 'signature', overflow: 'auto', condition: { fieldId: 'nope' } },
    });

    expect(findFieldsWithDanglingConditions([malformed], [malformed])).toEqual([malformed]);
  });

  it('does not flag a field whose condition is still valid', () => {
    const controller = checkboxField(1, JSON.stringify([]), [10]);
    const dependent = dependentField(2, 1, [10]);

    expect(findFieldsWithDanglingConditions([dependent], [controller, dependent])).toEqual([]);
  });

  it('does not flag fields without a condition at all', () => {
    const plain = makeField({ id: 1, type: FieldType.TEXT });

    expect(findFieldsWithDanglingConditions([plain], [plain])).toEqual([]);
  });
});

describe('validateFieldConditionRef', () => {
  it('accepts a valid reference to a checkbox field in the same envelope', () => {
    const controller = checkboxField(1, '', [10, 20]);

    expect(() =>
      validateFieldConditionRef({
        targetFieldId: 2,
        condition: { fieldId: 1, optionIds: [10] },
        envelopeFields: [controller],
      }),
    ).not.toThrow();
  });

  it('rejects a self-reference', () => {
    const controller = checkboxField(1, '', [10]);

    expect(() =>
      validateFieldConditionRef({
        targetFieldId: 1,
        condition: { fieldId: 1, optionIds: [10] },
        envelopeFields: [controller],
      }),
    ).toThrow(AppError);
  });

  it('rejects a dangling reference', () => {
    expect(() =>
      validateFieldConditionRef({ targetFieldId: 2, condition: { fieldId: 999, optionIds: [10] }, envelopeFields: [] }),
    ).toThrow(AppError);
  });

  it('rejects a reference to a non-checkbox field', () => {
    const nonCheckbox = makeField({ id: 1, type: FieldType.TEXT });

    expect(() =>
      validateFieldConditionRef({
        targetFieldId: 2,
        condition: { fieldId: 1, optionIds: [10] },
        envelopeFields: [nonCheckbox],
      }),
    ).toThrow(AppError);
  });

  it('rejects an option id that does not exist on the controlling checkbox', () => {
    const controller = checkboxField(1, '', [10]);

    expect(() =>
      validateFieldConditionRef({
        targetFieldId: 2,
        condition: { fieldId: 1, optionIds: [999] },
        envelopeFields: [controller],
      }),
    ).toThrow(AppError);
  });

  it('rejects a cycle (A depends on B, B already depends on A)', () => {
    const fieldA = checkboxField(1, '', [10]);
    const fieldB = makeField({
      id: 2,
      type: FieldType.CHECKBOX,
      fieldMeta: {
        type: 'checkbox',
        direction: 'vertical',
        values: [{ id: 20, checked: false, value: 'B option' }],
        condition: { fieldId: 1, optionIds: [10] },
      },
    });

    expect(() =>
      validateFieldConditionRef({
        targetFieldId: 1,
        condition: { fieldId: 2, optionIds: [20] },
        envelopeFields: [fieldA, fieldB],
      }),
    ).toThrow(AppError);
  });

  it('skips self/cycle checks for a not-yet-persisted target field', () => {
    const controller = checkboxField(1, '', [10]);

    expect(() =>
      validateFieldConditionRef({
        targetFieldId: null,
        condition: { fieldId: 1, optionIds: [10] },
        envelopeFields: [controller],
      }),
    ).not.toThrow();
  });
});

describe('resolveBulkFieldConditions', () => {
  const noSigned = new Set<number>();

  it('leaves an unchanged, still-valid condition alone', () => {
    const controller = checkboxField(1, '', [10]);
    const dependent = dependentField(2, 1, [10]);

    const resolved = resolveBulkFieldConditions(
      [
        { id: 1, type: FieldType.CHECKBOX, fieldMeta: controller.fieldMeta, recipientId: 1 },
        { id: 2, type: FieldType.SIGNATURE, fieldMeta: dependent.fieldMeta, recipientId: 1 },
      ],
      [controller, dependent],
      { internalVersion: 2, signedRecipientIds: noSigned },
    );

    expect(getFieldCondition(resolved[1].fieldMeta)).toEqual({ fieldId: 1, optionIds: [10] });
  });

  it('silently clears a condition left dangling by another field being removed in the same batch', () => {
    const controller = checkboxField(1, '', [10]);
    const dependent = dependentField(2, 1, [10]);

    // Controller (id 1) absent from the incoming batch => it will be deleted.
    const resolved = resolveBulkFieldConditions(
      [{ id: 2, type: FieldType.SIGNATURE, fieldMeta: dependent.fieldMeta, recipientId: 1 }],
      [controller, dependent],
      { internalVersion: 2, signedRecipientIds: noSigned },
    );

    expect(getFieldCondition(resolved[0].fieldMeta)).toBeNull();
  });

  it('silently clears a pre-existing malformed condition left untouched by this batch', () => {
    const malformed = makeField({
      id: 2,
      type: FieldType.SIGNATURE,
      fieldMeta: { type: 'signature', overflow: 'auto', condition: { fieldId: 'nope' } },
    });

    const resolved = resolveBulkFieldConditions(
      [{ id: 2, type: FieldType.SIGNATURE, fieldMeta: malformed.fieldMeta, recipientId: 1 }],
      [malformed],
      { internalVersion: 2, signedRecipientIds: noSigned },
    );

    expect(getFieldCondition(resolved[0].fieldMeta)).toBeNull();
  });

  it('rejects the whole batch instead of clearing when the collaterally-dangling dependent belongs to an already-signed recipient', () => {
    const controller = checkboxField(1, '', [10]);
    const dependent = dependentField(2, 1, [10], { recipientId: 5 });

    expect(() =>
      resolveBulkFieldConditions(
        [{ id: 2, type: FieldType.SIGNATURE, fieldMeta: dependent.fieldMeta, recipientId: 5 }],
        [controller, dependent],
        { internalVersion: 2, signedRecipientIds: new Set([5]) },
      ),
    ).toThrow(AppError);
  });

  it('throws when a condition is newly set to an invalid reference this batch', () => {
    expect(() =>
      resolveBulkFieldConditions(
        [
          {
            id: 2,
            type: FieldType.SIGNATURE,
            fieldMeta: { type: 'signature', condition: { fieldId: 999, optionIds: [1] } },
            recipientId: 1,
          },
        ],
        [],
        { internalVersion: 2, signedRecipientIds: noSigned },
      ),
    ).toThrow(AppError);
  });

  it('throws when a condition is newly set with a malformed shape this batch', () => {
    expect(() =>
      resolveBulkFieldConditions(
        [
          {
            id: 2,
            type: FieldType.SIGNATURE,
            fieldMeta: { type: 'signature', condition: { fieldId: 'nope' } },
            recipientId: 1,
          },
        ],
        [],
        { internalVersion: 2, signedRecipientIds: noSigned },
      ),
    ).toThrow(AppError);
  });

  it('throws when a condition is newly set on a non-V2 envelope', () => {
    const controller = checkboxField(1, '', [10]);

    expect(() =>
      resolveBulkFieldConditions(
        [
          {
            id: 2,
            type: FieldType.SIGNATURE,
            fieldMeta: { type: 'signature', condition: { fieldId: 1, optionIds: [10] } },
            recipientId: 1,
          },
        ],
        [controller],
        { internalVersion: 1, signedRecipientIds: noSigned },
      ),
    ).toThrow(AppError);
  });
});
