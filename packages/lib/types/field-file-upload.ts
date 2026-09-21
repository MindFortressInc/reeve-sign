import { z } from 'zod';

/**
 * Two distinct key spaces, never overlapping:
 *
 * - TMP: where the client's presigned PUT lands. Mutable by design (a
 *   presigned PUT is valid for an hour and nothing stops a replay), so a tmp
 *   key is never persisted as the accepted attachment and never re-read
 *   after finalize.
 * - final (`FIELD_FILE_UPLOAD_KEY_PREFIX`): a server-side copy destination
 *   that no route ever mints a presigned PUT for — `presign-envelope-field-
 *   file-upload.ts` only ever calls `buildFieldFileUploadTmpKey`, so a
 *   client can never obtain write access to a final key. Only the finalize
 *   step in `sign-envelope-field.ts` writes here, via a server-side
 *   `CopyObjectCommand`. This is what gets persisted in `Field.customText`.
 */
export const FIELD_FILE_UPLOAD_TMP_KEY_PREFIX = 'field-uploads-tmp';
export const FIELD_FILE_UPLOAD_KEY_PREFIX = 'field-uploads';

/**
 * Allowlist, not a blocklist — only types real-estate paperwork actually
 * needs (driver's license, pre-approval letter, proof of funds). Deliberately
 * excludes any executable/script/markup content type.
 */
export const FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;

export type TFieldFileUploadAllowedMimeType = (typeof FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES)[number];

export const FIELD_FILE_UPLOAD_SIZE_LIMIT_MB = 15;

export const ZFieldFileUploadValue = z.object({
  key: z.string().min(1),
  fileName: z.string().min(1),
  size: z.number().int().positive(),
  mimeType: z.string().min(1),
});

export type TFieldFileUploadValue = z.infer<typeof ZFieldFileUploadValue>;

const buildKeyPrefix = (root: string, envelopeId: string, fieldId: number): string => {
  return `${root}/${envelopeId}/${fieldId}/`;
};

export const buildFieldFileUploadTmpKeyPrefix = ({
  envelopeId,
  fieldId,
}: {
  envelopeId: string;
  fieldId: number;
}): string => {
  return buildKeyPrefix(FIELD_FILE_UPLOAD_TMP_KEY_PREFIX, envelopeId, fieldId);
};

export const buildFieldFileUploadKeyPrefix = ({
  envelopeId,
  fieldId,
}: {
  envelopeId: string;
  fieldId: number;
}): string => {
  return buildKeyPrefix(FIELD_FILE_UPLOAD_KEY_PREFIX, envelopeId, fieldId);
};

/**
 * A key is owned by a field when it matches `<prefix>/<random-segment>/
 * <filename>` exactly — no extra path segments, no traversal.
 */
const isKeyOwnedByPrefix = (key: string, prefix: string): boolean => {
  if (!key.startsWith(prefix)) {
    return false;
  }

  const rest = key.slice(prefix.length);
  const segments = rest.split('/');

  if (segments.length !== 2) {
    return false;
  }

  const [randomSegment, fileNameSegment] = segments;

  if (!/^[A-Za-z0-9]+$/.test(randomSegment) || fileNameSegment.length === 0) {
    return false;
  }

  if (key.includes('..')) {
    return false;
  }

  return true;
};

/**
 * Validates that a CLIENT-SUBMITTED key (the one returned by the presign
 * mutation and sent back at sign time) was actually minted for this exact
 * field — not copied from another field or envelope. Only ever checked
 * against the TMP prefix: a client never has a legitimate reason to submit
 * a final-prefixed key, and this function will correctly reject one since
 * it never matches the tmp prefix.
 */
export const isFieldFileUploadTmpKeyOwnedBy = ({
  key,
  envelopeId,
  fieldId,
}: {
  key: string;
  envelopeId: string;
  fieldId: number;
}): boolean => {
  return isKeyOwnedByPrefix(key, buildFieldFileUploadTmpKeyPrefix({ envelopeId, fieldId }));
};

export const toFileUploadCustomText = (value: TFieldFileUploadValue): string => {
  return JSON.stringify(value);
};

export const parseFileUploadCustomText = (customText: string): TFieldFileUploadValue | null => {
  if (!customText) {
    return null;
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(customText);
  } catch {
    return null;
  }

  const result = ZFieldFileUploadValue.safeParse(parsedJson);

  return result.success ? result.data : null;
};
