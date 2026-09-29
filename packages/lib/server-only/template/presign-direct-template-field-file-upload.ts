import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, FieldType } from '@prisma/client';
import { match } from 'ts-pattern';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DocumentAccessAuth } from '../../types/document-auth';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import { presignFieldFileUpload } from '../field/presign-field-file-upload';
import { assertRateLimit } from '../rate-limit/rate-limit-middleware';
import { directTemplateFileUploadRateLimit } from '../rate-limit/rate-limits';

export type PresignDirectTemplateFieldFileUploadOptions = {
  directTemplateToken: string;
  fieldId: number;
  fileName: string;
  contentType: string;
  fileSize: number;
  /** Set when the visitor is logged in — required for ACCOUNT-access templates. */
  userId?: number;
  ipAddress?: string;
};

/**
 * Mints a FILE_UPLOAD presigned PUT for a visitor of a public direct-template
 * link. There is no recipient row or session for this visitor yet (the
 * document only exists once they submit), so the link token is the only
 * credential, and anyone holding the URL has it. That makes this an
 * anonymous upload endpoint, bounded by:
 *
 * - `directTemplateFileUploadRateLimit` (per IP, and per link token), checked
 *   before any lookup so invalid tokens also spend budget;
 * - the direct recipient's own FILE_UPLOAD fields on that one template only;
 *   the tmp key is scoped to `<templateEnvelopeId>/<templateFieldId>`, and
 *   `createDocumentFromDirectTemplate` rejects any key outside that prefix;
 * - the shared upload policy in `presignFieldFileUpload` (type allowlist,
 *   size ceiling bound into the signed PUT);
 * - `finalizeFieldFileUpload` at submit time (real size/type and magic bytes);
 * - the tmp sweep, which deletes uploads that are never submitted.
 */
export const presignDirectTemplateFieldFileUpload = async ({
  directTemplateToken,
  fieldId,
  fileName,
  contentType,
  fileSize,
  userId,
  ipAddress,
}: PresignDirectTemplateFieldFileUploadOptions): Promise<{ key: string; url: string }> => {
  const rateLimitResult = await directTemplateFileUploadRateLimit.check({
    ip: ipAddress ?? 'unknown',
    identifier: directTemplateToken,
  });

  assertRateLimit(rateLimitResult);

  // Same lookup `getEnvelopeForDirectTemplateSigning` serves the page from.
  const envelope = await prisma.envelope.findFirst({
    where: {
      type: EnvelopeType.TEMPLATE,
      status: DocumentStatus.DRAFT,
      deletedAt: null,
      directLink: {
        enabled: true,
        token: directTemplateToken,
      },
    },
    select: {
      id: true,
      internalVersion: true,
      authOptions: true,
      directLink: {
        select: {
          directTemplateRecipientId: true,
        },
      },
    },
  });

  if (!envelope?.directLink) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Template not found' });
  }

  if (envelope.internalVersion !== 2) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'File uploads are only supported on version 2 templates',
    });
  }

  const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
    documentAuth: envelope.authOptions,
  });

  // Mirrors `createDocumentFromDirectTemplate`'s access check, so nothing can
  // be uploaded for a submission that would be refused anyway.
  const isAccessAuthValid = match(derivedRecipientAccessAuth.at(0))
    .with(DocumentAccessAuth.ACCOUNT, () => userId !== undefined)
    .with(DocumentAccessAuth.TWO_FACTOR_AUTH, () => false) // Not supported for direct templates
    .with(undefined, () => true)
    .exhaustive();

  if (!isAccessAuthValid) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, { message: 'You must be logged in' });
  }

  const field = await prisma.field.findFirst({
    where: {
      id: fieldId,
      envelopeId: envelope.id,
      recipientId: envelope.directLink.directTemplateRecipientId,
    },
  });

  if (!field) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: `Field ${fieldId} not found`,
    });
  }

  if (field.type !== FieldType.FILE_UPLOAD) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Field ${fieldId} is not a file upload field`,
    });
  }

  if (field.fieldMeta?.readOnly) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Field ${fieldId} is read only`,
    });
  }

  return await presignFieldFileUpload({
    envelopeId: envelope.id,
    fieldId: field.id,
    fileName,
    contentType,
    fileSize,
  });
};
