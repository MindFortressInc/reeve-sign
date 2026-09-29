import { presignDirectTemplateFieldFileUpload } from '@documenso/lib/server-only/template/presign-direct-template-field-file-upload';
import { getTrustedIpAddress } from '@documenso/lib/universal/get-ip-address';

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
      // Not `requestMetadata.ipAddress`: that is the client-controlled first
      // X-Forwarded-For entry, which would let a caller rotate past the
      // per-IP limit and burn the per-token budget.
      ipAddress: getTrustedIpAddress(ctx.req),
    });
  });
