import { z } from 'zod';

export const ZPresignDirectTemplateFieldFileUploadRequestSchema = z.object({
  directTemplateToken: z.string().min(1),
  fieldId: z.number(),
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1),
  fileSize: z.number().int().positive(),
});

export const ZPresignDirectTemplateFieldFileUploadResponseSchema = z.object({
  key: z.string(),
  url: z.string(),
});

export type TPresignDirectTemplateFieldFileUploadRequest = z.infer<
  typeof ZPresignDirectTemplateFieldFileUploadRequestSchema
>;
export type TPresignDirectTemplateFieldFileUploadResponse = z.infer<
  typeof ZPresignDirectTemplateFieldFileUploadResponseSchema
>;
