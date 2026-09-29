import { presignDirectTemplateFieldFileUpload } from '@documenso/lib/server-only/template/presign-direct-template-field-file-upload';

import { maybeAuthenticatedProcedure } from '../trpc';
import {
  ZPresignDirectTemplateFieldFileUploadRequestSchema,
  ZPresignDirectTemplateFieldFileUploadResponseSchema,
} from './presign-direct-template-field-file-upload.types';

/**
 * Unauthenticated public procedure, scoped by the direct-link token. Private
 * (no OpenAPI meta), like `createDocumentFromDirectTemplate`, which consumes
 * the tmp key it mints. Abuse bounds are documented on
 * `presignDirectTemplateFieldFileUpload`.
 */
export const presignDirectTemplateFieldFileUploadRoute = maybeAuthenticatedProcedure
  .input(ZPresignDirectTemplateFieldFileUploadRequestSchema)
  .output(ZPresignDirectTemplateFieldFileUploadResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { directTemplateToken, fieldId, fileName, contentType, fileSize } = input;

    ctx.logger.info({
      input: { fieldId },
    });

    return await presignDirectTemplateFieldFileUpload({
      directTemplateToken,
      fieldId,
      fileName,
      contentType,
      fileSize,
      userId: ctx.user?.id,
      ipAddress: ctx.metadata.requestMetadata.ipAddress,
    });
  });
