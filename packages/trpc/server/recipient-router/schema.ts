import { isTemplateRecipientEmailPlaceholder } from '@documenso/lib/constants/template';
import {
  ZRecipientAccessAuthSchema,
  ZRecipientAccessAuthTypesSchema,
  ZRecipientActionAuthSchema,
  ZRecipientActionAuthTypesSchema,
} from '@documenso/lib/types/document-auth';
import { ZRecipientLiteSchema, ZRecipientSchema } from '@documenso/lib/types/recipient';
import { zEmail } from '@documenso/lib/utils/zod';
import { RecipientRole } from '@prisma/client';
import { z } from 'zod';

export const ZGetRecipientRequestSchema = z.object({
  recipientId: z.number(),
});

export const ZGetRecipientResponseSchema = ZRecipientSchema;

/**
 * When changing this, ensure everything that uses this schema is updated correctly
 * since this will change the Openapi schema.
 *
 * Example `createDocument` uses this, so you will need to update that function to
 * pass along required details.
 */
export const ZCreateRecipientSchema = z.object({
  email: zEmail().toLowerCase().min(1).max(254),
  name: z.string().max(255),
  role: z.nativeEnum(RecipientRole),
  signingOrder: z.number().optional(),
  accessAuth: z.array(ZRecipientAccessAuthTypesSchema).default([]).optional(),
  actionAuth: z.array(ZRecipientActionAuthTypesSchema).default([]).optional(),
});

export const ZUpdateRecipientSchema = z.object({
  id: z.number().describe('The ID of the recipient to update.'),
  email: zEmail().toLowerCase().min(1).max(254).optional(),
  name: z.string().max(255).optional(),
  role: z.nativeEnum(RecipientRole).optional(),
  signingOrder: z.number().optional(),
  accessAuth: z.array(ZRecipientAccessAuthTypesSchema).default([]).optional(),
  actionAuth: z.array(ZRecipientActionAuthTypesSchema).default([]).optional(),
});

export const ZCreateDocumentRecipientRequestSchema = z.object({
  documentId: z.number(),
  recipient: ZCreateRecipientSchema,
});

export const ZCreateDocumentRecipientResponseSchema = ZRecipientLiteSchema;

export const ZCreateDocumentRecipientsRequestSchema = z.object({
  documentId: z.number(),
  recipients: z.array(ZCreateRecipientSchema),
});

export const ZCreateDocumentRecipientsResponseSchema = z.object({
  recipients: ZRecipientLiteSchema.array(),
});

export const ZUpdateDocumentRecipientRequestSchema = z.object({
  documentId: z.number(),
  recipient: ZUpdateRecipientSchema,
});

export const ZUpdateDocumentRecipientResponseSchema = ZRecipientSchema;

export const ZUpdateDocumentRecipientsRequestSchema = z.object({
  documentId: z.number(),
  recipients: z.array(ZUpdateRecipientSchema),
});

export const ZUpdateDocumentRecipientsResponseSchema = z.object({
  recipients: z.array(ZRecipientSchema),
});

export const ZDeleteDocumentRecipientRequestSchema = z.object({
  recipientId: z.number(),
});

export const ZSetDocumentRecipientsRequestSchema = z.object({
  documentId: z.number(),
  recipients: z.array(
    z.object({
      id: z.number().optional(),
      email: zEmail().toLowerCase().min(1).max(254),
      name: z.string().max(255),
      role: z.nativeEnum(RecipientRole),
      signingOrder: z.number().optional(),
      actionAuth: z.array(ZRecipientActionAuthTypesSchema).optional().default([]),
    }),
  ),
});

export const ZSetDocumentRecipientsResponseSchema = z.object({
  recipients: ZRecipientLiteSchema.array(),
});

export const ZCreateTemplateRecipientRequestSchema = z.object({
  templateId: z.number(),
  recipient: ZCreateRecipientSchema,
});

export const ZCreateTemplateRecipientResponseSchema = ZRecipientLiteSchema;

export const ZCreateTemplateRecipientsRequestSchema = z.object({
  templateId: z.number(),
  recipients: z.array(ZCreateRecipientSchema),
});

export const ZCreateTemplateRecipientsResponseSchema = z.object({
  recipients: ZRecipientLiteSchema.array(),
});

export const ZUpdateTemplateRecipientRequestSchema = z.object({
  templateId: z.number(),
  recipient: ZUpdateRecipientSchema,
});

export const ZUpdateTemplateRecipientResponseSchema = ZRecipientSchema;

