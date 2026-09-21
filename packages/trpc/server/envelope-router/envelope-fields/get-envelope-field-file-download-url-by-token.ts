import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { parseFileUploadCustomText } from '@documenso/lib/types/field-file-upload';
import { getPresignGetUrl } from '@documenso/lib/universal/upload/server-actions';
import { buildSafeAttachmentContentDisposition } from '@documenso/lib/utils/safe-content-disposition';
import { prisma } from '@documenso/prisma';
import { FieldType } from '@prisma/client';

import { procedure } from '../../trpc';
import {
  getEnvelopeFieldFileDownloadUrlByTokenMeta,
  ZGetEnvelopeFieldFileDownloadUrlByTokenRequestSchema,
  ZGetEnvelopeFieldFileDownloadUrlByTokenResponseSchema,
} from './get-envelope-field-file-download-url-by-token.types';

/**
 * Recipient-facing download — any recipient of the SAME envelope as the
 * field can download it (mirrors `findAttachmentsByToken`'s envelope-scoped
 * token check, and the existing token-scoped PDF file download route's
 * `recipients: { some: { token } }` pattern — see
 * `apps/remix/server/api/files/routes/get-envelope-item-pdf-by-token.ts`),
 * not just the recipient the field belongs to, since a signed envelope's
 * other recipients/the uploader may want to review the attachment during
 * or after signing. Mirrors the same envelope-state guards the sign/presign
 * routes apply (not deleted, v2 envelope) rather than trusting the token
 * match alone. Never accepts a client-supplied key: the S3 key always comes
 * from the field's own server-persisted (finalized) `customText`.
 */
export const getEnvelopeFieldFileDownloadUrlByTokenRoute = procedure
  .meta(getEnvelopeFieldFileDownloadUrlByTokenMeta)
  .input(ZGetEnvelopeFieldFileDownloadUrlByTokenRequestSchema)
  .output(ZGetEnvelopeFieldFileDownloadUrlByTokenResponseSchema)
  .query(async ({ input, ctx }) => {
    const { token, fieldId } = input;

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
        envelopeId: recipient.envelopeId,
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

    if (field.envelope.internalVersion !== 2) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: `Envelope ${field.envelope.id} is not a version 2 envelope`,
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
