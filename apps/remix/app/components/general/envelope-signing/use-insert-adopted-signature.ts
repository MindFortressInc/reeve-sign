import type { TRecipientActionAuth } from '@documenso/lib/types/document-auth';
import { FieldType } from '@prisma/client';
import { useRef, useState } from 'react';

import {
  getFieldsToSignWithAdoptedSignature,
  isFieldStillSignable,
} from '~/utils/field-signing/adopted-signature-fields';

import { useRequiredDocumentSigningAuthContext } from '../document-signing/document-signing-auth-provider';
import { useRequiredEnvelopeSigningContext } from '../document-signing/envelope-signing-provider';
import { useSignEnvelopeField } from './use-sign-envelope-field';

/**
 * DEV-20648: inserts a signature adopted in the mobile "Sign Document" bar into
 * the signer's unsigned signature fields. On mobile that box is where signers
 * expect to sign; upstream only kept it as the default for a later field tap.
 */
export const useInsertAdoptedSignature = () => {
  const { recipientFields } = useRequiredEnvelopeSigningContext();
  const { executeActionAuthProcedure, derivedRecipientActionAuth } = useRequiredDocumentSigningAuthContext();

  // The batch runs across several awaits; read the latest visible fields
  // before each request, not the ones captured when the signer adopted.
  const recipientFieldsRef = useRef(recipientFields);
  recipientFieldsRef.current = recipientFields;

  const signField = useSignEnvelopeField();

  const [isInserting, setIsInserting] = useState(false);

  const insertAdoptedSignature = (value: string) => {
    const fieldsToSign = getFieldsToSignWithAdoptedSignature(recipientFields, derivedRecipientActionAuth);

    if (!value || fieldsToSign.length === 0) {
      return;
    }

    // A failed field keeps the auth dialog open for a retry; skip the fields
    // that already succeeded so they are not signed twice.
    const signedFieldIds = new Set<number>();

    void executeActionAuthProcedure({
      actionTarget: FieldType.SIGNATURE,
      onReauthFormSubmit: async (authOptions?: TRecipientActionAuth) => {
        setIsInserting(true);

        try {
          for (const field of fieldsToSign) {
            if (signedFieldIds.has(field.id) || !isFieldStillSignable(field.id, recipientFieldsRef.current)) {
              continue;
            }

            await signField(field.id, { type: FieldType.SIGNATURE, value }, authOptions);

            signedFieldIds.add(field.id);
          }
        } finally {
          setIsInserting(false);
        }
      },
    });
  };

  return { insertAdoptedSignature, isInserting };
};