export const ZUpdateTemplateRecipientsRequestSchema = z.object({
  templateId: z.number(),
  recipients: z.array(ZUpdateRecipientSchema),
});

export const ZUpdateTemplateRecipientsResponseSchema = z.object({
  recipients: z.array(ZRecipientSchema),
});

export const ZDeleteTemplateRecipientRequestSchema = z.object({
  recipientId: z.number(),
});

export const ZSetTemplateRecipientsRequestSchema = z.object({
  templateId: z.number(),
  recipients: z.array(
    z.object({
      id: z.number().optional(),
      email: z
        .string()
        .toLowerCase()
        .refine(
          (email) => {
            return isTemplateRecipientEmailPlaceholder(email) || zEmail().safeParse(email).success;
          },
          { message: 'Please enter a valid email address' },
        ),
      name: z.string(),
      role: z.nativeEnum(RecipientRole),
      signingOrder: z.number().optional(),
      actionAuth: z.array(ZRecipientActionAuthTypesSchema).optional().default([]),
    }),
  ),
});

export const ZSetTemplateRecipientsResponseSchema = z.object({
  recipients: ZRecipientLiteSchema.array(),
});

export const ZCompleteDocumentWithTokenMutationSchema = z.object({
  token: z.string(),
  documentId: z.number(),
  accessAuthOptions: ZRecipientAccessAuthSchema.optional(),
  nextSigner: z
    .object({
      email: zEmail().max(254),
      name: z.string().min(1).max(255),
    })
    .optional(),
  recipientOverride: z
    .object({
      email: zEmail().trim().toLowerCase().max(254).optional(),
      name: z.string().max(255).optional(),
    })
    .optional(),
});

export type TCompleteDocumentWithTokenMutationSchema = z.infer<typeof ZCompleteDocumentWithTokenMutationSchema>;

export const ZRejectDocumentWithTokenMutationSchema = z.object({
  token: z.string(),
  documentId: z.number(),
  reason: z.string(),
  authOptions: ZRecipientActionAuthSchema.optional(),
});

export type TRejectDocumentWithTokenMutationSchema = z.infer<typeof ZRejectDocumentWithTokenMutationSchema>;

/**
 * DEV-654 in-person handoff. Authenticated-only (see authenticatedProcedure) --
 * never accepts or trusts a recipient token as authorization. Returns the raw
 * signing token for exactly one currently-eligible recipient so it must never
 * be exposed to anyone other than a verified owner/team member of this
 * envelope.
 *
 * START and ADVANCE are deliberately separate operations (not one procedure
 * with an optional field): START is the host explicitly kicking off a
 * session before anyone has signed; ADVANCE requires proof (re-checked
 * server-side, fresh) that a specific recipient has actually completed
 * before disclosing the next one's link. Making completedRecipientId
 * optional on a single procedure would let a caller "start" mid-chain to
 * skip that proof entirely.
 */
export const ZHandoffSigningLinkResponseSchema = z.object({
  signingLink: z.string(),
  name: z.string(),
  email: z.string(),
});

/**
 * teamId here is the envelope's OWN owning team (known to the caller from
 * data it already has -- e.g. complete.tsx's loader already fetched
 * document.teamId to run the same authorization check server-side once
 * already), NOT the ambient "currently selected team" the authenticated
 * tRPC context otherwise derives for team-scoped `/t/:teamUrl/...` routes.
 * The recipient-facing `/sign/:token` pages this is called from carry no
 * such ambient team context. This is safe: getEnvelopeById treats teamId as
 * unvalidated input and re-verifies both that the user belongs to it AND
 * that it actually owns this envelope on every call -- it is never trusted
 * bare.
 */
export const ZStartHandoffCandidatesRequestSchema = z.object({
  documentId: z.number(),
  teamId: z.number(),
});

export const ZHandoffCandidateSchema = z.object({
  recipientId: z.number(),
  name: z.string(),
  email: z.string(),
});

export const ZStartHandoffCandidatesResponseSchema = z.array(ZHandoffCandidateSchema);

export const ZStartHandoffSigningLinkRequestSchema = z.object({
  documentId: z.number(),
  teamId: z.number(),
  recipientId: z.number(),
});

export const ZAdvanceHandoffSigningLinkRequestSchema = z.object({
  documentId: z.number(),
  teamId: z.number(),
  /** The recipient who must have actually just completed -- re-verified server-side, never trusted as a bare claim. */
  completedRecipientId: z.number(),
  nextRecipientId: z.number(),
});
