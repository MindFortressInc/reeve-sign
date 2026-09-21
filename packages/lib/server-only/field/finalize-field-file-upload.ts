import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import {
  FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES,
  FIELD_FILE_UPLOAD_SIZE_LIMIT_MB,
  toFileUploadCustomText,
} from '@documenso/lib/types/field-file-upload';
import {
  buildFinalizedFieldFileUploadKey,
  copyS3File,
  deleteS3File,
  headS3File,
} from '@documenso/lib/universal/upload/server-actions';

export type FinalizeFieldFileUploadOptions = {
  /** The tmp key the recipient's presigned PUT was minted for. */
  tmpKey: string;
  fileName: string;
  envelopeId: string;
  fieldId: number;
  /** Client-claimed values from the sign payload — verified, never trusted. */
  claimedSize: number;
  claimedMimeType: string;
};

type HeadResult = { exists: boolean; size: number | null; contentType: string | null };

const assertHeadSatisfiesPolicy = (head: HeadResult, notFoundMessage: string) => {
  if (!head.exists) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: notFoundMessage });
  }

  if (
    !head.contentType ||
    !FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES.includes(
      head.contentType as (typeof FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES)[number],
    )
  ) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'Uploaded file type is not allowed',
    });
  }

  if (head.size === null || head.size > FIELD_FILE_UPLOAD_SIZE_LIMIT_MB * 1024 * 1024) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: `Uploaded file exceeds the ${FIELD_FILE_UPLOAD_SIZE_LIMIT_MB}MB limit`,
    });
  }
};

/**
 * Verifies the ACTUAL uploaded object — never the client-submitted
 * size/mimeType — against policy, then finalizes it to an immutable-by-
 * client copy before returning the customText to persist.
 *
 * Why the copy: a presigned PUT stays valid for up to an hour after it's
 * minted. Without this, a replayed PUT to the same key *after* the field is
 * marked signed could silently swap the accepted bytes with no new
 * authorization check — the DB would still point at a key whose contents
 * the client can keep rewriting. Copying to a key no route ever mints a
 * PUT for (`buildFinalizedFieldFileUploadKey`, only ever called here) closes
 * that window: once finalized, the referenced object cannot change again.
 */
export const finalizeFieldFileUpload = async ({
  tmpKey,
  fileName,
  envelopeId,
  fieldId,
  claimedSize,
  claimedMimeType,
}: FinalizeFieldFileUploadOptions): Promise<string> => {
  const tmpHead = await headS3File(tmpKey);

  assertHeadSatisfiesPolicy(tmpHead, 'Uploaded file was not found — please re-upload');

  if (tmpHead.size !== claimedSize || tmpHead.contentType !== claimedMimeType) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'Uploaded file does not match the declared size or type — please re-upload',
    });
  }

  const finalKey = buildFinalizedFieldFileUploadKey({ envelopeId, fieldId, fileName });

  await copyS3File(tmpKey, finalKey);

  // Re-validate the destination itself rather than assuming the copy landed
  // with the metadata we just checked on the source — avoids trusting a
  // HEAD-then-copy sequence that could theoretically race.
  const finalHead = await headS3File(finalKey);

  assertHeadSatisfiesPolicy(finalHead, 'Failed to finalize the uploaded file');

  if (finalHead.size !== tmpHead.size || finalHead.contentType !== tmpHead.contentType) {
    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message: 'Finalized file metadata did not match the uploaded file',
    });
  }

  // Best-effort cleanup — the final copy is already valid and referenced;
  // a leftover tmp object is a storage-hygiene concern, not a security one.
  await deleteS3File(tmpKey).catch(() => undefined);

  return toFileUploadCustomText({
    key: finalKey,
    fileName,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    size: finalHead.size!,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    mimeType: finalHead.contentType!,
  });
};
