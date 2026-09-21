import path from 'node:path';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  buildFieldFileUploadKeyPrefix,
  buildFieldFileUploadTmpKeyPrefix,
} from '@documenso/lib/types/field-file-upload';
import { env } from '@documenso/lib/utils/env';
import slugify from '@sindresorhus/slugify';

import { ONE_HOUR, ONE_SECOND } from '../../constants/time';
import { alphaid } from '../id';

const slugifyFileNameSegment = (fileName: string): string => {
  const { name, ext } = path.parse(fileName);

  let slugified = slugify(name);

  if (slugified.length === 0 || slugified.length > 100) {
    slugified = alphaid(8);
  }

  return `${slugified}${ext}`;
};

/**
 * Builds the TMP S3 key that a recipient's presigned PUT is minted for.
 * Never re-read as the accepted attachment — `signEnvelopeFieldRoute`
 * finalizes it (server-side copy) to a separate key space before persisting
 * anything, specifically because a presigned PUT stays valid for up to an
 * hour and nothing stops it being replayed after the field is signed.
 */
export const buildFieldFileUploadTmpKey = ({
  envelopeId,
  fieldId,
  fileName,
}: {
  envelopeId: string;
  fieldId: number;
  fileName: string;
}): string => {
  return `${buildFieldFileUploadTmpKeyPrefix({ envelopeId, fieldId })}${alphaid(12)}/${slugifyFileNameSegment(fileName)}`;
};

/**
 * Builds the FINAL, immutable-by-client S3 key an upload is copied to at
 * finalize time. No route ever mints a presigned PUT for this key space —
 * `presign-envelope-field-file-upload.ts` only ever calls
 * `buildFieldFileUploadTmpKey` — so a client can never obtain write access
 * to it. This is what gets persisted in `Field.customText`.
 */
export const buildFinalizedFieldFileUploadKey = ({
  envelopeId,
  fieldId,
  fileName,
}: {
  envelopeId: string;
  fieldId: number;
  fileName: string;
}): string => {
  return `${buildFieldFileUploadKeyPrefix({ envelopeId, fieldId })}${alphaid(12)}/${slugifyFileNameSegment(fileName)}`;
};

