import { z } from 'zod';

import type { TrpcRouteMeta } from '../../trpc';

export const getEnvelopeFieldFileDownloadUrlMeta: TrpcRouteMeta = {
  openapi: {
    method: 'GET',
    path: '/envelope/field/get-file-download-url',
    summary: 'Get file download URL',
    description: 'Mint a presigned download URL for an already-inserted FILE_UPLOAD field, as the owning team',
    tags: ['Envelope Fields'],
  },
};

export const ZGetEnvelopeFieldFileDownloadUrlRequestSchema = z.object({
  fieldId: z.number(),
});

export const ZGetEnvelopeFieldFileDownloadUrlResponseSchema = z.object({
  url: z.string(),
  fileName: z.string(),
});

export type TGetEnvelopeFieldFileDownloadUrlRequest = z.infer<typeof ZGetEnvelopeFieldFileDownloadUrlRequestSchema>;
export type TGetEnvelopeFieldFileDownloadUrlResponse = z.infer<typeof ZGetEnvelopeFieldFileDownloadUrlResponseSchema>;
