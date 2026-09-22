import { z } from 'zod';

import type { TrpcRouteMeta } from '../../trpc';

export const presignEnvelopeFieldFileUploadMeta: TrpcRouteMeta = {
  openapi: {
    method: 'POST',
    path: '/envelope/field/presign-file-upload',
    summary: 'Presign file upload',
    description: "Mint a presigned upload URL for a recipient's FILE_UPLOAD field",
    tags: ['Envelope Fields'],
  },
};

export const ZPresignEnvelopeFieldFileUploadRequestSchema = z.object({
  token: z.string(),
  fieldId: z.number(),
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1),
  fileSize: z.number().int().positive(),
});

export const ZPresignEnvelopeFieldFileUploadResponseSchema = z.object({
  key: z.string(),
  url: z.string(),
});

export type TPresignEnvelopeFieldFileUploadRequest = z.infer<typeof ZPresignEnvelopeFieldFileUploadRequestSchema>;
export type TPresignEnvelopeFieldFileUploadResponse = z.infer<typeof ZPresignEnvelopeFieldFileUploadResponseSchema>;
