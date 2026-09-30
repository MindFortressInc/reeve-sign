import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import {
  FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES,
  FIELD_FILE_UPLOAD_SIZE_LIMIT_MB,
} from '@documenso/lib/types/field-file-upload';
import { buildFieldFileUploadTmpKey, getPresignPostUrlForKey } from '@documenso/lib/universal/upload/server-actions';

export type PresignFieldFileUploadOptions = {
  /** The envelope that owns the field — the tmp key is scoped to it. */
  envelopeId: string;
  fieldId: number;
  fileName: string;
  contentType: string;
  fileSize: number;
};

/**
 * The upload policy and presign mint shared by every route that hands a
 * client a FILE_UPLOAD PUT URL (the recipient-token route and the public
 * direct-template route). Callers own authorization — which field the caller
 * may upload to — and this owns everything about the upload itself, so a
 * policy change (type allowlist, size ceiling, presign TTL) lands on both.
 *
 * Only ever mints a TMP key: finalization to an immutable copy happens
 * server-side in `finalizeFieldFileUpload`.
 */
export const presignFieldFileUpload = async ({
  envelopeId,
  fieldId,
  fileName,
  contentType,
  fileSize,
}: PresignFieldFileUploadOptions): Promise<{ key: string; url: string }> => {
  if (
    !FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES.includes(contentType as (typeof FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES)[number])
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

  const key = buildFieldFileUploadTmpKey({ envelopeId, fieldId, fileName });

  // Bind ContentLength to the already-validated fileSize so the signed PUT
  // can't be used to upload past the size limit checked above.
  const { url } = await getPresignPostUrlForKey(key, contentType, fileSize);

  return { key, url };
};
