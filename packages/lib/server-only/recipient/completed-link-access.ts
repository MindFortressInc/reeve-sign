import { prisma } from '@documenso/prisma';
import { DocumentStatus } from '@prisma/client';

/**
 * DEV-15772: a signing link (`/sign/<token>`) is a bearer credential that
 * outlives the signing, and signers forward it. For the first
 * COMPLETED_LINK_TTL_DAYS after the envelope completes, anyone holding the link
 * sees the completed page and can download the signed PDF. After that, only a
 * session logged in as the document owner or as the recipient can; everyone
 * else gets the "link has expired" state and no PDF bytes.
 *
 * A link whose envelope has not completed never expires here: signers need the
 * page and the PDF to sign.
 */
export const COMPLETED_LINK_TTL_DAYS = 7;

const COMPLETED_LINK_TTL_MS = COMPLETED_LINK_TTL_DAYS * 24 * 60 * 60 * 1000;

type SessionUser = { id: number; email: string } | null | undefined;

type IsCompletedLinkExpiredOptions = {
  status: DocumentStatus;
  /** The envelope's completedAt; null while it is not completed. */
  completedAt: Date | null;
  now?: Date;
};

export const isCompletedLinkExpired = ({ status, completedAt, now = new Date() }: IsCompletedLinkExpiredOptions) => {
  if (completedAt === null) {
    // A COMPLETED row with no completedAt predates the column: long past the window.
    return status === DocumentStatus.COMPLETED;
  }

  return now.getTime() - completedAt.getTime() > COMPLETED_LINK_TTL_MS;
};

type CanViewCompletedLinkOptions = IsCompletedLinkExpiredOptions & {
  sessionUser: SessionUser;
  recipientEmail: string;
  ownerId: number;
};

export const canViewCompletedLink = ({
  sessionUser,
  recipientEmail,
  ownerId,
  ...expiry
}: CanViewCompletedLinkOptions) => {
  if (!isCompletedLinkExpired(expiry)) {
    return true;
  }

  if (!sessionUser) {
    return false;
  }

  return sessionUser.id === ownerId || sessionUser.email.toLowerCase() === recipientEmail.toLowerCase();
};

/** Same rule, for routes that only hold the recipient token (the token PDF endpoints). */
export const canViewCompletedLinkByToken = async ({
  token,
  sessionUser,
}: {
  token: string;
  sessionUser: SessionUser;
}) => {
  const recipient = await prisma.recipient.findFirst({
    where: { token },
    select: {
      email: true,
      envelope: { select: { status: true, completedAt: true, userId: true } },
    },
  });

  if (!recipient) {
    return false;
  }

  return canViewCompletedLink({
    status: recipient.envelope.status,
    completedAt: recipient.envelope.completedAt,
    sessionUser,
    recipientEmail: recipient.email,
    ownerId: recipient.envelope.userId,
  });
};
