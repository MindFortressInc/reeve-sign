import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { parseFileUploadCustomText } from '@documenso/lib/types/field-file-upload';
import { getPresignGetUrl } from '@documenso/lib/universal/upload/server-actions';
import { buildSafeAttachmentContentDisposition } from '@documenso/lib/utils/safe-content-disposition';
import { buildTeamWhereQuery } from '@documenso/lib/utils/teams';
import { prisma } from '@documenso/prisma';
import { FieldType } from '@prisma/client';

import { authenticatedProcedure } from '../../trpc';
import {
  getEnvelopeFieldFileDownloadUrlMeta,
  ZGetEnvelopeFieldFileDownloadUrlRequestSchema,
  ZGetEnvelopeFieldFileDownloadUrlResponseSchema,
} from './get-envelope-field-file-download-url.types';

/**
 * Team-authenticated download — the envelope owner can download any
 * FILE_UPLOAD field on an envelope owned by their team. Never accepts a
 * client-supplied key: the S3 key always comes from the field's own
 * server-persisted (finalized) `customText`.
 */
export const getEnvelopeFieldFileDownloadUrlRoute = authenticatedProcedure
  .meta(getEnvelopeFieldFileDownloadUrlMeta)
  .input(ZGetEnvelopeFieldFileDownloadUrlRequestSchema)
  .output(ZGetEnvelopeFieldFileDownloadUrlResponseSchema)
  .query(async ({ input, ctx }) => {
    const { fieldId } = input;
    const { teamId } = ctx;
    const userId = ctx.user.id;

    ctx.logger.info({
      input: { fieldId },
    });

    const field = await prisma.field.findFirst({
      where: {
        id: fieldId,
        envelope: {
          team: buildTeamWhereQuery({ teamId, userId }),
        },
      },
      include: {
        envelope: true,
      },
    });

    if (!field) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: `Field ${fieldId} not found`,
      });
    }

    if (field.envelope.deletedAt) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Document ${field.envelope.id} has been deleted`,
      });
    }

    if (field.type !== FieldType.FILE_UPLOAD || !field.inserted) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Field ${fieldId} has no uploaded file`,
      });
    }

    const uploadedFile = parseFileUploadCustomText(field.customText);

    if (!uploadedFile) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: 'Invalid file upload value',
      });
    }

    const { url } = await getPresignGetUrl(uploadedFile.key, {
      responseContentDisposition: buildSafeAttachmentContentDisposition(uploadedFile.fileName),
    });

    return { url, fileName: uploadedFile.fileName };
  });
