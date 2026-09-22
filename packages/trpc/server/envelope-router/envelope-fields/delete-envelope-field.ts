import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getEnvelopeWhereInput } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import {
  findFieldsWithDanglingConditions,
  partitionDanglingDependentsBySignedRecipient,
} from '@documenso/lib/utils/field-conditions';
import { canRecipientFieldsBeModified } from '@documenso/lib/utils/recipients';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, SigningStatus } from '@prisma/client';

import { ZGenericSuccessResponse } from '../../schema';
import { authenticatedProcedure } from '../../trpc';
import {
  deleteEnvelopeFieldMeta,
  ZDeleteEnvelopeFieldRequestSchema,
  ZDeleteEnvelopeFieldResponseSchema,
} from './delete-envelope-field.types';

export const deleteEnvelopeFieldRoute = authenticatedProcedure
  .meta(deleteEnvelopeFieldMeta)
  .input(ZDeleteEnvelopeFieldRequestSchema)
  .output(ZDeleteEnvelopeFieldResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { user, teamId, metadata } = ctx;
    const { fieldId } = input;

    ctx.logger.info({
      input: {
        fieldId,
      },
    });

    const unsafeField = await prisma.field.findUnique({
      where: {
        id: fieldId,
      },
      select: {
        envelopeId: true,
      },
    });

    if (!unsafeField) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Field not found',
      });
    }

    const { envelopeWhereInput } = await getEnvelopeWhereInput({
      id: {
        type: 'envelopeId',
        id: unsafeField.envelopeId,
      },
      type: null,
      userId: user.id,
      teamId,
    });

    const envelope = await prisma.envelope.findUnique({
      where: envelopeWhereInput,
      include: {
        recipients: {
          include: {
            fields: true,
          },
        },
      },
    });

    const recipientWithFields = envelope?.recipients.find((recipient) =>
      recipient.fields.some((field) => field.id === fieldId),
    );
    const fieldToDelete = recipientWithFields?.fields.find((field) => field.id === fieldId);

    if (!envelope || !recipientWithFields || !fieldToDelete) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Field not found',
      });
    }

    if (envelope.completedAt) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Envelope already complete',
      });
    }

    // Check whether the recipient associated with the field can have new fields created.
    if (!canRecipientFieldsBeModified(recipientWithFields, recipientWithFields.fields)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Recipient has already interacted with the document.',
      });
    }

    await prisma.$transaction(async (tx) => {
      // Lock the envelope row before re-reading anything this delete's
      // condition-integrity check depends on — the same lock
      // `sign-envelope-field.ts`/`complete-document-with-token.ts` take before
      // changing a controller or completing, so a concurrent completion can never
      // race this delete into leaving a signed recipient's field inconsistent.
      await tx.$queryRaw`SELECT id FROM "Envelope" WHERE id = ${envelope.id} FOR UPDATE`;

      const freshField = await tx.field.findUnique({ where: { id: fieldToDelete.id } });

      if (!freshField) {
        throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Field not found' });
      }

      const freshEnvelope = await tx.envelope.findUniqueOrThrow({
        where: { id: envelope.id },
        select: { completedAt: true },
      });

      if (freshEnvelope.completedAt) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Envelope already complete' });
      }

      const freshRecipients = await tx.recipient.findMany({
        where: { envelopeId: envelope.id },
        include: { fields: true },
      });

      const freshRecipientWithFields = freshRecipients.find((r) => r.fields.some((f) => f.id === fieldToDelete.id));

      if (
        !freshRecipientWithFields ||
        !canRecipientFieldsBeModified(freshRecipientWithFields, freshRecipientWithFields.fields)
      ) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'Recipient has already interacted with the document.',
        });
      }

      const allEnvelopeFields = freshRecipients.flatMap((r) => r.fields);
      const remainingFields = allEnvelopeFields.filter((field) => field.id !== fieldToDelete.id);

      // Scan for conditions that were ALREADY dangling before this delete (a
      // pre-existing malformed/dangling condition unrelated to the field being
      // deleted) so they can be excluded below — otherwise an unrelated deletion
      // could either silently self-heal a pre-existing broken condition that
      // wasn't its concern, or get wrongly rejected because that pre-existing
      // problem happens to belong to an already-signed recipient.
      const preExistingDanglingFieldIds = new Set(
        findFieldsWithDanglingConditions(allEnvelopeFields, allEnvelopeFields).map((field) => field.id),
      );

      // Any other field whose condition points at the one being deleted would
      // otherwise be left with a dangling reference.
      const danglingDependents = findFieldsWithDanglingConditions(remainingFields, remainingFields).filter(
        (field) => !preExistingDanglingFieldIds.has(field.id),
      );

      const signedRecipientIds = new Set(
        freshRecipients.filter((r) => r.signingStatus === SigningStatus.SIGNED).map((r) => r.id),
      );

      const { safeToClear, mustReject } = partitionDanglingDependentsBySignedRecipient(
        danglingDependents,
        signedRecipientIds,
      );

      if (mustReject.length > 0) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message:
            'This field cannot be deleted because it would change a requirement or remove consent for a recipient who has already completed signing',
        });
      }

      const deletedField = await tx.field.delete({
        where: {
          id: fieldToDelete.id,
          envelopeId: envelope.id,
        },
      });

      // Handle field deleted audit log.
      if (envelope.type === EnvelopeType.DOCUMENT) {
        await tx.documentAuditLog.create({
          data: createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_DELETED,
            envelopeId: envelope.id,
            metadata,
            data: {
              fieldId: deletedField.secondaryId,
              fieldRecipientEmail: recipientWithFields.email,
              fieldRecipientId: deletedField.recipientId,
              fieldType: deletedField.type,
            },
          }),
        });
      }

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

      return deletedField;
    });

    return ZGenericSuccessResponse;
  });
