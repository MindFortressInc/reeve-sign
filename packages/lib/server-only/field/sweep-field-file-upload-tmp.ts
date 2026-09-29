import { ONE_HOUR } from '../../constants/time';
import { FIELD_FILE_UPLOAD_TMP_KEY_PREFIX } from '../../types/field-file-upload';
import { deleteS3File, listS3FilesByPrefix } from '../../universal/upload/server-actions';

/**
 * A tmp object younger than this may still be mid-flow: its presigned PUT
 * (at most one hour) may not have been used yet, or the visitor may not have
 * submitted. Past it, nothing can legitimately finalize the object.
 */
export const FIELD_FILE_UPLOAD_TMP_MAX_AGE_MS = 2 * ONE_HOUR;

/** Trailing slash: `field-uploads-tmp-other/...` must never match. */
export const FIELD_FILE_UPLOAD_TMP_SWEEP_PREFIX = `${FIELD_FILE_UPLOAD_TMP_KEY_PREFIX}/`;

/**
 * The only keys this sweep may ever delete: strictly under the tmp prefix,
 * with no `.`/`..`/empty path segments that an HTTP client could normalize
 * into a different key.
 */
export const isSweepableFieldFileUploadTmpKey = (key: string): boolean => {
  if (!key.startsWith(FIELD_FILE_UPLOAD_TMP_SWEEP_PREFIX)) {
    return false;
  }

  const segments = key.slice(FIELD_FILE_UPLOAD_TMP_SWEEP_PREFIX.length).split('/');

  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
};

export type SweepFieldFileUploadTmpResult = {
  deleted: number;
  kept: number;
  refused: number;
  failed: number;
};

export type SweepFieldFileUploadTmpOptions = {
  now?: Date;
  pageSize?: number;
};

/**
 * Deletes FILE_UPLOAD tmp objects that were uploaded but never finalized:
 * abandoned uploads, rejected submissions whose cleanup failed, hidden
 * fields whose value was discarded. Age is measured from the object's own
 * `LastModified`, so a replayed PUT resets it. Objects with no
 * `LastModified` are kept (their age is unknown).
 *
 * Every key is checked against `isSweepableFieldFileUploadTmpKey` before it
 * is deleted, even though the listing is already filtered by that prefix:
 * a provider that ignores or mis-applies `Prefix` must not be able to turn
 * this into a delete of real documents.
 */
export const sweepFieldFileUploadTmp = async ({
  now = new Date(),
  pageSize,
}: SweepFieldFileUploadTmpOptions = {}): Promise<SweepFieldFileUploadTmpResult> => {
  const cutoff = now.getTime() - FIELD_FILE_UPLOAD_TMP_MAX_AGE_MS;

  const result: SweepFieldFileUploadTmpResult = { deleted: 0, kept: 0, refused: 0, failed: 0 };

  for await (const page of listS3FilesByPrefix(FIELD_FILE_UPLOAD_TMP_SWEEP_PREFIX, { pageSize })) {
    for (const { key, lastModified } of page) {
      if (!isSweepableFieldFileUploadTmpKey(key)) {
        result.refused += 1;
        continue;
      }

      if (!lastModified || lastModified.getTime() > cutoff) {
        result.kept += 1;
        continue;
      }

      try {
        await deleteS3File(key);
        result.deleted += 1;
      } catch {
        // One undeletable object must not stop the sweep; the next run retries.
        result.failed += 1;
      }
    }
  }

  return result;
};
