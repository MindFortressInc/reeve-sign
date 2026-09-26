import { getServerLimits } from '@documenso/ee/server-only/limits/server';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { convertToPdf } from '@documenso/lib/server-only/document-conversion';
import { createEnvelope } from '@documenso/lib/server-only/envelope/create-envelope';
import { insertFormValuesInPdf } from '@documenso/lib/server-only/pdf/insert-form-values-in-pdf';
import { resolveOnBehalfOfUserId } from '@documenso/lib/server-only/reeve-admin/resolve-on-behalf-of-user';
import { putNormalizedPdfFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { EnvelopeType } from '@prisma/client';

import { authenticatedProcedure } from '../trpc';
import {
  createDocumentMeta,
  ZCreateDocumentRequestSchema,
  ZCreateDocumentResponseSchema,
} from './create-document.types';

export const createDocumentRoute = authenticatedProcedure
  .meta(createDocumentMeta)
  .input(ZCreateDocumentRequestSchema)
  .output(ZCreateDocumentResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { user, teamId } = ctx;

    const { payload, file } = input;

    const {
      title,
      externalId,
      visibility,
      globalAccessAuth,
      globalActionAuth,
      recipients,
      meta,
      folderId,
      formValues,
      attachments,
    } = payload;

    // DEV-12502: an API token may create the envelope on behalf of a member
    // of its team (403 otherwise), resolved before anything is stored.
    const onBehalfOfUserId =
      ctx.metadata.auth === 'api' ? await resolveOnBehalfOfUserId({ headers: ctx.req.headers, teamId }) : null;

    let pdf = await convertToPdf(file, ctx.logger);

    if (formValues) {
      // eslint-disable-next-line require-atomic-updates
      pdf = await insertFormValuesInPdf({
        pdf,
        formValues,
      });
    }

    const { id: documentDataId } = await putNormalizedPdfFileServerSide({
      name: file.name,
      type: 'application/pdf',
      arrayBuffer: async () => Promise.resolve(pdf),
    });

    ctx.logger.info({
      input: {
        folderId,
      },
    });

    const { remaining } = await getServerLimits({ userId: user.id, teamId });

    if (remaining.documents <= 0) {
      throw new AppError(AppErrorCode.LIMIT_EXCEEDED, {
        message: 'You have reached your document limit for this month. Please upgrade your plan.',
        statusCode: 400,
      });
    }

    const document = await createEnvelope({
      userId: onBehalfOfUserId ?? user.id,
      teamId,
      internalVersion: 1,
      data: {
        type: EnvelopeType.DOCUMENT,
        title,
        externalId,
        visibility,
        globalAccessAuth,
        globalActionAuth,
        formValues,
        recipients: (recipients || []).map((recipient) => ({
          ...recipient,
          fields: (recipient.fields || []).map((field) => ({
            ...field,
            page: field.pageNumber,
            positionX: field.pageX,
            positionY: field.pageY,
            documentDataId,
          })),
        })),
        folderId,
        envelopeItems: [
          {
            // If you ever allow more than 1 in this endpoint, make sure to use `maximumEnvelopeItemCount` to limit it.
            documentDataId,
          },
        ],
      },
      attachments,
      meta: {
        ...meta,
        emailSettings: meta?.emailSettings ?? undefined,
      },
      requestMetadata: ctx.metadata,
    });

    return {
      envelopeId: document.id,
      id: mapSecondaryIdToDocumentId(document.secondaryId),
    };
  });
