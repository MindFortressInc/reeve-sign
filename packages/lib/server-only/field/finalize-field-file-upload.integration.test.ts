import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFieldFileUploadKeyPrefix } from '../../types/field-file-upload';
import { buildFieldFileUploadTmpKey, getPresignPostUrlForKey } from '../../universal/upload/server-actions';
import { finalizeFieldFileUpload } from './finalize-field-file-upload';

/**
 * Runs against a REAL local S3-compatible store (minio), not a mock — proves
 * `finalizeFieldFileUpload`'s core security property end to end: once
 * finalized, replaying the original presigned-PUT-style write to the tmp key
 * cannot alter what the finalized (persisted) key serves.
 *
 * Opt-in only, via RUN_S3_INTEGRATION_TESTS=true. This file is also excluded
 * from the default `vitest run` glob (packages/lib/vitest.config.ts) and
 * only collected by `npm run test:integration` (vitest.integration.config.ts).
 * The opt-in flag is required IN ADDITION to that exclusion because
 * NEXT_PRIVATE_UPLOAD_* always carries a plausible-looking value from
 * .env/.env.example — its mere presence can't be the gate for a suite that
 * writes real objects to a real bucket, or a portable environment with no
 * MinIO running would still attempt it and produce a flaky/failing "unit"
 * run. When explicitly selected, this suite requires an actually-reachable
 * endpoint and fails loudly (not a silent skip) if storage is misconfigured
 * or unreachable — the point of running it explicitly is to prove the real
 * thing works.
 *
 *   RUN_S3_INTEGRATION_TESTS=true npm run with:env -- npm run test:integration -w @documenso/lib
 */
const RUN_INTEGRATION = process.env.RUN_S3_INTEGRATION_TESTS === 'true';

