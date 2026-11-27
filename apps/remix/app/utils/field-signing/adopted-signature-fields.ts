import { FieldType } from '@prisma/client';

/**
 * The signer's fields that a signature adopted in the signing form (the mobile
 * "Sign Document" bar or the desktop sidebar) is inserted into: every unsigned
 * SIGNATURE field. Pass the visibility-filtered list, so a field hidden by an
 * unmet condition is never signed.
 */
export const getFieldsToSignWithAdoptedSignature = <T extends { type: FieldType; inserted: boolean }>(
  fields: T[],
): T[] => fields.filter((field) => field.type === FieldType.SIGNATURE && !field.inserted);
