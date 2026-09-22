import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import {
  FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES,
  FIELD_FILE_UPLOAD_SIZE_LIMIT_MB,
} from '@documenso/lib/types/field-file-upload';
import { buildFieldFileUploadTmpKey, getPresignPostUrlForKey } from '@documenso/lib/universal/upload/server-actions';
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

    if (
      !FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES.includes(
        contentType as (typeof FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES)[number],
      )
    ) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `File type ${contentType} is not allowed`,
      });
    }

    if (fileSize > FIELD_FILE_UPLOAD_SIZE_LIMIT_MB * 1024 * 1024) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `File exceeds the ${FIELD_FILE_UPLOAD_SIZE_LIMIT_MB}MB limit`,
      });
    }

    // A tmp key only — the presign route must never mint a PUT for a
    // finalized key (see field-file-upload.ts). Finalization to an
    // immutable copy happens server-side in sign-envelope-field.ts.
    const key = buildFieldFileUploadTmpKey({ envelopeId: field.envelopeId, fieldId: field.id, fileName });

    // Bind ContentLength to the already-validated fileSize so the signed PUT
    // can't be used to upload past the size limit checked above.
    const { url } = await getPresignPostUrlForKey(key, contentType, fileSize);

    return { key, url };
  });
