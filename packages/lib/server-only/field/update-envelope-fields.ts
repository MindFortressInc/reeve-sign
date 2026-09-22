import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { TFieldMetaSchema } from '@documenso/lib/types/field-meta';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { createDocumentAuditLogData, diffFieldChanges } from '@documenso/lib/utils/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, type FieldType, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import {
  extractFieldCondition,
  findFieldsWithDanglingConditions,
  partitionDanglingDependentsBySignedRecipient,
  validateFieldConditionRef,
} from '../../utils/field-conditions';
import { mapFieldToLegacyField } from '../../utils/fields';
import { canRecipientFieldsBeModified } from '../../utils/recipients';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';

export interface UpdateEnvelopeFieldsOptions {
  userId: number;
  teamId: number;
  id: EnvelopeIdOptions;
  type?: EnvelopeType | null; // Only used to enforce the type.
  fields: {
    id: number;
    type?: FieldType;
    pageNumber?: number;
    envelopeItemId?: string;
    pageX?: number;
    pageY?: number;
    width?: number;
    height?: number;
    fieldMeta?: TFieldMetaSchema;
  }[];
  requestMetadata: ApiRequestMetadata;
}

export const updateEnvelopeFields = async ({
  userId,
  teamId,
  id,
  type = null,
  fields,
  requestMetadata,
}: UpdateEnvelopeFieldsOptions) => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    select: { id: true, type: true, secondaryId: true },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Envelope not found',
    });
  }

  const updatedFields = await prisma.$transaction(async (tx) => {
    // Lock the envelope row and re-read everything below fresh, so this write
    // can never race a concurrent controller mutation, completion, or another
    // authoring edit into leaving an already-signed recipient's field
    // inconsistent (dangling condition, or silently-altered requirement/consent).
    await tx.$queryRaw`SELECT id FROM "Envelope" WHERE id = ${envelope.id} FOR UPDATE`;

    const freshEnvelope = await tx.envelope.findUniqueOrThrow({
      where: { id: envelope.id },
      include: { recipients: true, fields: true, envelopeItems: true },
    });

    if (freshEnvelope.completedAt) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Envelope already complete',
      });
    }

    // The envelope's fields as they will exist once this whole batch is applied,
    // used as the reference graph for conditional-visibility validation so a
    // condition can validly reference another field being updated in the same
    // batch.
    const envelopeFieldsAfterUpdate = freshEnvelope.fields.map((existingField) => {
      const update = fields.find((field) => field.id === existingField.id);

      if (!update) {
        return existingField;
      }

      return {
        ...existingField,
        type: update.type ?? existingField.type,
        fieldMeta: update.fieldMeta !== undefined ? update.fieldMeta : existingField.fieldMeta,
      };
    });

    const fieldsToUpdate = fields.map((field) => {
      const originalField = freshEnvelope.fields.find((existingField) => existingField.id === field.id);

      if (!originalField) {
        throw new AppError(AppErrorCode.NOT_FOUND, {
          message: `Field with id ${field.id} not found`,
        });
      }

      const recipient = freshEnvelope.recipients.find((recipient) => recipient.id === originalField.recipientId);

      // Each field MUST have a recipient associated with it.
      if (!recipient) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: `Recipient attached to field ${field.id} not found`,
        });
      }

      // Check whether the recipient associated with the field can be modified.
      if (!canRecipientFieldsBeModified(recipient, freshEnvelope.fields)) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'Cannot modify a field where the recipient has already interacted with the document',
        });
      }

      const fieldType = field.type || originalField.type;
      const fieldMetaType = field.fieldMeta?.type || originalField.fieldMeta?.type;

      // Not going to mess with V1 envelopes.
      if (
        freshEnvelope.internalVersion === 2 &&
        fieldMetaType &&
        fieldMetaType.toLowerCase() !== fieldType.toLowerCase()
      ) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'Field meta type does not match the field type',
        });
      }

      if (field.envelopeItemId && !freshEnvelope.envelopeItems.some((item) => item.id === field.envelopeItemId)) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'Envelope item not found',
        });
      }

      const proposedConditionExtraction =
        field.fieldMeta !== undefined ? extractFieldCondition(field.fieldMeta) : undefined;

      if (proposedConditionExtraction?.present) {
        // Conditional visibility is V2-only: V1 rendering/signing never evaluates
        // it, so persisting one would be silently inert at best and misleading at
        // worst (the field would look unconditionally required in the V1 UI a
        // signer actually sees).
        if (freshEnvelope.internalVersion !== 2) {
          throw new AppError(AppErrorCode.INVALID_REQUEST, {
            message: 'Conditional visibility is only supported for V2 envelopes',
          });
        }

        if (!proposedConditionExtraction.valid) {
          throw new AppError(AppErrorCode.INVALID_REQUEST, {
            message: 'Conditional visibility is malformed',
          });
        }

        validateFieldConditionRef({
          targetFieldId: field.id,
          condition: proposedConditionExtraction.condition,
          envelopeFields: envelopeFieldsAfterUpdate,
        });
      }

      return {
        originalField,
        updateData: field,
        recipientEmail: recipient.email,
      };
    });

    // A field not in this update batch may have just had its controlling checkbox
    // retyped/removed, or lost the specific option it depends on. Cascade-clear
    // those dependents so no write ever leaves a dangling condition behind — UNLESS
    // the dependent belongs to an already-signed recipient, in which case silently
    // clearing it would alter their frozen obligations/consent, so the whole
    // update must be rejected instead.
    //
    // Only exclude fields whose OWN condition was actually re-validated above
    // (i.e. their `fieldMeta` was part of this batch) — a batch entry that only
    // moves a field's position (no `fieldMeta`) never ran through
    // `validateFieldConditionRef`, so its stored condition must still be
    // checked here even though the field's id is technically present in `fields`.
    const revalidatedFieldIds = new Set(
      fields.filter((field) => field.fieldMeta !== undefined).map((field) => field.id),
    );

    const danglingDependents = findFieldsWithDanglingConditions(
      envelopeFieldsAfterUpdate,
      envelopeFieldsAfterUpdate,
    ).filter((field) => !revalidatedFieldIds.has(field.id));

    const signedRecipientIds = new Set(
      freshEnvelope.recipients.filter((r) => r.signingStatus === SigningStatus.SIGNED).map((r) => r.id),
    );

    const { safeToClear, mustReject } = partitionDanglingDependentsBySignedRecipient(
      danglingDependents,
      signedRecipientIds,
    );

    if (mustReject.length > 0) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message:
          'This change cannot be applied because it would change a requirement or remove consent for a recipient who has already completed signing',
      });
    }

    const results = await Promise.all(
      fieldsToUpdate.map(async ({ originalField, updateData, recipientEmail }) => {
        const updatedField = await tx.field.update({
          where: {
            id: updateData.id,
          },
          data: {
            type: updateData.type,
            page: updateData.pageNumber,
            positionX: updateData.pageX,
            positionY: updateData.pageY,
            width: updateData.width,
            height: updateData.height,
            fieldMeta: updateData.fieldMeta,
            envelopeItemId: updateData.envelopeItemId,
          },
        });

        // Handle field updated audit log.
        if (envelope.type === EnvelopeType.DOCUMENT) {
          const changes = diffFieldChanges(originalField, updatedField);

          if (changes.length > 0) {
            await tx.documentAuditLog.create({
              data: createDocumentAuditLogData({
                type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_UPDATED,
                envelopeId: envelope.id,
                metadata: requestMetadata,
                data: {
                  fieldId: updatedField.secondaryId,
                  fieldRecipientEmail: recipientEmail,
                  fieldRecipientId: updatedField.recipientId,
                  fieldType: updatedField.type,
                  changes,
                },
              }),
            });
          }
        }

        return updatedField;
      }),
    );

    for (const dependent of safeToClear) {
      const currentMeta =
        typeof dependent.fieldMeta === 'object' && dependent.fieldMeta !== null ? dependent.fieldMeta : {};

      await tx.field.update({
        where: { id: dependent.id },
        data: {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          fieldMeta: { ...currentMeta, condition: null } as PrismaJson.FieldMeta,
        },
      });
    }

    return results;
  });

  return {
    fields: updatedFields.map((field) => mapFieldToLegacyField(field, envelope)),
  };
};
