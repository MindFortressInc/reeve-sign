import type { Recipient } from '@prisma/client';
import { DocumentSigningOrder, DocumentStatus, EnvelopeType, RecipientRole, SigningStatus } from '@prisma/client';

import { isRecipientExpired } from '../../utils/recipients';
import { getEnvelopeById } from '../envelope/get-envelope-by-id';

/**
 * Roles that represent an actual in-person action (sign / approve) and can
 * be a target of an in-person device handoff. VIEWER/CC never act on the
 * document; ASSISTANT is a separate prefill-for-another-signer mechanism
 * (DEV-654 scope note) and is never itself a handoff target.
 */
export const HANDOFF_ELIGIBLE_ROLES: RecipientRole[] = [RecipientRole.SIGNER, RecipientRole.APPROVER];

export type THandoffCandidate = {
  recipientId: number;
  name: string;
  email: string;
  role: RecipientRole;
};

export type THandoffSigningToken = {
  token: string;
  name: string;
  email: string;
};

export type GetHandoffOptions = {
  documentId: number;
  /** Validated against envelope ownership by getEnvelopeById -- never trust a client-supplied claim. */
  userId: number;
  teamId: number;
};

const bySigningOrderThenId = (a: Recipient, b: Recipient) => {
  const aOrder = a.signingOrder ?? Number.MAX_SAFE_INTEGER;
  const bOrder = b.signingOrder ?? Number.MAX_SAFE_INTEGER;

  return aOrder !== bOrder ? aOrder - bOrder : a.id - b.id;
};

const isActionable = (recipient: Recipient) =>
  HANDOFF_ELIGIBLE_ROLES.includes(recipient.role) &&
  recipient.signingStatus === SigningStatus.NOT_SIGNED &&
  !isRecipientExpired(recipient);

/**
 * Resolves the set of recipients who could be handed the device to next,
 * recomputed fresh from the DB on every call -- never from a client-supplied
 * "I just completed" claim. Authorization is entirely via getEnvelopeById's
 * owner/team check; a recipient token is never accepted here.
 */
const resolveEligibleRecipients = async ({ documentId, userId, teamId }: GetHandoffOptions) => {
  const envelope = await getEnvelopeById({
    id: { type: 'documentId', id: documentId },
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  });

  if (envelope.status !== DocumentStatus.PENDING || envelope.deletedAt) {
    return { envelope, eligible: [] as Recipient[] };
  }

  const recipients = [...envelope.recipients].sort(bySigningOrderThenId);

  const signingOrder = envelope.documentMeta?.signingOrder ?? DocumentSigningOrder.PARALLEL;

  if (signingOrder !== DocumentSigningOrder.SEQUENTIAL) {
    return { envelope, eligible: recipients.filter(isActionable) };
  }

  // SEQUENTIAL mirrors getIsRecipientsTurnToSign: only the first recipient
  // (in order) who has not yet signed is eligible right now. If that
  // recipient's role isn't actionable (e.g. a CC recipient holds this
  // signingOrder slot), nobody is currently eligible -- err on no
  // disclosure rather than skipping ahead in the order.
  const firstUnsigned = recipients.find((r) => r.signingStatus !== SigningStatus.SIGNED);

  return { envelope, eligible: firstUnsigned && isActionable(firstUnsigned) ? [firstUnsigned] : [] };
};

const toCandidate = (r: Recipient): THandoffCandidate => ({
  recipientId: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
});

// ---------------------------------------------------------------------------
// START -- the host explicitly kicking off an in-person session from the
// authenticated document management page, before anyone has signed anything
// yet. Never used from a post-completion page; carries no proof of, and
// makes no claim about, any prior signer having completed.
// ---------------------------------------------------------------------------

// A genuine START never has a SIGNED recipient on the envelope yet -- the
// instant anyone has actually completed, the only server-authorized way to
// disclose the next link is ADVANCE, which re-verifies completedRecipientId
// fresh. This is what stops an authenticated host from calling START again
// mid-sequence (SEQUENTIAL) or for a still-outstanding co-signer (PARALLEL)
// to sidestep ADVANCE's completion proof -- derived from existing
// recipient.signingStatus rows, no new state to track.
const isGenuineStart = (envelope: { recipients: Recipient[] }) =>
  !envelope.recipients.some((r) => r.signingStatus === SigningStatus.SIGNED);

export const getStartHandoffCandidates = async (options: GetHandoffOptions): Promise<THandoffCandidate[]> => {
  const { envelope, eligible } = await resolveEligibleRecipients(options);

  if (!isGenuineStart(envelope)) {
    return [];
  }

  return eligible.map(toCandidate);
};

export type GetStartHandoffSigningTokenOptions = GetHandoffOptions & {
  recipientId: number;
};

export const getStartHandoffSigningToken = async ({
  recipientId,
  ...options
}: GetStartHandoffSigningTokenOptions): Promise<THandoffSigningToken | null> => {
  const { envelope, eligible } = await resolveEligibleRecipients(options);

  if (!isGenuineStart(envelope)) {
    return null;
  }

  const match = eligible.find((r) => r.id === recipientId);

  return match ? { token: match.token, name: match.name, email: match.email } : null;
};

// ---------------------------------------------------------------------------
// ADVANCE -- handing the device to the *next* signer after a specific
// recipient has genuinely finished. Deliberately a separate, non-bypassable
// operation from START: `completedRecipientId` is required (not optional)
// and is re-verified against a fresh DB read on every call -- a caller can
// never skip this by simply omitting it, and host authorization alone is
// never sufficient without it.
// ---------------------------------------------------------------------------

export type AdvanceHandoffOptions = GetHandoffOptions & {
  /** The recipient who must have actually just completed, proven fresh below -- never trusted as a bare claim. */
  completedRecipientId: number;
};

const resolveAdvanceEligibleRecipients = async ({ completedRecipientId, ...options }: AdvanceHandoffOptions) => {
  const { envelope, eligible } = await resolveEligibleRecipients(options);

  const completedRecipient = envelope.recipients.find((r) => r.id === completedRecipientId);

  // The outgoing recipient must belong to this exact envelope and must have
  // an actually-SIGNED status under this fresh read -- NOT_SIGNED, REJECTED,
  // or a foreign recipientId all fail closed here. This is what stops a host
  // from advancing past a signer who hasn't finished (or hasn't even
  // started), independent of whatever the client claims.
  if (!completedRecipient || completedRecipient.signingStatus !== SigningStatus.SIGNED) {
    return [] as Recipient[];
  }

  return eligible.filter((r) => r.id !== completedRecipientId);
};

export const getAdvanceHandoffCandidates = async (options: AdvanceHandoffOptions): Promise<THandoffCandidate[]> => {
  const eligible = await resolveAdvanceEligibleRecipients(options);

  return eligible.map(toCandidate);
};

export type GetAdvanceHandoffSigningTokenOptions = AdvanceHandoffOptions & {
  nextRecipientId: number;
};

export const getAdvanceHandoffSigningToken = async ({
  nextRecipientId,
  ...options
}: GetAdvanceHandoffSigningTokenOptions): Promise<THandoffSigningToken | null> => {
  const eligible = await resolveAdvanceEligibleRecipients(options);

  const match = eligible.find((r) => r.id === nextRecipientId);

  return match ? { token: match.token, name: match.name, email: match.email } : null;
};
