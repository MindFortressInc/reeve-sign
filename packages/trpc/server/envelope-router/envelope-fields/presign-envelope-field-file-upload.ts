import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { presignFieldFileUpload } from '@documenso/lib/server-only/field/presign-field-file-upload';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, FieldType, RecipientRole, SigningStatus } from '@prisma/client';

import { procedure } from '../../trpc';
import {
  presignEnvelopeFieldFileUploadMeta,
  ZPresignEnvelopeFieldFileUploadRequestSchema,
  ZPresignEnvelopeFieldFileUploadResponseSchema,
} from './presign-envelope-field-file-upload.types';

/**
 * Unauthenticated public procedure, scoped by recipient token — same shape
 * as `sign-envelope-field.ts`'s ownership + envelope-state guard sequence.
 * Deliberately NOT extracted into a shared helper in this PR to avoid
 * touching that route's well-covered signing path; a consolidation
 * follow-up is tracked in DEV-4820.
 */
export const presignEnvelopeFieldFileUploadRoute = procedure
  .meta(presignEnvelopeFieldFileUploadMeta)
  .input(ZPresignEnvelopeFieldFileUploadRequestSchema)
  .output(ZPresignEnvelopeFieldFileUploadResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { token, fieldId, fileName, contentType, fileSize } = input;

    ctx.logger.info({
      input: { fieldId },
    });

    const recipient = await prisma.recipient.findFirst({
      where: { token },
    });

    if (!recipient) {
      throw new AppError(AppErrorCode.NOT_FOUND);
    }

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
        envelope: true,
        recipient: true,
      },
    });

    if (!field) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: `Field ${fieldId} not found`,
      });
    }

    const { envelope } = field;

    if (envelope.internalVersion !== 2) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: `Envelope ${envelope.id} is not a version 2 envelope`,
      });
    }

    if (field.type !== FieldType.FILE_UPLOAD) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Field ${fieldId} is not a file upload field`,
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

    if (field.fieldMeta?.readOnly) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Field ${fieldId} is read only`,
      });
    }

    // Upload policy (type allowlist, size ceiling) and the tmp-key mint are
    // shared with the public direct-template presign route.
    return await presignFieldFileUpload({
      envelopeId: field.envelopeId,
      fieldId: field.id,
      fileName,
      contentType,
      fileSize,
    });
  });
