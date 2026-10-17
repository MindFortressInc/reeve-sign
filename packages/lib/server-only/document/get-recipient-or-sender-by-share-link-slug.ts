import { prisma } from '@documenso/prisma';

export type GetRecipientOrSenderByShareLinkSlugOptions = {
  slug: string;
};

// Returns null for an unknown/deleted slug or a share link whose sender and
// recipient are gone, so callers can answer 404 instead of throwing (DEV-15850).
export const getRecipientOrSenderByShareLinkSlug = async ({ slug }: GetRecipientOrSenderByShareLinkSlugOptions) => {
  const shareLink = await prisma.documentShareLink.findFirst({
    where: {
      slug,
    },
  });

  if (!shareLink) {
    return null;
  }

  const { envelopeId, email } = shareLink;

  const sender = await prisma.user.findFirst({
    where: {
      envelopes: { some: { id: envelopeId } },
      email,
    },
    select: {
      email: true,
      name: true,
      signature: true,
    },
  });

  if (sender) {
    return sender;
  }

  const recipient = await prisma.recipient.findFirst({
    where: {
      envelopeId,
      email,
    },
    select: {
      email: true,
      name: true,
      signatures: true,
    },
  });

  return recipient;
};
