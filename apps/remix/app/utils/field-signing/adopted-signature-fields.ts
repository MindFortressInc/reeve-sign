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