const signPutObjectCommand = async (key: string, contentType: string) => {
  const client = getS3Client();

  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const putObjectCommand = new PutObjectCommand({
    Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(client, putObjectCommand, {
    expiresIn: ONE_HOUR / ONE_SECOND,
  });

  return { key, url };
};

export const getPresignPostUrl = async (fileName: string, contentType: string, userId?: number) => {
  // Get the basename and extension for the file
  const { name, ext } = path.parse(fileName);

  let slugified = slugify(name);

  // If the slugified name is empty or too long, generate a random string instead
  //
  // This is fine since we don't really need the filename in s3 since we store it
  // in the database and can always get the original filename from there.
  //
  // The slugified name can be empty when a string contains only CJK or other
  // special characters.
  if (slugified.length === 0 || slugified.length > 100) {
    slugified = alphaid(8);
  }

  let key = `${alphaid(12)}/${slugified}${ext}`;

  if (userId) {
    key = `${userId}/${key}`;
  }

  return signPutObjectCommand(key, contentType);
};

/**
 * Mints a presigned PUT for a caller-supplied key rather than generating one.
 * Used where the key must be scoped to a specific owning resource (e.g. a
 * recipient file-upload field) rather than just a user.
 */
export const getPresignPostUrlForKey = async (key: string, contentType: string) => {
  return signPutObjectCommand(key, contentType);
};

/**
 * Checks whether an object actually exists in the bucket, so callers can
 * confirm an upload really happened rather than trusting a client-submitted
 * key was ever PUT to.
 */
export const headS3File = async (
  key: string,
): Promise<{ exists: boolean; size: number | null; contentType: string | null }> => {
  const client = getS3Client();

  try {
    const response = await client.send(
      new HeadObjectCommand({
        Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
        Key: key,
      }),
    );

    return {
      exists: true,
      size: response.ContentLength ?? null,
      contentType: response.ContentType ?? null,
    };
  } catch (err) {
    const errorName = err instanceof Error ? err.name : '';

    if (errorName === 'NotFound' || errorName === 'NoSuchKey') {
      return { exists: false, size: null, contentType: null };
    }

    throw err;
  }
};

export const getAbsolutePresignPostUrl = async (key: string) => {
  const client = getS3Client();

  const { getSignedUrl: getS3SignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const putObjectCommand = new PutObjectCommand({
    Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
    Key: key,
  });

  const url = await getS3SignedUrl(client, putObjectCommand, {
    expiresIn: ONE_HOUR / ONE_SECOND,
  });

  return { key, url };
};

export const getPresignGetUrl = async (
  key: string,
  options?: { responseContentDisposition?: string; responseContentType?: string },
) => {
  if (env('NEXT_PRIVATE_UPLOAD_DISTRIBUTION_DOMAIN')) {
    const distributionUrl = new URL(key, `${env('NEXT_PRIVATE_UPLOAD_DISTRIBUTION_DOMAIN')}`);

    if (options?.responseContentDisposition) {
      distributionUrl.searchParams.set('response-content-disposition', options.responseContentDisposition);
    }

    if (options?.responseContentType) {
      distributionUrl.searchParams.set('response-content-type', options.responseContentType);
    }

    const { getSignedUrl: getCloudfrontSignedUrl } = await import('@aws-sdk/cloudfront-signer');

    const url = getCloudfrontSignedUrl({
      url: distributionUrl.toString(),
      keyPairId: `${env('NEXT_PRIVATE_UPLOAD_DISTRIBUTION_KEY_ID')}`,
      privateKey: `${env('NEXT_PRIVATE_UPLOAD_DISTRIBUTION_KEY_CONTENTS')}`,
      dateLessThan: new Date(Date.now() + ONE_HOUR).toISOString(),
    });

    return { key, url };
  }

  const client = getS3Client();

  const { getSignedUrl: getS3SignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const getObjectCommand = new GetObjectCommand({
    Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
    Key: key,
    ResponseContentDisposition: options?.responseContentDisposition,
    ResponseContentType: options?.responseContentType,
  });

  const url = await getS3SignedUrl(client, getObjectCommand, {
    expiresIn: ONE_HOUR / ONE_SECOND,
  });

  return { key, url };
};

/**
 * Uploads a file to S3.
 */
export const uploadS3File = async (file: File) => {
  const client = getS3Client();

  // Get the basename and extension for the file
  const { name, ext } = path.parse(file.name);

  const key = `${alphaid(12)}/${slugify(name)}${ext}`;

  const fileBuffer = await file.arrayBuffer();

  const response = await client.send(
    new PutObjectCommand({
      Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
      Key: key,
      Body: Buffer.from(fileBuffer),
      ContentType: file.type,
    }),
  );

  return { key, response };
};

export const deleteS3File = async (key: string) => {
  const client = getS3Client();

  await client.send(
    new DeleteObjectCommand({
      Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
      Key: key,
    }),
  );
};

/**
 * Server-side copy within the same bucket. Used to finalize a recipient
 * upload from its (client-writable, presign-mintable) tmp key to a final
 * key no route ever mints a PUT for.
 */
export const copyS3File = async (sourceKey: string, destinationKey: string) => {
  const client = getS3Client();
  const bucket = env('NEXT_PRIVATE_UPLOAD_BUCKET');

  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      // CopySource must be URL-encoded per the S3 API — an unencoded key
      // with reserved characters (e.g. from an unusual original filename)
      // would otherwise be misparsed as extra path segments.
      CopySource: `${bucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
      Key: destinationKey,
    }),
  );
};

const getS3Client = () => {
  const NEXT_PUBLIC_UPLOAD_TRANSPORT = env('NEXT_PUBLIC_UPLOAD_TRANSPORT');

  if (NEXT_PUBLIC_UPLOAD_TRANSPORT !== 's3') {
    throw new Error('Invalid upload transport');
  }

  const hasCredentials = env('NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID') && env('NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY');

  return new S3Client({
    endpoint: env('NEXT_PRIVATE_UPLOAD_ENDPOINT') || undefined,
    forcePathStyle: env('NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE') === 'true',
    region: env('NEXT_PRIVATE_UPLOAD_REGION') || 'us-east-1',
    credentials: hasCredentials
      ? {
          accessKeyId: String(env('NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID')),
          secretAccessKey: String(env('NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY')),
        }
      : undefined,
  });
};
