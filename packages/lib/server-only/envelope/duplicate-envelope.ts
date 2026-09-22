import { prisma } from '@documenso/prisma';
import type { Field } from '@prisma/client';
import { DocumentSource, EnvelopeType, WebhookTriggerEvents } from '@prisma/client';
import pMap from 'p-map';
import { omit } from 'remeda';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../types/webhook-payload';
import { nanoid, prefixedId } from '../../universal/id';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { remapFieldConditionReferences } from '../../utils/field-conditions';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { incrementDocumentId, incrementTemplateId } from '../envelope/increment-id';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';

export interface DuplicateEnvelopeOptions {
  id: EnvelopeIdOptions;
  userId: number;
  teamId: number;
  overrides?: {
    duplicateAsTemplate?: boolean;
    includeRecipients?: boolean;
    includeFields?: boolean;
  };
}

export const duplicateEnvelope = async ({ id, userId, teamId, overrides }: DuplicateEnvelopeOptions) => {
  const { duplicateAsTemplate = false, includeRecipients = true, includeFields = true } = overrides ?? {};

  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type: null,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    select: {
      type: true,
      title: true,
      userId: true,
      internalVersion: true,
      templateType: true,
      publicTitle: true,
      publicDescription: true,
      envelopeItems: {
        include: {
          documentData: {
            select: {
              data: true,
              initialData: true,
              type: true,
            },
          },
        },
      },
      authOptions: true,
      visibility: true,
      documentMeta: true,
      recipients: {
        select: {
          email: true,
          name: true,
          role: true,
          signingOrder: true,
          fields: true,
        },
      },
      teamId: true,
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document not found',
    });
  }

  if (duplicateAsTemplate && envelope.type !== EnvelopeType.DOCUMENT) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Only documents can be saved as templates',
    });
  }

  const targetType = duplicateAsTemplate ? EnvelopeType.TEMPLATE : envelope.type;

  const [{ legacyNumberId, secondaryId }, createdDocumentMeta] = await Promise.all([
    targetType === EnvelopeType.DOCUMENT
      ? incrementDocumentId().then(({ documentId, formattedDocumentId }) => ({
          legacyNumberId: documentId,
          secondaryId: formattedDocumentId,
        }))
      : incrementTemplateId().then(({ templateId, formattedTemplateId }) => ({
          legacyNumberId: templateId,
          secondaryId: formattedTemplateId,
        })),
    prisma.documentMeta.create({
      data: {
        ...omit(envelope.documentMeta, ['id']),
        emailSettings: envelope.documentMeta.emailSettings || undefined,
      },
    }),
  ]);

  const duplicatedTemplateType =
    envelope.templateType === 'ORGANISATION' && envelope.teamId !== teamId
      ? 'PRIVATE'
      : (envelope.templateType ?? undefined);

  const duplicatedEnvelope = await prisma.envelope.create({
    data: {
      id: prefixedId('envelope'),
      secondaryId,
      type: targetType,
      internalVersion: envelope.internalVersion,
      userId,
      teamId,
      title: envelope.title + ' (copy)',
      documentMetaId: createdDocumentMeta.id,
      authOptions: envelope.authOptions || undefined,
      visibility: envelope.visibility,
      templateType: duplicatedTemplateType,
      publicTitle: envelope.publicTitle ?? undefined,
      publicDescription: envelope.publicDescription ?? undefined,
      source: targetType === EnvelopeType.DOCUMENT ? DocumentSource.DOCUMENT : DocumentSource.TEMPLATE,
    },
    include: {
      recipients: true,
      documentMeta: true,
    },
  });

  // Key = original envelope item ID
  // Value = duplicated envelope item ID.
  const oldEnvelopeItemToNewEnvelopeItemIdMap: Record<string, string> = {};

  // Duplicate the envelope items.
  await Promise.all(
    envelope.envelopeItems.map(async (envelopeItem) => {
      const duplicatedDocumentData = await prisma.documentData.create({
        data: {
          type: envelopeItem.documentData.type,
          data: envelopeItem.documentData.initialData,
          initialData: envelopeItem.documentData.initialData,
        },
      });

      const duplicatedEnvelopeItem = await prisma.envelopeItem.create({
        data: {
          id: prefixedId('envelope_item'),
          title: envelopeItem.title,
          order: envelopeItem.order,
          envelopeId: duplicatedEnvelope.id,
          documentDataId: duplicatedDocumentData.id,
        },
      });

      oldEnvelopeItemToNewEnvelopeItemIdMap[envelopeItem.id] = duplicatedEnvelopeItem.id;
    }),
  );

  if (includeRecipients) {
    // Recipients are created first (without their fields) so every field creation
    // below is a single flat, individually-awaited pass. createMany does not
    // return created rows, and nesting it per-recipient under a pMap(concurrency:5)
    // made new field ids non-deterministic across recipients — field-to-field
    // condition references need a reliable old-id -> new-id map, which requires
    // knowing each new field's real id as it is created.
    const duplicatedRecipients = await pMap(
      envelope.recipients,
      async (recipient) => {
        const created = await prisma.recipient.create({
          data: {
            envelopeId: duplicatedEnvelope.id,
            email: recipient.email,
            name: recipient.name,
            role: recipient.role,
            signingOrder: recipient.signingOrder,
            token: nanoid(),
          },
        });

        return { original: recipient, created };
      },
      { concurrency: 5 },
    );

    if (includeFields) {
      const oldFieldIdToNewFieldId: Record<number, number> = {};

      const newFields: Field[] = [];

      for (const { original, created } of duplicatedRecipients) {
        for (const field of original.fields) {
          const newField = await prisma.field.create({
            data: {
              envelopeId: duplicatedEnvelope.id,
              envelopeItemId: oldEnvelopeItemToNewEnvelopeItemIdMap[field.envelopeItemId],
              recipientId: created.id,
              type: field.type,
              page: field.page,
              positionX: field.positionX,
              positionY: field.positionY,
              width: field.width,
              height: field.height,
              customText: '',
              inserted: false,
              fieldMeta: field.fieldMeta as PrismaJson.FieldMeta,
            },
          });

          oldFieldIdToNewFieldId[field.id] = newField.id;
          newFields.push(newField);
        }
      }

      await remapFieldConditionReferences({ tx: prisma, newFields, oldFieldIdToNewFieldId });
    }
  }

  if (duplicatedEnvelope.type === EnvelopeType.DOCUMENT) {
    const refetchedEnvelope = await prisma.envelope.findFirstOrThrow({
      where: {
        id: duplicatedEnvelope.id,
      },
      include: {
        documentMeta: true,
        recipients: true,
      },
    });

    await triggerWebhook({
      event: WebhookTriggerEvents.DOCUMENT_CREATED,
      data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(refetchedEnvelope)),
      userId: userId,
      teamId: teamId,
    });
  }

  return {
    id: duplicatedEnvelope.id,
    envelope: duplicatedEnvelope,
    legacyId: {
      type: duplicatedEnvelope.type,
      id: legacyNumberId,
    },
  };
};
