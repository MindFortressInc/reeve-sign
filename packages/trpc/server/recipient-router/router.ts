import { invalidateSessions } from '@documenso/auth/server/lib/session/session';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { completeDocumentWithToken } from '@documenso/lib/server-only/document/complete-document-with-token';
import { rejectDocumentWithToken } from '@documenso/lib/server-only/document/reject-document-with-token';
import { createEnvelopeRecipients } from '@documenso/lib/server-only/recipient/create-envelope-recipients';
import { deleteEnvelopeRecipient } from '@documenso/lib/server-only/recipient/delete-envelope-recipient';
import {
  getAdvanceHandoffCandidates,
  getAdvanceHandoffSigningToken,
  getStartHandoffCandidates,
  getStartHandoffSigningToken,
} from '@documenso/lib/server-only/recipient/get-handoff-eligibility';
import { getRecipientById } from '@documenso/lib/server-only/recipient/get-recipient-by-id';
import { mintHandoffCapability } from '@documenso/lib/server-only/recipient/handoff-capability';
import { setDocumentRecipients } from '@documenso/lib/server-only/recipient/set-document-recipients';
import { setTemplateRecipients } from '@documenso/lib/server-only/recipient/set-template-recipients';
import { updateEnvelopeRecipients } from '@documenso/lib/server-only/recipient/update-envelope-recipients';
import { formatSigningLink } from '@documenso/lib/utils/recipients';
import { EnvelopeType } from '@prisma/client';
import type { TrpcContext } from '../context';
import { ZGenericSuccessResponse, ZSuccessResponseSchema } from '../schema';
import { authenticatedProcedure, procedure, router } from '../trpc';
import { findRecipientSuggestionsRoute } from './find-recipient-suggestions';
import {
  ZAdvanceHandoffCandidatesRequestSchema,
  ZAdvanceHandoffCandidatesResponseSchema,
  ZAdvanceHandoffSigningLinkRequestSchema,
  ZCompleteDocumentWithTokenMutationSchema,
  ZCreateDocumentRecipientRequestSchema,
  ZCreateDocumentRecipientResponseSchema,
  ZCreateDocumentRecipientsRequestSchema,
  ZCreateDocumentRecipientsResponseSchema,
  ZCreateTemplateRecipientRequestSchema,
  ZCreateTemplateRecipientResponseSchema,
  ZCreateTemplateRecipientsRequestSchema,
  ZCreateTemplateRecipientsResponseSchema,
  ZDeleteDocumentRecipientRequestSchema,
  ZDeleteTemplateRecipientRequestSchema,
  ZGetRecipientRequestSchema,
  ZGetRecipientResponseSchema,
  ZHandoffSigningLinkResponseSchema,
  ZRejectDocumentWithTokenMutationSchema,
  ZSetDocumentRecipientsRequestSchema,
  ZSetDocumentRecipientsResponseSchema,
  ZSetTemplateRecipientsRequestSchema,
  ZSetTemplateRecipientsResponseSchema,
  ZStartHandoffCandidatesRequestSchema,
  ZStartHandoffCandidatesResponseSchema,
  ZStartHandoffSigningLinkRequestSchema,
  ZStartHandoffSigningLinkResponseSchema,
  ZUpdateDocumentRecipientRequestSchema,
  ZUpdateDocumentRecipientResponseSchema,
  ZUpdateDocumentRecipientsRequestSchema,
  ZUpdateDocumentRecipientsResponseSchema,
  ZUpdateTemplateRecipientRequestSchema,
  ZUpdateTemplateRecipientResponseSchema,
  ZUpdateTemplateRecipientsRequestSchema,
  ZUpdateTemplateRecipientsResponseSchema,
} from './schema';

