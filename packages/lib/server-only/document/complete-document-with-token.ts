import { DEFAULT_DOCUMENT_DATE_FORMAT } from '@documenso/lib/constants/date-formats';
import { DEFAULT_DOCUMENT_TIME_ZONE } from '@documenso/lib/constants/time-zones';
import { DOCUMENT_AUDIT_LOG_TYPE, RECIPIENT_DIFF_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { RequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { fieldsContainUnsignedRequiredField } from '@documenso/lib/utils/advanced-fields-helpers';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import {
  assertValidFieldConditionGraph,
  fieldsContainUnsignedRequiredVisibleField,
} from '@documenso/lib/utils/field-conditions';
import { prisma } from '@documenso/prisma';
import {
  DocumentSigningOrder,
  DocumentStatus,
  EnvelopeType,
  FieldType,
  RecipientRole,
  SendStatus,
  SigningStatus,
  WebhookTriggerEvents,
} from '@prisma/client';
import { DateTime } from 'luxon';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { jobs } from '../../jobs/client';
import type { TRecipientAccessAuth } from '../../types/document-auth';
import { DocumentAuth } from '../../types/document-auth';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../types/webhook-payload';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { mapSecondaryIdToDocumentId, unsafeBuildEnvelopeIdQuery } from '../../utils/envelope';
import { assertRecipientNotExpired } from '../../utils/recipients';
import { getIsRecipientsTurnToSign } from '../recipient/get-is-recipient-turn';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';
import { isRecipientAuthorized } from './is-recipient-authorized';
import { sendPendingEmail } from './send-pending-email';

export type CompleteDocumentWithTokenOptions = {
  token: string;
  id: EnvelopeIdOptions;
  userId?: number;
  accessAuthOptions?: TRecipientAccessAuth;
  requestMetadata?: RequestMetadata;
  nextSigner?: {
    email: string;
    name: string;
  };
  /**
   * Override the recipient information. This will only work if the recipient
   * does not have a name or email set.
   */
  recipientOverride?: {
    email?: string;
    name?: string;
  };
};

export const completeDocumentWithToken = async ({
  token,
  id,
  userId,
  accessAuthOptions,
  requestMetadata,
  nextSigner,
  recipientOverride,
}: CompleteDocumentWithTokenOptions) => {
  const envelope = await prisma.envelope.findFirstOrThrow({
    where: {
      ...unsafeBuildEnvelopeIdQuery(id, EnvelopeType.DOCUMENT),
      recipients: {
        some: {
          token,
        },
      },
    },
    include: {
      documentMeta: true,
      recipients: {
        where: {
          token,
        },
      },
    },
  });

  const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

  if (envelope.status !== DocumentStatus.PENDING) {
    throw new Error(`Document ${envelope.id} must be pending`);
  }

  if (envelope.recipients.length === 0) {
    throw new Error(`Document ${envelope.id} has no recipient with token ${token}`);
  }

  const [recipient] = envelope.recipients;

  assertRecipientNotExpired(recipient);

  if (recipient.signingStatus === SigningStatus.SIGNED) {
    throw new Error(`Recipient ${recipient.id} has already signed`);
  }

  if (recipient.signingStatus === SigningStatus.REJECTED) {
    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message: 'Recipient has already rejected the document',
      statusCode: 400,
    });
  }

  if (envelope.documentMeta?.signingOrder === DocumentSigningOrder.SEQUENTIAL) {
    const isRecipientsTurn = await getIsRecipientsTurnToSign({
      token: recipient.token,
    });

    if (!isRecipientsTurn) {
      throw new Error(`Recipient ${recipient.id} attempted to complete the document before it was their turn`);
    }
  }

  // Check ACCESS AUTH 2FA validation during document completion
  const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
    documentAuth: envelope.authOptions,
    recipientAuth: recipient.authOptions,
  });

  if (derivedRecipientAccessAuth.includes(DocumentAuth.TWO_FACTOR_AUTH)) {
    if (!accessAuthOptions) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'Access authentication required',
      });
    }

    if (!recipient.email.trim()) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Recipient ${recipient.id} requires an email because they have auth requirements.`,
      });
    }

    const isValid = await isRecipientAuthorized({
      type: 'ACCESS_2FA',
      documentAuthOptions: envelope.authOptions,
      recipient: recipient,
      userId, // Can be undefined for non-account recipients
      authOptions: accessAuthOptions,
    });

    if (!isValid) {
      await prisma.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_FAILED,
          envelopeId: envelope.id,
          data: {
            recipientId: recipient.id,
            recipientName: recipient.name,
            recipientEmail: recipient.email,
          },
        }),
      });

      throw new AppError(AppErrorCode.TWO_FACTOR_AUTH_FAILED, {
        message: 'Invalid 2FA authentication',
      });
    }

    await prisma.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_VALIDATED,
        envelopeId: envelope.id,
        data: {
          recipientId: recipient.id,
          recipientName: recipient.name,
          recipientEmail: recipient.email,
        },
      }),
    });
  }

  const fields = await prisma.field.findMany({
    where: {
      envelopeId: envelope.id,
      recipientId: recipient.id,
    },
  });

  let recipientName = recipient.name;
  let recipientEmail = recipient.email;

  // Only trim the name if it's been derived.
  if (!recipientName) {
    recipientName = (
      recipientOverride?.name ||
      fields.find((field) => field.type === FieldType.NAME)?.customText ||
      ''
    ).trim();
  }

  // Only trim the email if it's been derived.
  if (!recipient.email) {
    recipientEmail = (
      recipientOverride?.email ||
      fields.find((field) => field.type === FieldType.EMAIL)?.customText ||
      ''
    )
      .trim()
      .toLowerCase();
  }

  if (!recipientEmail) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'Recipient email is required',
    });
  }

  await prisma.$transaction(
    async (tx) => {
      // Take an exclusive lock on the envelope row before re-reading anything, and
      // re-derive every check below from that locked, fresh read rather than the
      // snapshots taken before this transaction. `sign-envelope-field.ts` takes the
      // same lock before allowing a checkbox controller to change, so the two can
      // never race: this completion either fully sees a concurrent controller
      // change (and correctly blocks on a newly-required field) or fully precedes
      // it (in which case that mutation will see THIS recipient as signed and be
      // rejected if it would alter their obligations/consent). The re-check also
      // rejects a duplicate/racing completion of this SAME recipient: a second
      // concurrent request for the same token would otherwise wait for the lock and
      // then blindly re-run the whole completion against a stale "not yet signed"
      // snapshot.
      await tx.$queryRaw`SELECT id FROM "Envelope" WHERE id = ${envelope.id} FOR UPDATE`;

      const freshEnvelope = await tx.envelope.findUniqueOrThrow({
        where: { id: envelope.id },
        select: { status: true, internalVersion: true },
      });
      const freshRecipient = await tx.recipient.findUniqueOrThrow({
        where: { id: recipient.id },
        select: { signingStatus: true },
      });

      if (freshEnvelope.status !== DocumentStatus.PENDING) {
        throw new Error(`Document ${envelope.id} must be pending`);
      }

      if (freshRecipient.signingStatus === SigningStatus.SIGNED) {
        throw new Error(`Recipient ${recipient.id} has already signed`);
      }

      if (freshRecipient.signingStatus === SigningStatus.REJECTED) {
        throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
          message: 'Recipient has already rejected the document',
          statusCode: 400,
        });
      }

      let allEnvelopeFields = await tx.field.findMany({ where: { envelopeId: envelope.id } });
      let freshRecipientFields = allEnvelopeFields.filter((f) => f.recipientId === recipient.id);

      // Auto-insert all un-inserted date fields for V2 envelopes at completion
      // time — inside the lock, after the re-checks above, so a rollback
      // (duplicate/racing completion, a concurrent controller change making a
      // field newly required, a status change) can never leave a date field
      // marked `inserted: true` with an audit-log entry for a completion that
      // didn't actually happen. `fields` (the pre-transaction snapshot, used
      // above only to derive `recipientName`/`recipientEmail`) is deliberately
      // not reused here — `freshRecipientFields` is the lock-protected read.
      const uninsertedDateFields = freshRecipientFields.filter(
        (field) => field.type === FieldType.DATE && !field.inserted,
      );

      if (freshEnvelope.internalVersion === 2 && uninsertedDateFields.length > 0) {
        const formattedDate = DateTime.now()
          .setZone(envelope.documentMeta?.timezone ?? DEFAULT_DOCUMENT_TIME_ZONE)
          .toFormat(envelope.documentMeta?.dateFormat ?? DEFAULT_DOCUMENT_DATE_FORMAT);

        const newDateFieldValues = {
          customText: formattedDate,
          inserted: true,
        };

        await tx.field.updateMany({
          where: {
            id: {
              in: uninsertedDateFields.map((field) => field.id),
            },
          },
          data: {
            ...newDateFieldValues,
          },
        });

        // Create audit log entries for each auto-inserted date field.
        await tx.documentAuditLog.createMany({
          data: uninsertedDateFields.map((field) =>
            createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED,
              envelopeId: envelope.id,
              user: {
                email: recipientEmail,
                name: recipientName,
              },
              requestMetadata,
              data: {
                recipientEmail: recipientEmail,
                recipientId: recipient.id,
                recipientName: recipientName,
                recipientRole: recipient.role,
                fieldId: field.secondaryId,
                field: {
                  type: FieldType.DATE,
                  data: formattedDate,
                },
              },
            }),
          ),
        });

        // Reflect the just-inserted dates in-memory so the visibility checks
        // below see them.
        allEnvelopeFields = allEnvelopeFields.map((field) =>
          field.type === FieldType.DATE && !field.inserted && uninsertedDateFields.some((d) => d.id === field.id)
            ? { ...field, ...newDateFieldValues }
            : field,
        );
        freshRecipientFields = allEnvelopeFields.filter((f) => f.recipientId === recipient.id);
      }

      // Conditional visibility is a V2-only feature (V1 rendering/signing never
      // evaluates it), so only apply the visibility-aware exemption for V2 —
      // anything else must behave EXACTLY as before this feature existed.
      if (freshEnvelope.internalVersion === 2) {
        assertValidFieldConditionGraph(freshRecipientFields, allEnvelopeFields);

        if (fieldsContainUnsignedRequiredVisibleField(freshRecipientFields, allEnvelopeFields)) {
          throw new Error(`Recipient ${recipient.id} has unsigned fields`);
        }
      } else if (fieldsContainUnsignedRequiredField(freshRecipientFields)) {
        throw new Error(`Recipient ${recipient.id} has unsigned fields`);
      }

      await tx.recipient.update({
        where: {
          id: recipient.id,
        },
        data: {
          signingStatus: SigningStatus.SIGNED,
          signedAt: new Date(),
          name: recipientName,
          email: recipientEmail,
        },
      });

      if (recipientEmail !== recipient.email || recipientName !== recipient.name) {
        await tx.documentAuditLog.create({
          data: createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_UPDATED,
            envelopeId: envelope.id,
            user: {
              name: recipientName,
              email: recipientEmail,
            },
            requestMetadata,
            data: {
              recipientEmail: recipient.email,
              recipientName: recipient.name,
              recipientId: recipient.id,
              recipientRole: recipient.role,
              changes: [
                {
                  type: RECIPIENT_DIFF_TYPE.NAME,
                  from: recipient.name,
                  to: recipientName,
                },
                {
                  type: RECIPIENT_DIFF_TYPE.EMAIL,
                  from: recipient.email,
                  to: recipientEmail,
                },
              ],
            },
          }),
        });
      }

      const authOptions = extractDocumentAuthMethods({
        documentAuth: envelope.authOptions,
        recipientAuth: recipient.authOptions,
      });

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED,
          envelopeId: envelope.id,
          user: {
            name: recipientName,
            email: recipientEmail,
          },
          requestMetadata,
          data: {
            recipientEmail: recipientEmail,
            recipientName: recipientName,
            recipientId: recipient.id,
            recipientRole: recipient.role,
            actionAuth: authOptions.derivedRecipientActionAuth,
          },
        }),
      });
    },
    // The shared client's default (`maxWait: 5000, timeout: 10000`) was sized
    // for a single write; this transaction now holds the envelope-row lock
    // across several fresh reads, the DATE auto-insert (field update + a
    // createMany audit log), the recipient update, and its own audit log —
    // real work, not just a lock wait. Two concurrent signers hitting this at
    // once must get a real guard rejection, not an opaque transaction-timeout
    // error from queuing behind the lock.
    { maxWait: 10_000, timeout: 20_000 },
  );

  const envelopeWithRelations = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelope.id },
    include: { documentMeta: true, recipients: true },
  });

  await triggerWebhook({
    event: WebhookTriggerEvents.DOCUMENT_RECIPIENT_COMPLETED,
    data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(envelopeWithRelations)),
    userId: envelope.userId,
    teamId: envelope.teamId,
  });

  await jobs.triggerJob({
    name: 'send.recipient.signed.email',
    payload: {
      documentId: legacyDocumentId,
      recipientId: recipient.id,
    },
  });

  const pendingRecipients = await prisma.recipient.findMany({
    select: {
      id: true,
      signingOrder: true,
      name: true,
      email: true,
      role: true,
    },
    where: {
      envelopeId: envelope.id,
      signingStatus: {
        not: SigningStatus.SIGNED,
      },
      role: {
        not: RecipientRole.CC,
      },
    },
    // Composite sort so our next recipient is always the one with the lowest signing order or id
    // if there is a tie.
    orderBy: [{ signingOrder: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
  });

  if (pendingRecipients.length > 0) {
    await sendPendingEmail({ id, recipientId: recipient.id });

    if (envelope.documentMeta?.signingOrder === DocumentSigningOrder.SEQUENTIAL) {
      const [nextRecipient] = pendingRecipients;

      await prisma.$transaction(async (tx) => {
        if (nextSigner && envelope.documentMeta?.allowDictateNextSigner) {
          await tx.documentAuditLog.create({
            data: createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_UPDATED,
              envelopeId: envelope.id,
              user: {
                name: recipientName,
                email: recipientEmail,
              },
              requestMetadata,
              data: {
                recipientEmail: nextRecipient.email,
                recipientName: nextRecipient.name,
                recipientId: nextRecipient.id,
                recipientRole: nextRecipient.role,
                changes: [
                  {
                    type: RECIPIENT_DIFF_TYPE.NAME,
                    from: nextRecipient.name,
                    to: nextSigner.name,
                  },
                  {
                    type: RECIPIENT_DIFF_TYPE.EMAIL,
                    from: nextRecipient.email,
                    to: nextSigner.email,
                  },
                ],
              },
            }),
          });
        }

        await tx.recipient.update({
          where: { id: nextRecipient.id },
          data: {
            sendStatus: SendStatus.SENT,
            sentAt: new Date(),
            ...(nextSigner && envelope.documentMeta?.allowDictateNextSigner
              ? {
                  name: nextSigner.name,
                  email: nextSigner.email,
                }
              : {}),
          },
        });
      });

      await jobs.triggerJob({
        name: 'send.signing.requested.email',
        payload: {
          userId: envelope.userId,
          documentId: legacyDocumentId,
          recipientId: nextRecipient.id,
          requestMetadata,
        },
      });
    }
  }

  const haveAllRecipientsSigned = await prisma.envelope.findFirst({
    where: {
      id: envelope.id,
      recipients: {
        every: {
          OR: [{ signingStatus: SigningStatus.SIGNED }, { role: RecipientRole.CC }],
        },
      },
    },
  });

  if (haveAllRecipientsSigned) {
    await jobs.triggerJob({
      name: 'internal.seal-document',
      payload: {
        documentId: legacyDocumentId,
        requestMetadata,
      },
    });
  }

  const updatedDocument = await prisma.envelope.findFirstOrThrow({
    where: {
      id: envelope.id,
      type: EnvelopeType.DOCUMENT,
    },
    include: {
      documentMeta: true,
      recipients: true,
    },
  });

  await triggerWebhook({
    event: WebhookTriggerEvents.DOCUMENT_SIGNED,
    data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(updatedDocument)),
    userId: updatedDocument.userId,
    teamId: updatedDocument.teamId ?? undefined,
  });
};
