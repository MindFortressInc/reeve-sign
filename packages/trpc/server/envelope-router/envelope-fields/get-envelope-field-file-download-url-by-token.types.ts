import { z } from 'zod';

/**
 * Deliberately NOT on the public API v2 surface (no `openapi` meta), matching
 * the other recipient-token procedures (`getDocumentByToken`,
 * `getEnvelopeItemsByToken`): API v2 is the API-token-authenticated
 * integrator surface, and integrators use the team-scoped
 * `getFileDownloadUrl` instead. Reachable over tRPC only (DEV-12256).
 */
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
