import { FieldType } from '@prisma/client';

import { DocumentAuth } from '../types/document-auth';

export const AUTO_SIGNABLE_FIELD_TYPES: FieldType[] = [
  FieldType.NAME,
  FieldType.INITIALS,
  FieldType.EMAIL,
  FieldType.DATE,
];

// The action auth types that are not allowed to be auto signed
//
// Reasoning: If the action auth is a passkey or 2FA, it's likely that the owner of the document
// intends on having the user manually sign due to the additional security measures employed for
// other field types.
export const NON_AUTO_SIGNABLE_ACTION_AUTH_TYPES: string[] = [
  DocumentAuth.PASSKEY,
  DocumentAuth.PASSWORD,
  DocumentAuth.TWO_FACTOR_AUTH,
];
