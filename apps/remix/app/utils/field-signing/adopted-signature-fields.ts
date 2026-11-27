import { NON_AUTO_SIGNABLE_ACTION_AUTH_TYPES } from '@documenso/lib/constants/autosign';
import { FieldType } from '@prisma/client';

type AdoptableField = {
  type: FieldType;
  inserted: boolean;
  fieldMeta?: { readOnly?: boolean } | null;
};

/**
 * The signer's fields that a signature adopted in the mobile "Sign Document"
 * bar is inserted into: every unsigned, editable SIGNATURE field. Pass the
 * visibility-filtered list, so a field hidden by an unmet condition is never
 * signed.
 *
 * When the owner requires re-auth per signature (passkey, password, 2FA), one
 * re-auth signs one field, the same as a field tap. The rest are tapped.
 */
export const getFieldsToSignWithAdoptedSignature = <T extends AdoptableField>(
  fields: T[],
  actionAuthTypes: string[],
): T[] => {
  const fieldsToSign = fields.filter(
    (field) => field.type === FieldType.SIGNATURE && !field.inserted && !field.fieldMeta?.readOnly,
  );

  const requiresReauthPerSignature = actionAuthTypes.some((type) => NON_AUTO_SIGNABLE_ACTION_AUTH_TYPES.includes(type));

  return requiresReauthPerSignature ? fieldsToSign.slice(0, 1) : fieldsToSign;
};

/**
 * Whether a field picked for the adopted signature can still be signed, read
 * against the CURRENT visibility-filtered fields right before its request. A
 * checkbox change while an earlier request is pending can hide a picked field;
 * the server rejects a hidden field, which would stop the batch, so it is
 * skipped instead and the remaining fields still get signed.
 */
export const isFieldStillSignable = (fieldId: number, currentFields: { id: number; inserted: boolean }[]) => {
  const field = currentFields.find((f) => f.id === fieldId);

  return field !== undefined && !field.inserted;
};
