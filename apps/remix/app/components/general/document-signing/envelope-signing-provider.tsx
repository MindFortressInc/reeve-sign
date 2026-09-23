import { DEFAULT_DOCUMENT_DATE_FORMAT } from '@documenso/lib/constants/date-formats';
import { isBase64Image } from '@documenso/lib/constants/signatures';
import { DEFAULT_DOCUMENT_TIME_ZONE } from '@documenso/lib/constants/time-zones';
import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import type { EnvelopeForSigningResponse } from '@documenso/lib/server-only/envelope/get-envelope-for-recipient-signing';
import type { TRecipientActionAuth } from '@documenso/lib/types/document-auth';
import { isFieldUnsignedAndRequired, isRequiredField } from '@documenso/lib/utils/advanced-fields-helpers';
import { extractFieldInsertionValues } from '@documenso/lib/utils/envelope-signing';
import { filterVisibleFields, isFieldVisible } from '@documenso/lib/utils/field-conditions';
import { trpc } from '@documenso/trpc/react';
import type { TSignEnvelopeFieldValue } from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';
import { EnvelopeType, type Field, FieldType, type Recipient, RecipientRole, SigningStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { createContext, useContext, useMemo, useState } from 'react';
import { prop, sortBy } from 'remeda';

export type EnvelopeSigningContextValue = {
  isDirectTemplate: boolean;

  fullName: string;
  setFullName: (_value: string) => void;
  email: string;
  setEmail: (_value: string) => void;
  signature: string | null;
  setSignature: (_value: string | null) => void;

  showPendingFieldTooltip: boolean;
  setShowPendingFieldTooltip: (_value: boolean) => void;

  envelopeData: EnvelopeForSigningResponse;
  envelope: EnvelopeForSigningResponse['envelope'];

  recipient: EnvelopeForSigningResponse['recipient'];
  recipientFieldsRemaining: Field[];
  recipientFields: Field[];
  requiredRecipientFields: Field[];
  selectedAssistantRecipientFields: Field[];
  nextRecipient: EnvelopeForSigningResponse['envelope']['recipients'][number] | null;
  otherRecipientCompletedFields: (Field & {
    recipient: Pick<Recipient, 'name' | 'email' | 'signingStatus' | 'role'>;
  })[];
  assistantRecipients: EnvelopeForSigningResponse['envelope']['recipients'];
  assistantFields: Field[];
  setSelectedAssistantRecipientId: (_value: number | null) => void;
  selectedAssistantRecipient: EnvelopeForSigningResponse['envelope']['recipients'][number] | null;

  signField: (
    _fieldId: number,
    _value: TSignEnvelopeFieldValue,
    authOptions?: TRecipientActionAuth,
  ) => Promise<Pick<Field, 'id' | 'inserted'>>;
};

const EnvelopeSigningContext = createContext<EnvelopeSigningContextValue | null>(null);

export const useEnvelopeSigningContext = () => {
  return useContext(EnvelopeSigningContext);
};

export const useRequiredEnvelopeSigningContext = () => {
  const context = useEnvelopeSigningContext();

  if (!context) {
    throw new Error('Signing context is required');
  }

  return context;
};

export interface EnvelopeSigningProviderProps {
  fullName?: string | null;
  email?: string | null;
  signature?: string | null;
  envelopeData: EnvelopeForSigningResponse;
  children: React.ReactNode;
}

/**
 * Inject prefilled date fields for the current recipient.
 *
 * The dates are filled in correctly when the recipient "completes" the document.
 */
const prefillDateFields = (data: EnvelopeForSigningResponse): EnvelopeForSigningResponse => {
  const { timezone, dateFormat } = data.envelope.documentMeta;

  const formattedDate = DateTime.now()
    .setZone(timezone ?? DEFAULT_DOCUMENT_TIME_ZONE)
    .toFormat(dateFormat ?? DEFAULT_DOCUMENT_DATE_FORMAT);

  const prefillField = <T extends { type: FieldType; inserted: boolean; customText: string; fieldMeta: unknown }>(
    field: T,
  ): T => {
    if (field.type !== FieldType.DATE || field.inserted) {
      return field;
    }

    return {
      ...field,
      customText: formattedDate,
      inserted: true,
      fieldMeta: {
        ...(typeof field.fieldMeta === 'object' ? field.fieldMeta : {}),
        readOnly: true,
      },
    };
  };

  return {
    ...data,
    envelope: {
      ...data.envelope,
      recipients: data.envelope.recipients.map((recipient) => ({
        ...recipient,
        fields: recipient.fields.map(prefillField),
      })),
    },
    recipient: {
      ...data.recipient,
      fields: data.recipient.fields.map(prefillField),
    },
  };
};

export const EnvelopeSigningProvider = ({
  fullName: initialFullName,
  email: initialEmail,
  signature: initialSignature,
  envelopeData: initialEnvelopeData,
  children,
}: EnvelopeSigningProviderProps) => {
  const [envelopeData, setEnvelopeData] = useState(() => prefillDateFields(initialEnvelopeData));

  const { envelope, recipient } = envelopeData;

  const [fullName, setFullName] = useState(initialFullName || '');
  const [email, setEmail] = useState(initialEmail || '');

  const [showPendingFieldTooltip, setShowPendingFieldTooltip] = useState(false);

  const isDirectTemplate = envelope.type === EnvelopeType.TEMPLATE;

  const { mutateAsync: signEnvelopeField } = trpc.envelope.field.sign.useMutation({
    ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
    onSuccess: (data) => {
      setEnvelopeData((prev) => ({
        ...prev,
        envelope: {
          ...prev.envelope,
          recipients: prev.envelope.recipients.map((recipient) =>
            recipient.id === data.signedField.recipientId
              ? {
                  ...recipient,
                  fields: recipient.fields.map((field) =>
                    field.id === data.signedField.id ? data.signedField : field,
                  ),
                }
              : recipient,
          ),
        },
        recipient: {
          ...prev.recipient,
          fields: prev.recipient.fields.map((field) => (field.id === data.signedField.id ? data.signedField : field)),
        },
      }));
    },
  });

  // Ensure the user signature doesn't show up if it's not allowed.
  const [signature, setSignature] = useState(
    (() => {
      const sig = initialSignature || '';
      const isBase64 = isBase64Image(sig);

      if (
        !sig &&
        (envelope.documentMeta.uploadSignatureEnabled || envelope.documentMeta.drawSignatureEnabled) &&
        envelopeData.recipientSignature?.signatureImageAsBase64
      ) {
        return envelopeData.recipientSignature.signatureImageAsBase64;
      }

      if (!sig && envelope.documentMeta.typedSignatureEnabled && envelopeData.recipientSignature?.typedSignature) {
        return envelopeData.recipientSignature.typedSignature;
      }

      if (isBase64 && (envelope.documentMeta.uploadSignatureEnabled || envelope.documentMeta.drawSignatureEnabled)) {
        return sig;
      }

      if (!isBase64 && envelope.documentMeta.typedSignatureEnabled) {
        return sig;
      }

      return null;
    })(),
  );

  /**
   * Every field in the envelope, across all recipients — the reference graph
   * conditional visibility is resolved against. Recomputed whenever any
   * recipient's fields change (e.g. right after this recipient — or, for an
   * already-committed controller, another recipient earlier in signing order —
   * inserts/clears a checkbox), so a controlling checkbox reveals/hides its
   * dependents on the same render, with no extra round trip.
   */
  const allEnvelopeFields = useMemo(() => envelope.recipients.flatMap((r) => r.fields), [envelope.recipients]);

  /**
   * The fields that are still required to be signed by the actual recipient.
   * Excludes fields currently hidden by an unmet (or invalid — fail closed,
   * consistent with the server-side lenient read) conditional visibility.
   */
  const recipientFieldsRemaining = useMemo(() => {
    const requiredFields = envelopeData.recipient.fields
      .filter((field) => isFieldUnsignedAndRequired(field) && isFieldVisible(field, allEnvelopeFields))
      .map((field) => {
        const envelopeItem = envelope.envelopeItems.find((item) => item.id === field.envelopeItemId);

        if (!envelopeItem) {
          throw new Error('Missing envelope item');
        }

        return {
          ...field,
          envelopeItemOrder: envelopeItem.order,
        };
      });

    return sortBy(
      requiredFields,
      [prop('envelopeItemOrder'), 'asc'],
      [prop('page'), 'asc'],
      [prop('positionY'), 'asc'],
    );
  }, [envelopeData.recipient.fields, allEnvelopeFields]);

  /**
   * All the required fields for the actual recipient, excluding any currently
   * hidden by an unmet condition.
   */
  const requiredRecipientFields = useMemo(() => {
    return envelopeData.recipient.fields.filter(
      (field) => isRequiredField(field) && isFieldVisible(field, allEnvelopeFields),
    );
  }, [envelopeData.recipient.fields, allEnvelopeFields]);

  /**
   * All CURRENTLY VISIBLE fields for the actual recipient. This is the single
   * choke point that makes conditional visibility "native and immediate" on the
   * client: `EnvelopeSignerPageRenderer` renders exactly this list, so a field
   * hidden by an unmet condition is never drawn on the Konva canvas at all (not
   * merely styled hidden), and reveals the instant its controller's value
   * changes in local state — no server round trip required to see it appear.
   */
  const recipientFields = useMemo(() => {
    return filterVisibleFields(envelopeData.recipient.fields, allEnvelopeFields);
  }, [envelopeData.recipient.fields, allEnvelopeFields]);

  /**
   * Assistant recipients are those that have a signing order after the assistant.
   */
  const assistantRecipients =
    recipient.role === RecipientRole.ASSISTANT
      ? envelope.recipients.filter((r) => (r.signingOrder ?? 0) > (recipient.signingOrder ?? 0))
      : [];

  /**
   * Assistant fields are those fulfill all of the following:
   * - From recipients that have not signed
   * - After the assistant signing order
   * - Are not signature fields
   * - Currently visible (an assistant must never see, or be able to fill in on
   *   behalf of someone else, a field that recipient's own view would hide)
   */
  const assistantFields =
    recipient.role === RecipientRole.ASSISTANT
      ? assistantRecipients
          .filter((r) => r.signingStatus !== SigningStatus.SIGNED)
          .flatMap((r) => r.fields.filter((field) => field.type !== FieldType.SIGNATURE))
          .filter((field) => isFieldVisible(field, allEnvelopeFields))
      : [];

  /**
   * The recipient that the assistant has currently selected to sign on behalf of.
   */
  const [selectedAssistantRecipientId, setSelectedAssistantRecipientId] = useState<number | null>(
    assistantRecipients[0]?.id || null,
  );

  const selectedAssistantRecipient = useMemo(() => {
    return envelope.recipients.find((r) => r.id === selectedAssistantRecipientId) || null;
  }, [envelope.recipients, selectedAssistantRecipientId]);

  const selectedAssistantRecipientFields = useMemo(() => {
    return assistantFields.filter((field) => field.recipientId === selectedAssistantRecipient?.id);
  }, [recipientFields, selectedAssistantRecipient]);

  /**
   * Fields that have been completed by other recipients.
   */
  const otherRecipientCompletedFields = envelope.recipients
    .filter(({ signingStatus }) => signingStatus === SigningStatus.SIGNED)
    .flatMap((recipient) =>
      recipient.fields.map((field) => ({
        ...field,
        recipient: {
          name: recipient.name,
          email: recipient.email,
          signingStatus: recipient.signingStatus,
          role: recipient.role,
        },
      })),
    )
    .filter((field) => field.inserted && isFieldVisible(field, allEnvelopeFields));

  const nextRecipient = useMemo(() => {
    if (!envelope.documentMeta.signingOrder || envelope.documentMeta.signingOrder !== 'SEQUENTIAL') {
      return null;
    }

    const sortedRecipients = envelope.recipients.sort((a, b) => {
      // Sort by signingOrder first (nulls last), then by id
      if (a.signingOrder === null && b.signingOrder === null) {
        return a.id - b.id;
      }
      if (a.signingOrder === null) {
        return 1;
      }
      if (b.signingOrder === null) {
        return -1;
      }
      if (a.signingOrder === b.signingOrder) {
        return a.id - b.id;
      }
      return a.signingOrder - b.signingOrder;
    });

    const currentIndex = sortedRecipients.findIndex((r) => r.id === recipient.id);

    return currentIndex !== -1 && currentIndex < sortedRecipients.length - 1
      ? sortedRecipients[currentIndex + 1]
      : null;
  }, [envelope.documentMeta?.signingOrder, envelope.recipients, recipient.id]);

  const signField = async (
    fieldId: number,
    fieldValue: TSignEnvelopeFieldValue,
    authOptions?: TRecipientActionAuth,
  ) => {
    // Set the field locally for direct templates.
    if (isDirectTemplate) {
      const signedField = handleDirectTemplateFieldInsertion(fieldId, fieldValue);

      return signedField;
    }

    const { signedField } = await signEnvelopeField({
      token: envelopeData.recipient.token,
      fieldId,
      fieldValue,
      authOptions,
    });

    return signedField;
  };

  const handleDirectTemplateFieldInsertion = (fieldId: number, fieldValue: TSignEnvelopeFieldValue) => {
    const foundField = recipient.fields.find((field) => field.id === fieldId);

    if (!foundField) {
      throw new Error('Not possible');
    }

    const insertionValues = extractFieldInsertionValues({
      fieldValue,
      field: foundField,
      documentMeta: envelope.documentMeta,
    });

    const updatedField = {
      ...foundField,
      ...insertionValues,
    };

    if (fieldValue.type === FieldType.SIGNATURE) {
      const isBase64 = isBase64Image(fieldValue.value || '');

      updatedField.signature = fieldValue.value
        ? {
            signatureImageAsBase64: isBase64 ? fieldValue.value : null,
            typedSignature: isBase64 ? null : fieldValue.value,
            recipientId: recipient.id,
            created: new Date(),
            // Dummy IDs.
            id: 0,
            fieldId: 0,
          }
        : null;
    }

    setEnvelopeData((prev) => ({
      ...prev,
      envelope: {
        ...prev.envelope,
        recipients: prev.envelope.recipients.map((r) =>
          r.id === recipient.id
            ? {
                ...r,
                fields: r.fields.map((field) => (field.id === fieldId ? updatedField : field)),
              }
            : r,
        ),
      },
      recipient: {
        ...prev.recipient,
        fields: prev.recipient.fields.map((field) => (field.id === fieldId ? updatedField : field)),
      },
    }));

    return updatedField;
  };

  return (
    <EnvelopeSigningContext.Provider
      value={{
        isDirectTemplate,
        fullName,
        setFullName,
        email,
        setEmail,
        signature,
        setSignature,
        envelopeData,
        envelope,

        showPendingFieldTooltip,
        setShowPendingFieldTooltip,

        recipient,
        recipientFieldsRemaining,
        recipientFields,
        requiredRecipientFields,
        nextRecipient,

        otherRecipientCompletedFields,
        assistantRecipients,
        assistantFields,
        setSelectedAssistantRecipientId,
        selectedAssistantRecipient,
        selectedAssistantRecipientFields,

        signField,
      }}
    >
      {children}
    </EnvelopeSigningContext.Provider>
  );
};

EnvelopeSigningProvider.displayName = 'EnvelopeSigningProvider';
