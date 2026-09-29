import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ONE_HOUR } from '../../constants/time';
import { deleteS3File, listS3FilesByPrefix } from '../../universal/upload/server-actions';
import { sweepFieldFileUploadTmp } from './sweep-field-file-upload-tmp';

/**
 * Runs the tmp sweep against a REAL S3-compatible store (MinIO): real
 * ListObjectsV2 pagination (forced to 2 keys per page), real LastModified,
 * real deletes. Proves the sweep removes every expired tmp object across
 * pages and never touches a key outside `field-uploads-tmp/`.
 *
 * Opt-in via RUN_S3_INTEGRATION_TESTS=true, same gate and rationale as
 * finalize-field-file-upload.integration.test.ts.
 *
 *   RUN_S3_INTEGRATION_TESTS=true npm run with:env -- npm run test:integration -w @documenso/lib
 */
const RUN_INTEGRATION = process.env.RUN_S3_INTEGRATION_TESTS === 'true';

describe.skipIf(!RUN_INTEGRATION)('sweepFieldFileUploadTmp — live MinIO integration', () => {
  const bucket = process.env.NEXT_PRIVATE_UPLOAD_BUCKET ?? '';
  const runId = `envelope_sweep${nanoid(8).replace(/[^A-Za-z0-9]/g, 'x')}`;

  const tmpKeys = Array.from({ length: 5 }, (_, i) => `field-uploads-tmp/${runId}/${i + 1}/abcdefghijkl/upload.pdf`);
  const finalKey = `field-uploads/${runId}/1/abcdefghijkl/upload.pdf`;
  const lookAlikeKey = `field-uploads-tmp-other/${runId}/1/abcdefghijkl/upload.pdf`;
  const documentKey = `${runId}/contract.pdf`;
  const keptKeys = [finalKey, lookAlikeKey, documentKey];

  let client: S3Client;

  const exists = async (key: string) => {
    try {
      await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (err) {
      if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
        return false;
      }

      throw err;
    }
  };

  beforeAll(async () => {
    if (!process.env.NEXT_PRIVATE_UPLOAD_ENDPOINT || !bucket) {
      throw new Error('RUN_S3_INTEGRATION_TESTS=true requires NEXT_PRIVATE_UPLOAD_ENDPOINT and _BUCKET (see .env).');
    }

    client = new S3Client({
      endpoint: process.env.NEXT_PRIVATE_UPLOAD_ENDPOINT,
      forcePathStyle: (process.env.NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE ?? 'true') === 'true',
      region: process.env.NEXT_PRIVATE_UPLOAD_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY ?? '',
      },
    });

    for (const key of [...tmpKeys, ...keptKeys]) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: '%PDF-1.7', ContentType: 'application/pdf' }),
      );
    }
  });

  afterAll(async () => {
    for (const key of [...tmpKeys, ...keptKeys]) {
      await deleteS3File(key).catch(() => undefined);
    }
  });

  it('pages through a prefix with continuation tokens', async () => {
    const pages: string[][] = [];

    for await (const page of listS3FilesByPrefix(`field-uploads-tmp/${runId}/`, { pageSize: 2 })) {
      pages.push(page.map(({ key }) => key));
    }

    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(pages.flat().sort()).toEqual([...tmpKeys].sort());
  });

  it('keeps tmp objects younger than the max age', async () => {
    await sweepFieldFileUploadTmp({ pageSize: 2 });

    for (const key of tmpKeys) {
      expect(await exists(key)).toBe(true);
    }
  });

  it('deletes every expired tmp object across pages, and nothing outside the tmp prefix', async () => {
    const result = await sweepFieldFileUploadTmp({ now: new Date(Date.now() + 3 * ONE_HOUR), pageSize: 2 });

    expect(result.deleted).toBeGreaterThanOrEqual(tmpKeys.length);
    expect(result.refused).toBe(0);

    for (const key of tmpKeys) {
      expect(await exists(key)).toBe(false);
    }

    for (const key of keptKeys) {
      expect(await exists(key)).toBe(true);
    }
  });
});
