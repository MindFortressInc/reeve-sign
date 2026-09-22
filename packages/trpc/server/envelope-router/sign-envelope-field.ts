import { isBase64Image } from '@documenso/lib/constants/signatures';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { validateFieldAuth } from '@documenso/lib/server-only/document/validate-field-auth';
import { finalizeFieldFileUpload } from '@documenso/lib/server-only/field/finalize-field-file-upload';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { parseFileUploadCustomText } from '@documenso/lib/types/field-file-upload';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { extractFieldInsertionValues } from '@documenso/lib/utils/envelope-signing';
import {
  findCompletedDependentsAffectedByControllerChange,
  isFieldVisible,
} from '@documenso/lib/utils/field-conditions';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, FieldType, RecipientRole, SigningStatus } from '@prisma/client';
import { match } from 'ts-pattern';

import { procedure } from '../trpc';
import { ZSignEnvelopeFieldRequestSchema, ZSignEnvelopeFieldResponseSchema } from './sign-envelope-field.types';

// Note that this is an unauthenticated public procedure route.
export const signEnvelopeFieldRoute = procedure
  .input(ZSignEnvelopeFieldRequestSchema)
  .output(ZSignEnvelopeFieldResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { user, metadata } = ctx;
    const { token, fieldId, fieldValue, authOptions } = input;

    ctx.logger.info({
      input: {
        fieldId,
      },
    });

    const recipient = await prisma.recipient.findFirst({
      where: {
        token,
      },
    });

    if (!recipient) {
      throw new AppError(AppErrorCode.NOT_FOUND);
    }

    // This initial lookup is for ROUTING only (which envelope to lock, whether
    // this recipient is even allowed to touch this field at all). Every
    // security-relevant property of `field` (type, fieldMeta, readOnly,
    // condition, recipientId) is re-read fresh under the lock below and
    // re-validated there — concurrent authoring could otherwise change any of
    // those between this read and the lock being acquired, and a decision
    // based on the stale value here would be wrong.
    const field = await prisma.field.findFirst({
      where: {
        id: fieldId,
        recipient: {
          ...(recipient.role === RecipientRole.ASSISTANT
            ? {
                signingStatus: {
                  not: SigningStatus.SIGNED,
                },
                signingOrder: {
                  gte: recipient.signingOrder ?? 0,
                },
                envelopeId: recipient.envelopeId,
              }
            : {
                id: recipient.id,
              }),
        },
      },
      include: {
        envelope: {
          include: {
            recipients: true,
            documentMeta: true,
          },
        },
        recipient: true,
      },
    });

    if (!field) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: `Field ${fieldId} not found`,
      });
    }

    const { envelope } = field;
    const { documentMeta } = envelope;

    if (envelope.internalVersion !== 2) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: `Envelope ${envelope.id} is not a version 2 envelope`,
      });
    }

    if (envelope.deletedAt) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Document ${envelope.id} has been deleted`,
      });
    }

    if (envelope.status !== DocumentStatus.PENDING) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Document ${envelope.id} must be pending for signing`,
      });
    }

    if (recipient.signingStatus === SigningStatus.SIGNED || field.recipient.signingStatus === SigningStatus.SIGNED) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Recipient ${recipient.id} has already signed`,
      });
    }

    // Cheap fast-fail on the stale snapshot (good error UX for the common,
    // non-racing case) — NOT authoritative. The transaction below re-validates
    // this exact check against `freshField` before anything is trusted or
    // written.
    if (fieldValue.type !== field.type) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Selected values do not match the field values',
      });
    }

    const assistant = recipient.role === RecipientRole.ASSISTANT ? recipient : undefined;

    // Extended transaction timeout: FILE_UPLOAD finalization does real S3 I/O
    // (see below) and must run inside the SAME lock as the rest of this
    // route's validation for that field-type check to actually close the race
    // — Prisma's default interactive-transaction timeout (5s) could otherwise
    // abort a legitimate slow upload finalization.
    return await prisma.$transaction(
      async (tx) => {
        // Take an exclusive lock on the envelope row before reading anything
        // that this write's condition checks depend on. `complete-document-with-token.ts`
        // takes the same lock before freezing a recipient's completion, so the
        // two can never interleave: whichever of "a controller changes" or "a
        // dependent recipient completes" commits first is fully visible to the
        // other by the time it re-reads under the lock. Without this, two
        // concurrent transactions could each read the other's stale pre-commit
        // state and both pass their own check, landing the envelope in an
        // inconsistent state (e.g. a checked "has a co-buyer" box with no
        // co-buyer signature).
        await tx.$queryRaw`SELECT id FROM "Envelope" WHERE id = ${envelope.id} FOR UPDATE`;

        // Re-verify every status check made above against fresh, lock-protected
        // state. Those earlier checks used a snapshot read before this
        // transaction (and before waiting for the lock) — without re-checking,
        // a request that began before its own recipient (or the document) was
        // completed elsewhere could sit waiting for the lock and then blindly
        // write a field for an already-signed recipient once it finally
        // acquires it.
        const freshEnvelope = await tx.envelope.findUniqueOrThrow({
          where: { id: envelope.id },
          select: { status: true, deletedAt: true, internalVersion: true, authOptions: true },
        });

        if (freshEnvelope.deletedAt) {
          throw new AppError(AppErrorCode.INVALID_REQUEST, {
            message: `Document ${envelope.id} has been deleted`,
          });
        }

        if (freshEnvelope.status !== DocumentStatus.PENDING) {
          throw new AppError(AppErrorCode.INVALID_REQUEST, {
            message: `Document ${envelope.id} must be pending for signing`,
          });
        }

        if (freshEnvelope.internalVersion !== 2) {
          throw new AppError(AppErrorCode.NOT_FOUND, {
            message: `Envelope ${envelope.id} is not a version 2 envelope`,
          });
        }

        const freshRecipient = await tx.recipient.findUniqueOrThrow({
          where: { id: recipient.id },
          select: { signingStatus: true },
        });

        const freshEnvelopeFields = await tx.field.findMany({ where: { envelopeId: envelope.id } });

        const freshField = freshEnvelopeFields.find((f) => f.id === fieldId);

        if (!freshField) {
          throw new AppError(AppErrorCode.NOT_FOUND, { message: `Field ${fieldId} not found` });
        }

        if (freshField.recipientId === null) {
          throw new Error(`Field ${fieldId} has no recipientId`);
        }

        const freshFieldOwner =
          freshField.recipientId === recipient.id
            ? freshRecipient
            : await tx.recipient.findUniqueOrThrow({
                where: { id: freshField.recipientId },
                select: { signingStatus: true },
              });

        if (
          freshRecipient.signingStatus === SigningStatus.SIGNED ||
          freshFieldOwner.signingStatus === SigningStatus.SIGNED
        ) {
          throw new AppError(AppErrorCode.INVALID_REQUEST, {
            message: `Recipient ${recipient.id} has already signed`,
          });
        }

        // Authoritative re-check of everything the pre-lock snapshot decided:
        // the field's TYPE (a concurrent authoring edit could have retyped it),
        // read-only, and the assistant/signature restriction — all against
        // `freshField`, never the stale `field`.
        if (fieldValue.type !== freshField.type) {
          throw new AppError(AppErrorCode.NOT_FOUND, {
            message: 'Selected values do not match the field values',
          });
        }

        if (
          freshField.type === FieldType.SIGNATURE &&
          recipient.id !== freshField.recipientId &&
          recipient.role === RecipientRole.ASSISTANT
        ) {
          throw new AppError(AppErrorCode.INVALID_REQUEST, {
            message: `Assistant recipients cannot sign signature fields`,
          });
        }

        if (freshField.fieldMeta?.readOnly) {
          throw new AppError(AppErrorCode.INVALID_REQUEST, {
            message: `Field ${fieldId} is read only`,
          });
        }

        // Authoritative auth check, against fresh field AND fresh document-level
        // auth options — both are mutable by a concurrent authoring edit
        // (`update-envelope.ts` can change document auth options while the
        // envelope is PENDING) and must be re-read under the lock, not taken
        // from the pre-lock snapshot's `envelope`.
        const derivedRecipientActionAuth = await validateFieldAuth({
          documentAuthOptions: freshEnvelope.authOptions,
          recipient,
          field: freshField,
          userId: user?.id,
          authOptions,
        });

        // Authoritative insertion-value derivation: resolves checkbox option
        // INDICES against `freshField.fieldMeta.values`, applies validation
        // rules (text length, number format, ...) against fresh metadata. Pure
        // and fast (no I/O) — safe to run inside the lock.
        const insertionValues = extractFieldInsertionValues({ fieldValue, field: freshField, documentMeta });

        const isUninserting = !insertionValues.inserted;

        // The client only ever submits a key from the TMP (presign-mintable)
        // key space. Never trust its claimed size/mimeType, and never persist
        // that key directly: a presigned PUT stays valid for up to an hour, so
        // without finalizing to a copy the client (or anyone who captured the
        // URL) could replay a PUT to the same key after the field is marked
        // signed and silently swap the accepted bytes with no new
        // authorization. `finalizeFieldFileUpload` re-verifies the ACTUAL
        // stored object against policy and copies it to a key no route ever
        // mints a PUT for before returning what actually gets persisted. Runs
        // inside the lock (not before it) so a concurrent authoring edit can't
        // retype this field out from under an in-flight upload finalization —
        // see the extended transaction timeout above.
        if (freshField.type === FieldType.FILE_UPLOAD && insertionValues.inserted) {
          const submittedUpload = parseFileUploadCustomText(insertionValues.customText);

          if (!submittedUpload) {
            throw new AppError(AppErrorCode.INVALID_BODY, {
              message: 'Invalid file upload value',
            });
          }

          insertionValues.customText = await finalizeFieldFileUpload({
            tmpKey: submittedUpload.key,
            fileName: submittedUpload.fileName,
            envelopeId: freshField.envelopeId,
            fieldId: freshField.id,
            claimedSize: submittedUpload.size,
            claimedMimeType: submittedUpload.mimeType,
          });
        }

        let signatureImageAsBase64 = null;
        let typedSignature = null;

        if (!isUninserting && freshField.type === FieldType.SIGNATURE) {
          if (fieldValue.type !== FieldType.SIGNATURE) {
            throw new AppError(AppErrorCode.INVALID_REQUEST, {
              message: `Field ${fieldId} is not a signature field`,
            });
          }

          if (fieldValue.value) {
            const isBase64 = isBase64Image(fieldValue.value);

            signatureImageAsBase64 = isBase64 ? fieldValue.value : null;
            typedSignature = !isBase64 ? fieldValue.value : null;
          }
        }

        const signedRecipientIds = new Set(
          (
            await tx.recipient.findMany({
              where: { envelopeId: envelope.id, signingStatus: SigningStatus.SIGNED },
              select: { id: true },
            })
          ).map((r) => r.id),
        );

        if (!isUninserting && !isFieldVisible(freshField, freshEnvelopeFields)) {
          throw new AppError(AppErrorCode.INVALID_REQUEST, {
            message: `Field ${fieldId} is not currently visible and cannot be signed`,
          });
        }

        if (freshField.type === FieldType.CHECKBOX) {
          const proposedCustomText = isUninserting ? '' : insertionValues.customText;

          const affectedCompletedDependents = findCompletedDependentsAffectedByControllerChange({
            controllerFieldId: freshField.id,
            proposedCustomText,
            allEnvelopeFields: freshEnvelopeFields,
            signedRecipientIds,
          });

          if (affectedCompletedDependents.length > 0) {
            throw new AppError(AppErrorCode.INVALID_REQUEST, {
              message:
                'This selection cannot be changed because it would alter a requirement or remove consent for a recipient who has already completed signing',
            });
          }
        }

        if (isUninserting) {
          const updatedField = await tx.field.update({
            where: {
              id: freshField.id,
            },
            data: {
              customText: '',
              inserted: false,
            },
          });

          await tx.signature.deleteMany({
            where: {
              fieldId: freshField.id,
            },
          });

          if (recipient.role !== RecipientRole.ASSISTANT) {
            await tx.documentAuditLog.create({
              data: createDocumentAuditLogData({
                type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_UNINSERTED,
                envelopeId: envelope.id,
                user: {
                  name: recipient.name,
                  email: recipient.email,
                },
                requestMetadata: metadata.requestMetadata,
                data: {
                  field: freshField.type,
                  fieldId: freshField.secondaryId,
                },
              }),
            });
          }

          return {
            signedField: updatedField,
          };
        }

        const updatedField = await tx.field.update({
          where: {
            id: freshField.id,
          },
          data: {
            customText: insertionValues.customText,
            inserted: insertionValues.inserted,
          },
          include: {
            signature: true,
          },
        });

        if (freshField.type === FieldType.SIGNATURE) {
          const signature = await tx.signature.upsert({
            where: {
              fieldId: freshField.id,
            },
            create: {
              fieldId: freshField.id,
              recipientId: freshField.recipientId,
              signatureImageAsBase64: signatureImageAsBase64,
              typedSignature: typedSignature,
            },
            update: {
              signatureImageAsBase64: signatureImageAsBase64,
              typedSignature: typedSignature,
            },
          });

          // Dirty but I don't want to deal with type information
          Object.assign(updatedField, {
            signature,
          });
        }

        await tx.documentAuditLog.create({
          data: createDocumentAuditLogData({
            type:
              assistant && freshField.recipientId !== assistant.id
                ? DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_PREFILLED
                : DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED,
            envelopeId: envelope.id,
            user: {
              email: assistant?.email ?? recipient.email,
              name: assistant?.name ?? recipient.name,
            },
            requestMetadata: metadata.requestMetadata,
            data: {
              recipientEmail: recipient.email,
              recipientId: recipient.id,
              recipientName: recipient.name,
              recipientRole: recipient.role,
              fieldId: updatedField.secondaryId,
              field: match(updatedField.type)
                .with(FieldType.SIGNATURE, FieldType.FREE_SIGNATURE, (type) => ({
                  type,
                  data: signatureImageAsBase64 || typedSignature || '',
                }))
                .with(FieldType.DATE, FieldType.EMAIL, FieldType.NAME, FieldType.TEXT, FieldType.INITIALS, (type) => ({
                  type,
                  data: updatedField.customText,
                }))
                .with(
                  FieldType.NUMBER,
                  FieldType.RADIO,
                  FieldType.CHECKBOX,
                  FieldType.DROPDOWN,
                  FieldType.FILE_UPLOAD,
                  (type) => ({
                    type,
                    data: updatedField.customText,
                  }),
                )
                .exhaustive(),
              fieldSecurity: derivedRecipientActionAuth
                ? {
                    type: derivedRecipientActionAuth,
                  }
                : undefined,
            },
          }),
        });

        return {
          signedField: updatedField,
        };
      },
      { timeout: 20000 },
    );
  });
