import { z } from 'zod';

import type { TrpcRouteMeta } from '../../trpc';

export const getEnvelopeFieldFileDownloadUrlByTokenMeta: TrpcRouteMeta = {
  openapi: {
    method: 'GET',
    path: '/envelope/field/get-file-download-url-by-token',
    summary: 'Get file download URL by token',
    description:
      'Mint a presigned download URL for an already-inserted FILE_UPLOAD field, for any recipient of the same envelope',
    tags: ['Envelope Fields'],
  },
};

export const ZGetEnvelopeFieldFileDownloadUrlByTokenRequestSchema = z.object({
  token: z.string(),
  fieldId: z.number(),
});

export const ZGetEnvelopeFieldFileDownloadUrlByTokenResponseSchema = z.object({
  url: z.string(),
  fileName: z.string(),
});

export type TGetEnvelopeFieldFileDownloadUrlByTokenRequest = z.infer<
  typeof ZGetEnvelopeFieldFileDownloadUrlByTokenRequestSchema
>;
export type TGetEnvelopeFieldFileDownloadUrlByTokenResponse = z.infer<
  typeof ZGetEnvelopeFieldFileDownloadUrlByTokenResponseSchema
>;
