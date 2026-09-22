import { mailer } from '@documenso/email/mailer';
import RecipientRemovedFromDocumentTemplate from '@documenso/email/templates/recipient-removed-from-document';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import { EnvelopeType, SendStatus, SigningStatus } from '@prisma/client';
import { createElement } from 'react';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { extractDerivedDocumentEmailSettings } from '../../types/document-email';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import {
  findFieldsWithDanglingConditions,
  partitionDanglingDependentsBySignedRecipient,
} from '../../utils/field-conditions';
import { canRecipientBeModified, isRecipientEmailValidForSending } from '../../utils/recipients';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';
import { buildTeamWhereQuery } from '../../utils/teams';
import { getEmailContext } from '../email/get-email-context';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';

export interface DeleteEnvelopeRecipientOptions {
  userId: number;
  teamId: number;
  recipientId: number;
  requestMetadata: ApiRequestMetadata;
}

export const deleteEnvelopeRecipient = async ({
  userId,
  teamId,
  recipientId,
  requestMetadata,
}: DeleteEnvelopeRecipientOptions) => {
  const envelope = await prisma.envelope.findFirst({
    where: {
      recipients: {
        some: {
          id: recipientId,
        },
      },
      team: buildTeamWhereQuery({ teamId, userId }),
    },
    include: {
      documentMeta: true,
      team: true,
      recipients: {
        include: {
          fields: true,
        },
      },
    },
  });

  const user = await prisma.user.findFirst({
    where: {
      id: userId,
    },
    select: {
      id: true,
      name: true,
      email: true,
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document not found',
    });
  }

  if (envelope.completedAt) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Document already complete',
    });
  }

  if (!user) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'User not found',
    });
  }

  const recipientToDelete = envelope.recipients.find((recipient) => recipient.id === recipientId);

  if (!recipientToDelete) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Recipient not found',
    });
  }

  if (!canRecipientBeModified(recipientToDelete, recipientToDelete.fields)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Recipient has already interacted with the document.',
    });
  }

  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: {
      type: 'envelopeId',
      id: envelope.id,
    },
    type: null,
    userId,
    teamId,
  });

  const deletedRecipient = await prisma.$transaction(async (tx) => {
    // Lock the envelope row and re-read fresh state, for the same reasons as
    // `delete-envelope-field.ts` / `update-envelope-fields.ts`: this delete's
    // condition-integrity check must never race a concurrent completion or
    // controller mutation.
    await tx.$queryRaw`SELECT id FROM "Envelope" WHERE id = ${envelope.id} FOR UPDATE`;

    const freshEnvelope = await tx.envelope.findUniqueOrThrow({
      where: { id: envelope.id },
      select: { completedAt: true },
    });

    if (freshEnvelope.completedAt) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Document already complete' });
    }

    const freshRecipients = await tx.recipient.findMany({
      where: { envelopeId: envelope.id },
      include: { fields: true },
    });

    const freshRecipientToDelete = freshRecipients.find((r) => r.id === recipientId);

    if (!freshRecipientToDelete) {
      throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Recipient not found' });
    }

    if (!canRecipientBeModified(freshRecipientToDelete, freshRecipientToDelete.fields)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Recipient has already interacted with the document.',
      });
    }

    // The recipient's fields cascade-delete at the DB level (Field.recipient
    // onDelete: Cascade). Any OTHER field whose condition depends on one of them
    // would otherwise be left with a dangling reference — unless that dependent
    // belongs to an already-signed recipient, in which case silently clearing it
    // would alter their frozen obligations/consent, so the whole delete must be
    // rejected instead.
    const deletedFieldIds = new Set(freshRecipientToDelete.fields.map((field) => field.id));
    const allEnvelopeFields = freshRecipients.flatMap((recipient) => recipient.fields);
    const remainingFields = allEnvelopeFields.filter((field) => !deletedFieldIds.has(field.id));

    // Scan for conditions that were ALREADY dangling before this delete (a
    // pre-existing malformed/dangling condition unrelated to the recipient
    // being deleted) so they can be excluded below — otherwise deleting an
    // unrelated recipient could get wrongly rejected because that pre-existing
    // problem happens to belong to a different already-signed recipient. Same
    // reasoning as `delete-envelope-field.ts`'s identical guard.
    const preExistingDanglingFieldIds = new Set(
      findFieldsWithDanglingConditions(allEnvelopeFields, allEnvelopeFields).map((field) => field.id),
    );

    const danglingDependents = findFieldsWithDanglingConditions(remainingFields, remainingFields).filter(
      (field) => !preExistingDanglingFieldIds.has(field.id),
    );

    const signedRecipientIds = new Set(
      freshRecipients.filter((r) => r.signingStatus === SigningStatus.SIGNED && r.id !== recipientId).map((r) => r.id),
    );

    const { safeToClear, mustReject } = partitionDanglingDependentsBySignedRecipient(
      danglingDependents,
      signedRecipientIds,
    );

    if (mustReject.length > 0) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message:
          'This recipient cannot be deleted because it would change a requirement or remove consent for a recipient who has already completed signing',
      });
    }

    if (envelope.type === EnvelopeType.DOCUMENT) {
      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_DELETED,
          envelopeId: envelope.id,
          metadata: requestMetadata,
          data: {
            recipientEmail: recipientToDelete.email,
            recipientName: recipientToDelete.name,
            recipientId: recipientToDelete.id,
            recipientRole: recipientToDelete.role,
          },
        }),
      });
    }

    const deleted = await tx.recipient.delete({
      where: {
        id: recipientId,
        envelope: envelopeWhereInput,
      },
    });

    for (const dependent of safeToClear) {
      const currentMeta =
        typeof dependent.fieldMeta === 'object' && dependent.fieldMeta !== null ? dependent.fieldMeta : {};

      await tx.field.update({
        where: { id: dependent.id },
        data: {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          fieldMeta: { ...currentMeta, condition: null } as PrismaJson.FieldMeta,
        },
      });
    }

    return deleted;
  });

  const isRecipientRemovedEmailEnabled = extractDerivedDocumentEmailSettings(envelope.documentMeta).recipientRemoved;

  // Send email to deleted recipient.
  if (
    recipientToDelete.sendStatus === SendStatus.SENT &&
    isRecipientRemovedEmailEnabled &&
    envelope.type === EnvelopeType.DOCUMENT &&
    isRecipientEmailValidForSending(recipientToDelete)
  ) {
    const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';

    const template = createElement(RecipientRemovedFromDocumentTemplate, {
      documentName: envelope.title,
      inviterName: envelope.team?.name || user.name || undefined,
      assetBaseUrl,
    });

    const { branding, emailLanguage, senderEmail, replyToEmail } = await getEmailContext({
      emailType: 'RECIPIENT',
      source: {
        type: 'team',
        teamId: envelope.teamId,
      },
      meta: envelope.documentMeta,
    });

    const [html, text] = await Promise.all([
      renderEmailWithI18N(template, { lang: emailLanguage, branding }),
      renderEmailWithI18N(template, { lang: emailLanguage, branding, plainText: true }),
    ]);

    const i18n = await getI18nInstance(emailLanguage);

    await mailer.sendMail({
      to: {
        address: recipientToDelete.email,
        name: recipientToDelete.name,
      },
      from: senderEmail,
      replyTo: replyToEmail,
      subject: i18n._(msg`You have been removed from a document`),
      html,
      text,
    });
  }

  return deletedRecipient;
};
