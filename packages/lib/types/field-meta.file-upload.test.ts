import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  FIELD_FILE_UPLOAD_META_DEFAULT_VALUES,
  FIELD_META_DEFAULT_VALUES,
  ZEnvelopeFieldAndMetaSchema,
  ZFieldAndMetaSchema,
  ZFieldMetaNotOptionalSchema,
  ZFileUploadFieldMeta,
} from './field-meta';

describe('ZFileUploadFieldMeta', () => {
  it('accepts the minimal default shape', () => {
    const result = ZFileUploadFieldMeta.safeParse({ type: 'file_upload' });

    expect(result.success).toBe(true);
  });

  it('accepts label/required/readOnly like other base field meta', () => {
    const result = ZFileUploadFieldMeta.safeParse({
      type: 'file_upload',
      label: 'Driver license',
      required: true,
      readOnly: false,
    });

    expect(result.success).toBe(true);
  });

  it('rejects a mismatched type literal', () => {
    const result = ZFileUploadFieldMeta.safeParse({ type: 'text' });

    expect(result.success).toBe(false);
  });
});

describe('ZFieldMetaNotOptionalSchema (discriminated union)', () => {
  it('discriminates a file_upload meta object correctly', () => {
    const result = ZFieldMetaNotOptionalSchema.safeParse({ type: 'file_upload', label: 'Proof of funds' });

    expect(result.success).toBe(true);
  });
});

describe('FIELD_META_DEFAULT_VALUES[FieldType.FILE_UPLOAD]', () => {
  it('is registered and matches the exported default constant', () => {
    expect(FIELD_META_DEFAULT_VALUES[FieldType.FILE_UPLOAD]).toEqual(FIELD_FILE_UPLOAD_META_DEFAULT_VALUES);
  });

  it('has the file_upload type discriminator', () => {
    expect(FIELD_META_DEFAULT_VALUES[FieldType.FILE_UPLOAD]).toMatchObject({ type: 'file_upload' });
  });
});

describe('ZFieldAndMetaSchema', () => {
  it('accepts a FILE_UPLOAD field with optional fieldMeta', () => {
    const result = ZFieldAndMetaSchema.safeParse({ type: FieldType.FILE_UPLOAD });

    expect(result.success).toBe(true);
  });
});

describe('ZEnvelopeFieldAndMetaSchema', () => {
  it('defaults fieldMeta to FIELD_FILE_UPLOAD_META_DEFAULT_VALUES when omitted', () => {
    const result = ZEnvelopeFieldAndMetaSchema.parse({ type: FieldType.FILE_UPLOAD });

    expect(result).toMatchObject({
      type: FieldType.FILE_UPLOAD,
      fieldMeta: FIELD_FILE_UPLOAD_META_DEFAULT_VALUES,
    });
  });
});
