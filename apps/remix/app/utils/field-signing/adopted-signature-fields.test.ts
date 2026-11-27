import { DocumentAuth } from '@documenso/lib/types/document-auth';
import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { getFieldsToSignWithAdoptedSignature } from './adopted-signature-fields';

const field = (id: number, type: FieldType, inserted = false, readOnly = false) => ({
  id,
  type,
  inserted,
  fieldMeta: readOnly ? { type: 'signature' as const, readOnly: true } : null,
});

const ids = (fields: { id: number }[]) => fields.map((f) => f.id);

describe('getFieldsToSignWithAdoptedSignature (DEV-20648)', () => {
  it('returns every unsigned signature field when no re-auth is required', () => {
    const fields = [field(1, FieldType.SIGNATURE), field(2, FieldType.SIGNATURE)];

    expect(ids(getFieldsToSignWithAdoptedSignature(fields, []))).toEqual([1, 2]);
    expect(ids(getFieldsToSignWithAdoptedSignature(fields, [DocumentAuth.ACCOUNT]))).toEqual([1, 2]);
    expect(ids(getFieldsToSignWithAdoptedSignature(fields, [DocumentAuth.EXPLICIT_NONE]))).toEqual([1, 2]);
  });

  it('skips signature fields that are already signed', () => {
    const fields = [field(1, FieldType.SIGNATURE, true), field(2, FieldType.SIGNATURE)];

    expect(ids(getFieldsToSignWithAdoptedSignature(fields, []))).toEqual([2]);
  });

  it('skips read-only signature fields', () => {
    const fields = [field(1, FieldType.SIGNATURE, false, true), field(2, FieldType.SIGNATURE)];

    expect(ids(getFieldsToSignWithAdoptedSignature(fields, []))).toEqual([2]);
  });

  it('skips fields that are not signature fields', () => {
    const fields = [
      field(1, FieldType.INITIALS),
      field(2, FieldType.NAME),
      field(3, FieldType.FREE_SIGNATURE),
      field(4, FieldType.SIGNATURE),
    ];

    expect(ids(getFieldsToSignWithAdoptedSignature(fields, []))).toEqual([4]);
  });

  it.each([
    DocumentAuth.PASSKEY,
    DocumentAuth.PASSWORD,
    DocumentAuth.TWO_FACTOR_AUTH,
  ])('signs only the first field when %s re-auth is required per signature', (authType) => {
    const fields = [field(1, FieldType.SIGNATURE), field(2, FieldType.SIGNATURE)];

    expect(ids(getFieldsToSignWithAdoptedSignature(fields, [authType]))).toEqual([1]);
  });
});