export const recipientRouter = router({
  suggestions: {
    find: findRecipientSuggestionsRoute,
  },

  /**
   * @public
   */
  getDocumentRecipient: authenticatedProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/document/recipient/{recipientId}',
        summary: 'Get document recipient',
        description:
          'Returns a single recipient. If you want to retrieve all the recipients for a document, use the "Get Document" endpoint.',
        tags: ['Document Recipients'],
      },
    })
    .input(ZGetRecipientRequestSchema)
    .output(ZGetRecipientResponseSchema)
    .query(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { recipientId } = input;

      ctx.logger.info({
        input: {
          recipientId,
        },
      });

      return await getRecipientById({
        userId: ctx.user.id,
        teamId,
        recipientId,
        type: EnvelopeType.DOCUMENT,
      });
    }),

  /**
   * @public
   */
  createDocumentRecipient: authenticatedProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/document/recipient/create',
        summary: 'Create document recipient',
        description: 'Create a single recipient for a document.',
        tags: ['Document Recipients'],
      },
    })
    .input(ZCreateDocumentRecipientRequestSchema)
    .output(ZCreateDocumentRecipientResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { documentId, recipient } = input;

      ctx.logger.info({
        input: {
          documentId,
        },
      });

      const createdRecipients = await createEnvelopeRecipients({
        userId: ctx.user.id,
        teamId,
        id: {
          type: 'documentId',
          id: documentId,
        },
        recipients: [recipient],
        requestMetadata: ctx.metadata,
      });

      return createdRecipients.recipients[0];
    }),

  /**
   * @public
   */
  createDocumentRecipients: authenticatedProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/document/recipient/create-many',
        summary: 'Create document recipients',
        description: 'Create multiple recipients for a document.',
        tags: ['Document Recipients'],
      },
    })
    .input(ZCreateDocumentRecipientsRequestSchema)
    .output(ZCreateDocumentRecipientsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { documentId, recipients } = input;

      ctx.logger.info({
        input: {
          documentId,
        },
      });

      return await createEnvelopeRecipients({
        userId: ctx.user.id,
        teamId,
        id: {
          type: 'documentId',
          id: documentId,
        },
        recipients,
        requestMetadata: ctx.metadata,
      });
    }),

  /**
   * @public
   */
  updateDocumentRecipient: authenticatedProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/document/recipient/update',
        summary: 'Update document recipient',
        description: 'Update a single recipient for a document.',
        tags: ['Document Recipients'],
      },
    })
    .input(ZUpdateDocumentRecipientRequestSchema)
    .output(ZUpdateDocumentRecipientResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { documentId, recipient } = input;

      ctx.logger.info({
        input: {
          documentId,
        },
      });

      const updatedRecipients = await updateEnvelopeRecipients({
        userId: ctx.user.id,
        teamId,
        id: {
          type: 'documentId',
          id: documentId,
        },
        recipients: [recipient],
        requestMetadata: ctx.metadata,
      });

      return updatedRecipients.recipients[0];
    }),

  /**
   * @public
   */
  updateDocumentRecipients: authenticatedProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/document/recipient/update-many',
        summary: 'Update document recipients',
        description: 'Update multiple recipients for a document.',
        tags: ['Document Recipients'],
      },
    })
    .input(ZUpdateDocumentRecipientsRequestSchema)
    .output(ZUpdateDocumentRecipientsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { documentId, recipients } = input;

      ctx.logger.info({
        input: {
          documentId,
        },
      });

      return await updateEnvelopeRecipients({
        userId: ctx.user.id,
        teamId,
        id: {
          type: 'documentId',
          id: documentId,
        },
        recipients,
        requestMetadata: ctx.metadata,
      });
    }),

  /**
   * @public
   */
  deleteDocumentRecipient: authenticatedProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/document/recipient/delete',
        summary: 'Delete document recipient',
        tags: ['Document Recipients'],
      },
    })
    .input(ZDeleteDocumentRecipientRequestSchema)
    .output(ZSuccessResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { recipientId } = input;

      ctx.logger.info({
        input: {
          recipientId,
        },
      });

      await deleteEnvelopeRecipient({
        userId: ctx.user.id,
        teamId,
        recipientId,
        requestMetadata: ctx.metadata,
      });

      return ZGenericSuccessResponse;
    }),

  /**
   * @private
   */
  setDocumentRecipients: authenticatedProcedure
    .input(ZSetDocumentRecipientsRequestSchema)
    .output(ZSetDocumentRecipientsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { documentId, recipients } = input;

      ctx.logger.info({
        input: {
          documentId,
        },
      });

      return await setDocumentRecipients({
        userId: ctx.user.id,
        teamId,
        id: {
          type: 'documentId',
          id: documentId,
        },
        recipients: recipients.map((recipient) => ({
          id: recipient.id,
          email: recipient.email,
          name: recipient.name,
          role: recipient.role,
          signingOrder: recipient.signingOrder,
          actionAuth: recipient.actionAuth,
        })),
        requestMetadata: ctx.metadata,
      });
    }),

  /**
   * @public
   */
  getTemplateRecipient: authenticatedProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/template/recipient/{recipientId}',
        summary: 'Get template recipient',
        description:
          'Returns a single recipient. If you want to retrieve all the recipients for a template, use the "Get Template" endpoint.',
        tags: ['Template Recipients'],
      },
    })
    .input(ZGetRecipientRequestSchema)
    .output(ZGetRecipientResponseSchema)
    .query(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { recipientId } = input;

      ctx.logger.info({
        input: {
          recipientId,
        },
      });

      return await getRecipientById({
        userId: ctx.user.id,
        teamId,
        recipientId,
        type: EnvelopeType.TEMPLATE,
      });
    }),

  /**
   * @public
   */
  createTemplateRecipient: authenticatedProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/template/recipient/create',
        summary: 'Create template recipient',
        description: 'Create a single recipient for a template.',
        tags: ['Template Recipients'],
      },
    })
    .input(ZCreateTemplateRecipientRequestSchema)
    .output(ZCreateTemplateRecipientResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { templateId, recipient } = input;

      ctx.logger.info({
        input: {
          templateId,
        },
      });

      const createdRecipients = await createEnvelopeRecipients({
        userId: ctx.user.id,
        teamId,
        id: {
          id: templateId,
          type: 'templateId',
        },
        recipients: [recipient],
        requestMetadata: ctx.metadata,
      });

      return createdRecipients.recipients[0];
    }),

  /**
   * @public
   */
  createTemplateRecipients: authenticatedProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/template/recipient/create-many',
        summary: 'Create template recipients',
        description: 'Create multiple recipients for a template.',
        tags: ['Template Recipients'],
      },
    })
    .input(ZCreateTemplateRecipientsRequestSchema)
    .output(ZCreateTemplateRecipientsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { templateId, recipients } = input;

      ctx.logger.info({
        input: {
          templateId,
        },
      });

      return await createEnvelopeRecipients({
        userId: ctx.user.id,
        teamId,
        id: {
          id: templateId,
          type: 'templateId',
        },
        recipients,
        requestMetadata: ctx.metadata,
      });
    }),

  /**
   * @public
   */
  updateTemplateRecipient: authenticatedProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/template/recipient/update',
        summary: 'Update template recipient',
        description: 'Update a single recipient for a template.',
        tags: ['Template Recipients'],
      },
    })
    .input(ZUpdateTemplateRecipientRequestSchema)
    .output(ZUpdateTemplateRecipientResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { templateId, recipient } = input;

      ctx.logger.info({
        input: {
          templateId,
        },
      });

      const updatedRecipients = await updateEnvelopeRecipients({
        userId: ctx.user.id,
        teamId,
        id: {
          type: 'templateId',
          id: templateId,
        },
        recipients: [recipient],
        requestMetadata: ctx.metadata,
      });

      return updatedRecipients.recipients[0];
    }),

  /**
   * @public
   */
  updateTemplateRecipients: authenticatedProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/template/recipient/update-many',
        summary: 'Update template recipients',
        description: 'Update multiple recipients for a template.',
        tags: ['Template Recipients'],
      },
    })
    .input(ZUpdateTemplateRecipientsRequestSchema)
    .output(ZUpdateTemplateRecipientsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { templateId, recipients } = input;

      ctx.logger.info({
        input: {
          templateId,
        },
      });

      return await updateEnvelopeRecipients({
        userId: ctx.user.id,
        teamId,
        id: {
          type: 'templateId',
          id: templateId,
        },
        recipients,
        requestMetadata: ctx.metadata,
      });
    }),

  /**
   * @public
   */
  deleteTemplateRecipient: authenticatedProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/template/recipient/delete',
        summary: 'Delete template recipient',
        tags: ['Template Recipients'],
      },
    })
    .input(ZDeleteTemplateRecipientRequestSchema)
    .output(ZSuccessResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { recipientId } = input;

      ctx.logger.info({
        input: {
          recipientId,
        },
      });

      await deleteEnvelopeRecipient({
        recipientId,
        userId: ctx.user.id,
        teamId,
        requestMetadata: ctx.metadata,
      });

      return ZGenericSuccessResponse;
    }),

  /**
   * @private
   */
  setTemplateRecipients: authenticatedProcedure
    .input(ZSetTemplateRecipientsRequestSchema)
    .output(ZSetTemplateRecipientsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { teamId } = ctx;
      const { templateId, recipients } = input;

      ctx.logger.info({
        input: {
          templateId,
        },
      });

      return await setTemplateRecipients({
        userId: ctx.user.id,
        teamId,
        id: {
          type: 'templateId',
          id: templateId,
        },
        recipients: recipients.map((recipient) => ({
          id: recipient.id,
          email: recipient.email,
          name: recipient.name,
          role: recipient.role,
          signingOrder: recipient.signingOrder,
          actionAuth: recipient.actionAuth,
        })),
      });
    }),

  /**
   * @private
   */
  completeDocumentWithToken: procedure
    .input(ZCompleteDocumentWithTokenMutationSchema)
    .mutation(async ({ input, ctx }) => {
      const { token, documentId, accessAuthOptions, nextSigner, recipientOverride } = input;

      ctx.logger.info({
        input: {
          documentId,
        },
      });

      await completeDocumentWithToken({
        token,
        id: {
          type: 'documentId',
          id: documentId,
        },
        accessAuthOptions,
        nextSigner,
        recipientOverride,
        userId: ctx.user?.id,
        requestMetadata: ctx.metadata.requestMetadata,
      });
    }),

  /**
   * @private
   */
  rejectDocumentWithToken: procedure.input(ZRejectDocumentWithTokenMutationSchema).mutation(async ({ input, ctx }) => {
    const { token, documentId, reason } = input;

    ctx.logger.info({
      input: {
        documentId,
      },
    });

    return await rejectDocumentWithToken({
      token,
      id: {
        type: 'documentId',
        id: documentId,
      },
      reason,
      requestMetadata: ctx.metadata.requestMetadata,
    });
  }),

  /**
   * @private
   *
   * DEV-654 in-person handoff -- START. The host explicitly kicking off a
   * session from the authenticated document management page, before anyone
   * has signed anything yet. Deliberately `authenticatedProcedure`, not
   * token-based: a recipient's own signing token must never be sufficient to
   * obtain another recipient's token. `ctx.user` plus the envelope's own
   * `input.teamId` (unvalidated, re-verified fresh by getEnvelopeById on
   * every call -- see the schema doc comment) are the server-verified
   * owner/team identity; never cached, never accepted as a bare claim.
   */
  startHandoffCandidates: authenticatedProcedure
    .input(ZStartHandoffCandidatesRequestSchema)
    .output(ZStartHandoffCandidatesResponseSchema)
    .query(async ({ input, ctx }) => {
      const { documentId, teamId } = input;

      return await getStartHandoffCandidates({
        documentId,
        userId: ctx.user.id,
        teamId,
      });
    }),

  /**
   * @private
   *
   * Besides disclosing the first signer's link, START hands the device over:
   * it mints the envelope-bound handoff capability that authorizes every
   * later ADVANCE, and revokes the host's current session server-side so no
   * signer holding this device ever acts inside the host's account.
   */
  startHandoffSigningLink: authenticatedProcedure
    .input(ZStartHandoffSigningLinkRequestSchema)
    .output(ZStartHandoffSigningLinkResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { documentId, teamId, recipientId } = input;

      // There must be a browser session to hand over (and revoke) -- an
      // API-token caller has none, so it can never start an in-person session.
      // authenticatedMiddleware's two `next()` branches (session vs API token)
      // merge to a `null`-typed session; widen back to TrpcContext's own type.
      const sessionId = (ctx.session as TrpcContext['session'])?.id;

      if (!sessionId) {
        throw new AppError(AppErrorCode.UNAUTHORIZED, {
          message: 'In-person signing can only be started from a signed-in browser session',
        });
      }

      ctx.logger.info({
        input: {
          documentId,
          recipientId,
        },
      });

      const handoff = await getStartHandoffSigningToken({
        documentId,
        recipientId,
        userId: ctx.user.id,
        teamId,
      });

      if (!handoff) {
        throw new AppError(AppErrorCode.NOT_FOUND, {
          message: 'Recipient is not currently eligible to start an in-person session',
        });
      }

      const handoffCapability = mintHandoffCapability({
        envelopeId: handoff.envelopeId,
        documentId,
        hostUserId: ctx.user.id,
        teamId,
      });

      await invalidateSessions({
        userId: ctx.user.id,
        sessionIds: [sessionId],
        metadata: ctx.metadata.requestMetadata,
        isRevoke: false,
      });

      return {
        signingLink: formatSigningLink(handoff.token),
        name: handoff.name,
        email: handoff.email,
        handoffCapability,
      };
    }),

  /**
   * @private
   *
   * DEV-654 in-person handoff -- ADVANCE. Handing the device to the next
   * signer once the recipient behind `completedRecipientToken` has genuinely
   * finished. Deliberately NOT authenticatedProcedure: it runs on the handoff
   * device, where START revoked the host's session. Authorized instead by the
   * host-minted, envelope-bound handoff capability; getAdvanceHandoff*
   * re-verify the host's envelope access and the outgoing recipient's SIGNED
   * status fresh before anything is disclosed. A recipient token without the
   * capability gets nothing.
   */
  advanceHandoffCandidates: procedure
    .input(ZAdvanceHandoffCandidatesRequestSchema)
    .output(ZAdvanceHandoffCandidatesResponseSchema)
    .query(async ({ input }) => {
      return await getAdvanceHandoffCandidates(input).catch(() => []);
    }),

  /**
   * @private
   */
  advanceHandoffSigningLink: procedure
    .input(ZAdvanceHandoffSigningLinkRequestSchema)
    .output(ZHandoffSigningLinkResponseSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.logger.info({
        input: {
          nextRecipientId: input.nextRecipientId,
        },
      });

      const handoff = await getAdvanceHandoffSigningToken(input).catch(() => null);

      if (!handoff) {
        throw new AppError(AppErrorCode.NOT_FOUND, {
          message: 'Outgoing recipient has not completed, or the next recipient is no longer eligible for handoff',
        });
      }

      return {
        signingLink: formatSigningLink(handoff.token),
        name: handoff.name,
        email: handoff.email,
      };
    }),
});
