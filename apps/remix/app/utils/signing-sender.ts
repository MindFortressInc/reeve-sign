import { OrganisationType } from '@prisma/client';

type SigningPageSenderOptions = {
  user: { name: string | null; email: string };
  team: { name: string; teamEmail?: { email: string } | null } | null;
  organisationType: OrganisationType | undefined;
  includeSenderDetails: boolean;
};

/**
 * Who the v1 signing page header says invited the recipient, and whether it
 * continues `on behalf of "<team>"`.
 *
 * Mirrors the invite email: on-behalf-of only for ORGANISATION orgs with sender
 * details on (the setting defaults on for personal orgs too), and the name is
 * always the owner's.
 */
export const getSigningPageSender = ({
  user,
  team,
  organisationType,
  includeSenderDetails,
}: SigningPageSenderOptions) => {
  const senderName = user.name ?? '';
  const onBehalfOf = includeSenderDetails && organisationType === OrganisationType.ORGANISATION;

  if (onBehalfOf) {
    return { senderName, senderEmail: team?.teamEmail?.email ? `(${team.teamEmail.email})` : '', onBehalfOf };
  }

  return { senderName, senderEmail: `(${user.email})`, onBehalfOf };
};
