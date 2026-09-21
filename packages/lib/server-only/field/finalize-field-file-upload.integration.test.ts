import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFieldFileUploadTmpKey } from '../../universal/upload/server-actions';
import { finalizeFieldFileUpload } from './finalize-field-file-upload';

/**
 * Runs against a REAL local S3-compatible store (minio), not a mock — proves
 * `finalizeFieldFileUpload`'s core security property end to end: once
 * finalized, replaying the original presigned-PUT-style write to the tmp key
 * cannot alter what the finalized (persisted) key serves.
 *
 * Requires a local minio reachable at NEXT_PRIVATE_UPLOAD_ENDPOINT with the
 * bucket already created (see the worktree's `.env` — this repo's dev worker
 * started one on :9655 with bucket `documenso-dev655` for this unit).
 */
const S3_ENV = {
  NEXT_PUBLIC_UPLOAD_TRANSPORT: 's3',
  NEXT_PRIVATE_UPLOAD_ENDPOINT: 'http://127.0.0.1:9655',
  NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE: 'true',
  NEXT_PRIVATE_UPLOAD_REGION: 'us-east-1',
  NEXT_PRIVATE_UPLOAD_BUCKET: 'documenso-dev655',
  NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID: 'documenso',
  NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY: 'password',
};

const directClient = new S3Client({
  endpoint: S3_ENV.NEXT_PRIVATE_UPLOAD_ENDPOINT,
  forcePathStyle: true,
  region: S3_ENV.NEXT_PRIVATE_UPLOAD_REGION,
  credentials: {
    accessKeyId: S3_ENV.NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID,
    secretAccessKey: S3_ENV.NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY,
  },
});

const getObjectBody = async (key: string): Promise<string | null> => {
  try {
    const response = await directClient.send(
      new GetObjectCommand({ Bucket: S3_ENV.NEXT_PRIVATE_UPLOAD_BUCKET, Key: key }),
    );

    return (await response.Body?.transformToString()) ?? null;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';

    if (name === 'NoSuchKey' || name === 'NotFound') {
      return null;
    }

    throw err;
  }
};

beforeEach(() => {
  for (const [key, value] of Object.entries(S3_ENV)) {
    vi.stubEnv(key, value);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('finalizeFieldFileUpload — live MinIO integration', () => {
  it('finalizes a real object to an immutable key, deletes the tmp object, and survives a replayed PUT to the tmp key unchanged', async () => {
    const envelopeId = `env_itest_${Date.now()}`;
    const fieldId = 4242;
    const fileName = 'license.pdf';
    const originalContent = `original-bytes-${Date.now()}`;

    const tmpKey = buildFieldFileUploadTmpKey({ envelopeId, fieldId, fileName });

    // Simulates the recipient's presigned PUT landing on the tmp key.
    await directClient.send(
      new PutObjectCommand({
        Bucket: S3_ENV.NEXT_PRIVATE_UPLOAD_BUCKET,
        Key: tmpKey,
        Body: originalContent,
        ContentType: 'application/pdf',
      }),
    );

    const customText = await finalizeFieldFileUpload({
      tmpKey,
      fileName,
      envelopeId,
      fieldId,
      claimedSize: Buffer.byteLength(originalContent),
      claimedMimeType: 'application/pdf',
    });

    const { key: finalKey } = JSON.parse(customText) as { key: string };

    expect(finalKey).not.toBe(tmpKey);
    expect(finalKey.startsWith('field-uploads/')).toBe(true);
    expect(finalKey.startsWith('field-uploads-tmp/')).toBe(false);

    // The final key really has the uploaded bytes.
    await expect(getObjectBody(finalKey)).resolves.toBe(originalContent);

    // The tmp key was cleaned up as part of finalize.
    await expect(getObjectBody(tmpKey)).resolves.toBeNull();

    // REPLAY ATTACK: someone captured the (still-valid-for-up-to-an-hour)
    // presigned PUT URL for the tmp key and replays it with DIFFERENT bytes
    // after the field has already been signed and finalized.
    const replayedContent = `REPLACED-bytes-${Date.now()}`;

    await directClient.send(
      new PutObjectCommand({
        Bucket: S3_ENV.NEXT_PRIVATE_UPLOAD_BUCKET,
        Key: tmpKey,
        Body: replayedContent,
        ContentType: 'application/pdf',
      }),
    );

    // The replay landed on the tmp key (proving the replay itself succeeds
    // at the transport level, so this isn't a vacuous assertion)...
    await expect(getObjectBody(tmpKey)).resolves.toBe(replayedContent);

    // ...but the FINALIZED artifact — the only key ever persisted to
    // Field.customText and the only one any download route ever reads — is
    // untouched. This is the property that matters: nothing a client does
    // to the tmp key after finalize can change what a downloader receives.
    await expect(getObjectBody(finalKey)).resolves.toBe(originalContent);
  });

  it('rejects finalize when the actual stored object violates policy even though the presign step allowed the upload to start', async () => {
    const envelopeId = `env_itest_${Date.now()}`;
    const fieldId = 4243;
    const fileName = 'not-really-a-pdf.pdf';

    const tmpKey = buildFieldFileUploadTmpKey({ envelopeId, fieldId, fileName });

    // The object that actually landed in storage has a disallowed real
    // content-type, regardless of what the client claims at sign time.
    await directClient.send(
      new PutObjectCommand({
        Bucket: S3_ENV.NEXT_PRIVATE_UPLOAD_BUCKET,
        Key: tmpKey,
        Body: 'MZ-fake-executable-bytes',
        ContentType: 'application/x-msdownload',
      }),
    );

    await expect(
      finalizeFieldFileUpload({
        tmpKey,
        fileName,
        envelopeId,
        fieldId,
        claimedSize: Buffer.byteLength('MZ-fake-executable-bytes'),
        claimedMimeType: 'application/pdf', // client lies about the type
      }),
    ).rejects.toThrow();
  });
});
