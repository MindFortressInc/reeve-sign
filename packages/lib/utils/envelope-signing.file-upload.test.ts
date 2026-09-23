import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { extractFieldInsertionValues } from './envelope-signing';

const envelopeId = 'env_abc';
const fieldId = 42;

const baseField = {
  id: fieldId,
  secondaryId: 'field_42',
  envelopeId,
  envelopeItemId: 'item_1',
  recipientId: 1,
  type: FieldType.FILE_UPLOAD,
  page: 1,
  positionX: 0,
  positionY: 0,
  width: 10,
  height: 10,
  customText: '',
  inserted: false,
  fieldMeta: null,
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
} as unknown as Parameters<typeof extractFieldInsertionValues>[0]['field'];

const documentMeta = {
  timezone: 'UTC',
  dateFormat: 'yyyy-MM-dd',
  typedSignatureEnabled: true,
};

const validValue = {
  key: `field-uploads-tmp/${envelopeId}/${fieldId}/abcdefghijkl/license.pdf`,
  fileName: 'license.pdf',
  size: 1024,
  mimeType: 'application/pdf',
};

describe('extractFieldInsertionValues — FILE_UPLOAD', () => {
  it('inserts a well-formed value owned by this exact field', () => {
    const result = extractFieldInsertionValues({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      fieldValue: { type: FieldType.FILE_UPLOAD, value: validValue } as never,
      field: baseField,
      documentMeta,
    });

    expect(result.inserted).toBe(true);
    expect(JSON.parse(result.customText)).toEqual(validValue);
  });

  it('uninserts when value is null', () => {
    const result = extractFieldInsertionValues({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      fieldValue: { type: FieldType.FILE_UPLOAD, value: null } as never,
      field: baseField,
      documentMeta,
    });

    expect(result).toEqual({ customText: '', inserted: false });
  });

  it('rejects a key minted for a different field', () => {
    const foreignValue = { ...validValue, key: `field-uploads-tmp/${envelopeId}/999/abcdefghijkl/license.pdf` };

    expect(() =>
      extractFieldInsertionValues({
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        fieldValue: { type: FieldType.FILE_UPLOAD, value: foreignValue } as never,
        field: baseField,
        documentMeta,
      }),
    ).toThrow();
  });

  it('rejects a key minted for a different envelope', () => {
    const foreignValue = { ...validValue, key: `field-uploads-tmp/env_other/${fieldId}/abcdefghijkl/license.pdf` };

    expect(() =>
      extractFieldInsertionValues({
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        fieldValue: { type: FieldType.FILE_UPLOAD, value: foreignValue } as never,
        field: baseField,
        documentMeta,
      }),
    ).toThrow();
  });

  it('rejects a disallowed MIME type', () => {
    const badValue = { ...validValue, mimeType: 'application/x-msdownload' };

    expect(() =>
      extractFieldInsertionValues({
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        fieldValue: { type: FieldType.FILE_UPLOAD, value: badValue } as never,
        field: baseField,
        documentMeta,
      }),
    ).toThrow();
  });

  it('rejects a FINAL-prefixed key submitted directly (not a fresh tmp upload)', () => {
    const finalValue = { ...validValue, key: `field-uploads/${envelopeId}/${fieldId}/abcdefghijkl/license.pdf` };

    expect(() =>
      extractFieldInsertionValues({
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        fieldValue: { type: FieldType.FILE_UPLOAD, value: finalValue } as never,
        field: baseField,
        documentMeta,
      }),
    ).toThrow();
  });

  it('rejects a file exceeding the size limit', () => {
    const tooBig = { ...validValue, size: 16 * 1024 * 1024 };

    expect(() =>
      extractFieldInsertionValues({
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        fieldValue: { type: FieldType.FILE_UPLOAD, value: tooBig } as never,
        field: baseField,
        documentMeta,
      }),
    ).toThrow();
  });
});
