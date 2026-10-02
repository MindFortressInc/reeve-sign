import { env } from '@documenso/lib/utils/env';
import type { TGetPresignedPostUrlResponse, TUploadPdfResponse } from '@documenso/remix/server/api/files/files.types';
import { DocumentDataType } from '@prisma/client';
import { base64 } from '@scure/base';
import { match } from 'ts-pattern';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { AppError } from '../../errors/app-error';

type File = {
  name: string;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

/**
 * Uploads a PDF through `/api/files/upload-pdf`, which needs a session or,
 * from the embedded authoring iframe (no session cookie), the embedding
 * presign token as `presignToken` (DEV-12801).
 */
export const putPdfFile = async (file: File, options: { presignToken?: string } = {}) => {
  const formData = new FormData();

  // Create a proper File object from the data
  const buffer = await file.arrayBuffer();
  const blob = new Blob([buffer], { type: file.type });
  const properFile = new File([blob], file.name, { type: file.type });

  formData.append('file', properFile);

  const response = await fetch('/api/files/upload-pdf', {
    method: 'POST',
    headers: options.presignToken ? { Authorization: `Bearer ${options.presignToken}` } : undefined,
    body: formData,
  });

  if (!response.ok) {
    console.error('Upload failed:', response.statusText);
    throw new AppError('UPLOAD_FAILED');
  }

  const result: TUploadPdfResponse = await response.json();

  return result;
};

/**
 * Uploads a file to the appropriate storage location.
 */
export const putFile = async (file: File) => {
  const NEXT_PUBLIC_UPLOAD_TRANSPORT = env('NEXT_PUBLIC_UPLOAD_TRANSPORT');

  return await match(NEXT_PUBLIC_UPLOAD_TRANSPORT)
    .with('s3', async () => putFileInS3(file))
    .otherwise(async () => putFileInDatabase(file));
};

const putFileInDatabase = async (file: File) => {
  const contents = await file.arrayBuffer();

  const binaryData = new Uint8Array(contents);

  const asciiData = base64.encode(binaryData);

  return {
    type: DocumentDataType.BYTES_64,
    data: asciiData,
  };
};

const putFileInS3 = async (file: File) => {
  const body = await file.arrayBuffer();

  const getPresignedUrlResponse = await fetch(`${NEXT_PUBLIC_WEBAPP_URL()}/api/files/presigned-post-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type,
      // The presigned PUT is signed for exactly this many bytes (DEV-12801).
      fileSize: body.byteLength,
    }),
  });

  if (!getPresignedUrlResponse.ok) {
    throw new Error(`Failed to get presigned post url, failed with status code ${getPresignedUrlResponse.status}`);
  }

  const { url, key }: TGetPresignedPostUrlResponse = await getPresignedUrlResponse.json();

  const reponse = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body,
  });

  if (!reponse.ok) {
    throw new Error(`Failed to upload file "${file.name}", failed with status code ${reponse.status}`);
  }

  return {
    type: DocumentDataType.S3_PATH,
    data: key,
  };
};