describe.skipIf(!RUN_INTEGRATION)('finalizeFieldFileUpload — live MinIO integration', () => {
  const s3Env = {
    endpoint: process.env.NEXT_PRIVATE_UPLOAD_ENDPOINT ?? '',
    forcePathStyle: (process.env.NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE ?? 'true') === 'true',
    region: process.env.NEXT_PRIVATE_UPLOAD_REGION || 'us-east-1',
    bucket: process.env.NEXT_PRIVATE_UPLOAD_BUCKET ?? '',
    accessKeyId: process.env.NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY ?? '',
  };

  // Constructed only once the guard above has already decided this suite is
  // actually running — `beforeAll`/`beforeEach` never fire for a skipped
  // describe block, so an unconfigured environment never reaches this.
  let directClient: S3Client;

  beforeAll(() => {
    if (!s3Env.endpoint || !s3Env.bucket || !s3Env.accessKeyId || !s3Env.secretAccessKey) {
      throw new Error(
        'RUN_S3_INTEGRATION_TESTS=true requires NEXT_PRIVATE_UPLOAD_ENDPOINT, NEXT_PRIVATE_UPLOAD_BUCKET, ' +
          'NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID, and NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY to be set (see .env). ' +
          'This suite was explicitly selected, so a missing/unreachable live store is a real failure, not a skip.',
      );
    }

    directClient = new S3Client({
      endpoint: s3Env.endpoint,
      forcePathStyle: s3Env.forcePathStyle,
      region: s3Env.region,
      credentials: {
        accessKeyId: s3Env.accessKeyId,
        secretAccessKey: s3Env.secretAccessKey,
      },
    });
  });

  const getObjectBody = async (key: string): Promise<string | null> => {
    try {
      const response = await directClient.send(new GetObjectCommand({ Bucket: s3Env.bucket, Key: key }));

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
    vi.stubEnv('NEXT_PUBLIC_UPLOAD_TRANSPORT', 's3');
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_ENDPOINT', s3Env.endpoint);
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE', String(s3Env.forcePathStyle));
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_REGION', s3Env.region);
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_BUCKET', s3Env.bucket);
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID', s3Env.accessKeyId);
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY', s3Env.secretAccessKey);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('finalizes a real object to an immutable key, deletes the tmp object, and survives a replayed PUT to the tmp key unchanged', async () => {
    const envelopeId = `env_itest_${Date.now()}`;
    const fieldId = 4242;
    const fileName = 'license.pdf';
    // Real PDF signature — finalize verifies content by magic bytes.
    const originalContent = `%PDF-1.7\noriginal-bytes-${Date.now()}`;

    const tmpKey = buildFieldFileUploadTmpKey({ envelopeId, fieldId, fileName });

    // Simulates the recipient's presigned PUT landing on the tmp key.
    await directClient.send(
      new PutObjectCommand({
        Bucket: s3Env.bucket,
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
        Bucket: s3Env.bucket,
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
        Bucket: s3Env.bucket,
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

  it('rejects spoofed content (HTML declared as application/pdf at PUT and sign time) and leaves neither the tmp nor a final object behind', async () => {
    const envelopeId = `env_itest_${Date.now()}`;
    const fieldId = 4244;
    const fileName = 'license.pdf';
    const spoofedContent = '<html><script>alert(document.cookie)</script></html>';

    const tmpKey = buildFieldFileUploadTmpKey({ envelopeId, fieldId, fileName });

    // The client declares application/pdf consistently at PUT and sign time,
    // so every header-based check passes — only the bytes give it away.
    await directClient.send(
      new PutObjectCommand({
        Bucket: s3Env.bucket,
        Key: tmpKey,
        Body: spoofedContent,
        ContentType: 'application/pdf',
      }),
    );

    await expect(
      finalizeFieldFileUpload({
        tmpKey,
        fileName,
        envelopeId,
        fieldId,
        claimedSize: Buffer.byteLength(spoofedContent),
        claimedMimeType: 'application/pdf',
      }),
    ).rejects.toThrow('Uploaded file content does not match its declared type');

    await expect(getObjectBody(tmpKey)).resolves.toBeNull();

    const finalObjects = await directClient.send(
      new ListObjectsV2Command({
        Bucket: s3Env.bucket,
        Prefix: buildFieldFileUploadKeyPrefix({ envelopeId, fieldId }),
      }),
    );

    expect(finalObjects.KeyCount ?? 0).toBe(0);
  });
  // DEV-12064: the 15MB ceiling holds BEFORE bytes land, because the
  // presigned PUT signs the declared size. Prod is Cloudflare R2, which was
  // measured to behave the same way (docs/storage-provider.md).
  describe('presigned PUT size binding', () => {
    const declared = 4096;

    const presignTmpKey = async (fieldId: number) => {
      const tmpKey = buildFieldFileUploadTmpKey({ envelopeId: `env_itest_${Date.now()}`, fieldId, fileName: 'a.pdf' });
      const { url } = await getPresignPostUrlForKey(tmpKey, 'application/pdf', declared);

      return { tmpKey, url };
    };

    const put = async (url: string, body: BodyInit) =>
      fetch(url, {
        method: 'PUT',
        body,
        headers: { 'Content-Type': 'application/pdf' },
        // Required by undici for a streamed (chunked) request body.
        duplex: 'half',
      } as RequestInit);

    it('accepts a PUT of exactly the declared size', async () => {
      const { tmpKey, url } = await presignTmpKey(4251);

      const response = await put(url, new Uint8Array(declared));

      expect(response.status).toBe(200);
      await expect(getObjectBody(tmpKey)).resolves.toHaveLength(declared);
    });

    it('rejects a PUT larger than the declared size before storing anything', async () => {
      const { tmpKey, url } = await presignTmpKey(4252);

      const response = await put(url, new Uint8Array(declared + 1000));

      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toContain('SignatureDoesNotMatch');
      await expect(getObjectBody(tmpKey)).resolves.toBeNull();
    });

    it('rejects a chunked PUT that omits Content-Length', async () => {
      const { tmpKey, url } = await presignTmpKey(4253);

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(declared + 1000));
          controller.close();
        },
      });

      const response = await put(url, stream);

      // MinIO answers 411 Length Required; R2 answers 403 SignatureDoesNotMatch.
      expect([403, 411]).toContain(response.status);
      await expect(getObjectBody(tmpKey)).resolves.toBeNull();
    });
  });
});
