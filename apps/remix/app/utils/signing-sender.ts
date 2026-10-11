type SigningPageSenderOptions = {
  user: { name: string | null; email: string };
  team: { name: string; teamEmail?: { email: string } | null } | null;
  includeSenderDetails: boolean;
};

/**
 * Who the v1 signing page header says invited the recipient.
 *
 * With sender details on, the header continues `on behalf of "<team>"`, so the
 * name stays the owner's, as in the invite email.
 */
export const getSigningPageSender = ({ user, team, includeSenderDetails }: SigningPageSenderOptions) => {
  const senderName = user.name ?? '';

  if (includeSenderDetails) {
    return { senderName, senderEmail: team?.teamEmail?.email ? `(${team.teamEmail.email})` : '' };
  }

  return { senderName, senderEmail: `(${user.email})` };
};
