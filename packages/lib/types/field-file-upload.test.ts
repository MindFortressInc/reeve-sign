import { describe, expect, it } from 'vitest';

import {
  buildFieldFileUploadKeyPrefix,
  buildFieldFileUploadTmpKeyPrefix,
  FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES,
  FIELD_FILE_UPLOAD_KEY_PREFIX,
  FIELD_FILE_UPLOAD_TMP_KEY_PREFIX,
  isFieldFileUploadTmpKeyOwnedBy,
  parseFileUploadCustomText,
  toFileUploadCustomText,
  ZFieldFileUploadValue,
} from './field-file-upload';

describe('buildFieldFileUploadKeyPrefix', () => {
  it('scopes the final prefix to the exact envelope and field', () => {
    expect(buildFieldFileUploadKeyPrefix({ envelopeId: 'env_abc', fieldId: 42 })).toBe(
      `${FIELD_FILE_UPLOAD_KEY_PREFIX}/env_abc/42/`,
    );
  });
});

describe('buildFieldFileUploadTmpKeyPrefix', () => {
  it('scopes the tmp prefix to the exact envelope and field, distinct from the final prefix', () => {
    const tmp = buildFieldFileUploadTmpKeyPrefix({ envelopeId: 'env_abc', fieldId: 42 });
    const final = buildFieldFileUploadKeyPrefix({ envelopeId: 'env_abc', fieldId: 42 });

    expect(tmp).toBe(`${FIELD_FILE_UPLOAD_TMP_KEY_PREFIX}/env_abc/42/`);
    expect(tmp).not.toBe(final);
    expect(tmp.startsWith(final)).toBe(false);
    expect(final.startsWith(tmp)).toBe(false);
  });
});

describe('isFieldFileUploadTmpKeyOwnedBy', () => {
  const envelopeId = 'env_abc';
  const fieldId = 42;

  it('accepts a tmp key that was minted for this exact envelope+field', () => {
    const key = `field-uploads-tmp/${envelopeId}/${fieldId}/abcdefghijkl/license.pdf`;

    expect(isFieldFileUploadTmpKeyOwnedBy({ key, envelopeId, fieldId })).toBe(true);
  });

  it('rejects a key minted for a different field on the same envelope', () => {
    const key = `field-uploads-tmp/${envelopeId}/999/abcdefghijkl/license.pdf`;

    expect(isFieldFileUploadTmpKeyOwnedBy({ key, envelopeId, fieldId })).toBe(false);
  });

  it('rejects a key minted for a different envelope', () => {
    const key = `field-uploads-tmp/env_other/${fieldId}/abcdefghijkl/license.pdf`;

    expect(isFieldFileUploadTmpKeyOwnedBy({ key, envelopeId, fieldId })).toBe(false);
  });

  it('rejects a key missing the random segment (malformed)', () => {
    const key = `field-uploads-tmp/${envelopeId}/${fieldId}/license.pdf`;

    expect(isFieldFileUploadTmpKeyOwnedBy({ key, envelopeId, fieldId })).toBe(false);
  });

  it('rejects path traversal attempts', () => {
    const key = `field-uploads-tmp/${envelopeId}/${fieldId}/../../etc/passwd`;

    expect(isFieldFileUploadTmpKeyOwnedBy({ key, envelopeId, fieldId })).toBe(false);
  });

  it('rejects a key with an extra nested path in the filename segment', () => {
    const key = `field-uploads-tmp/${envelopeId}/${fieldId}/abcdefghijkl/nested/license.pdf`;

    expect(isFieldFileUploadTmpKeyOwnedBy({ key, envelopeId, fieldId })).toBe(false);
  });

  it('rejects a completely unrelated key', () => {
    expect(isFieldFileUploadTmpKeyOwnedBy({ key: 'some/other/key.pdf', envelopeId, fieldId })).toBe(false);
  });

  it('rejects a FINAL-prefixed key submitted as if it were a tmp upload', () => {
    // A client should never be able to claim an already-finalized key as a
    // fresh submission — the tmp check must not accidentally match the
    // final prefix.
    const key = `field-uploads/${envelopeId}/${fieldId}/abcdefghijkl/license.pdf`;

    expect(isFieldFileUploadTmpKeyOwnedBy({ key, envelopeId, fieldId })).toBe(false);
  });
});

describe('toFileUploadCustomText / parseFileUploadCustomText', () => {
  const value = {
    key: 'field-uploads/env_abc/42/abcdefghijkl/license.pdf',
    fileName: 'license.pdf',
    size: 12345,
    mimeType: 'application/pdf',
  };

  it('round-trips a valid value through serialize/parse', () => {
    const customText = toFileUploadCustomText(value);

    expect(parseFileUploadCustomText(customText)).toEqual(value);
  });

  it('returns null for an empty string (uninserted field)', () => {
    expect(parseFileUploadCustomText('')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseFileUploadCustomText('{not json')).toBeNull();
  });

  it('returns null when the parsed JSON does not match the schema', () => {
    expect(parseFileUploadCustomText(JSON.stringify({ key: 'x' }))).toBeNull();
  });
});

describe('ZFieldFileUploadValue', () => {
  it('accepts a well-formed value', () => {
    const result = ZFieldFileUploadValue.safeParse({
      key: 'field-uploads/env_abc/42/abcdefghijkl/license.pdf',
      fileName: 'license.pdf',
      size: 1,
      mimeType: 'application/pdf',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a negative or zero size', () => {
    const result = ZFieldFileUploadValue.safeParse({
      key: 'field-uploads/env_abc/42/abcdefghijkl/license.pdf',
      fileName: 'license.pdf',
      size: 0,
      mimeType: 'application/pdf',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a missing fileName', () => {
    const result = ZFieldFileUploadValue.safeParse({
      key: 'field-uploads/env_abc/42/abcdefghijkl/license.pdf',
      size: 1,
      mimeType: 'application/pdf',
    });

    expect(result.success).toBe(false);
  });
});

describe('FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES', () => {
  it('allows common document/image types used for real-estate paperwork', () => {
    expect(FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES).toEqual(
      expect.arrayContaining(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']),
    );
  });

  it('does not allow executable or script content types', () => {
    const disallowed = ['text/html', 'application/javascript', 'application/x-msdownload'];

    for (const mimeType of disallowed) {
      expect(FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES).not.toContain(mimeType);
    }
  });
});
