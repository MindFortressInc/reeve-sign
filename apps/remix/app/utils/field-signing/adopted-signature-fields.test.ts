import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { getFieldsToSignWithAdoptedSignature } from './adopted-signature-fields';

const field = (id: number, type: FieldType, inserted = false) => ({ id, type, inserted });

describe('getFieldsToSignWithAdoptedSignature (DEV-20648)', () => {
  it('returns every unsigned signature field', () => {
    const fields = [field(1, FieldType.SIGNATURE), field(2, FieldType.SIGNATURE)];

    expect(getFieldsToSignWithAdoptedSignature(fields).map((f) => f.id)).toEqual([1, 2]);
  });

  it('skips signature fields that are already signed', () => {
    const fields = [field(1, FieldType.SIGNATURE, true), field(2, FieldType.SIGNATURE)];

    expect(getFieldsToSignWithAdoptedSignature(fields).map((f) => f.id)).toEqual([2]);
  });

  it('skips fields that are not signature fields', () => {
    const fields = [
      field(1, FieldType.INITIALS),
      field(2, FieldType.NAME),
      field(3, FieldType.FREE_SIGNATURE),
      field(4, FieldType.SIGNATURE),
    ];

    expect(getFieldsToSignWithAdoptedSignature(fields).map((f) => f.id)).toEqual([4]);
  });
});
