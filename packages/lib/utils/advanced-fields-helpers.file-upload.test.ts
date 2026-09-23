import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { ADVANCED_FIELD_TYPES_WITH_OPTIONAL_SETTING, isRequiredField } from './advanced-fields-helpers';

const baseField = {
  id: 1,
  secondaryId: 'field_1',
  envelopeId: 'env_1',
  envelopeItemId: 'item_1',
  recipientId: 1,
  page: 1,
  positionX: 0,
  positionY: 0,
  width: 10,
  height: 10,
  customText: '',
  inserted: false,
} as const;

describe('FILE_UPLOAD required-by-default semantics', () => {
  it('is not in the opt-in optional-setting array', () => {
    // The v2 editor has no settings UI to toggle `required` for any field
    // type it can place — FILE_UPLOAD follows the same always-required
    // convention as SIGNATURE/INITIALS/NAME/EMAIL/DATE rather than
    // introducing a toggle nothing in the UI can set.
    expect(ADVANCED_FIELD_TYPES_WITH_OPTIONAL_SETTING).not.toContain(FieldType.FILE_UPLOAD);
  });

  it('is always required, even with no fieldMeta', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const field = { ...baseField, type: FieldType.FILE_UPLOAD, fieldMeta: null } as unknown as Parameters<
      typeof isRequiredField
    >[0];

    expect(isRequiredField(field)).toBe(true);
  });

  it('is always required even if fieldMeta explicitly sets required: false', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const field = {
      ...baseField,
      type: FieldType.FILE_UPLOAD,
      fieldMeta: { type: 'file_upload', required: false },
    } as unknown as Parameters<typeof isRequiredField>[0];

    expect(isRequiredField(field)).toBe(true);
  });
});
