import type { Recipient } from '@prisma/client';
import { DocumentSigningOrder, DocumentStatus, EnvelopeType, RecipientRole, SigningStatus } from '@prisma/client';

import { isRecipientExpired } from '../../utils/recipients';
import { getEnvelopeById } from '../envelope/get-envelope-by-id';
import { verifyHandoffCapability } from './handoff-capability';

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
 * owner/team check; a recipient token is never accepted as authorization.
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
//
// The "before anyone has signed" boundary is enforced here, not just
// documented: once any SIGNER/APPROVER has signed, START discloses nothing,
// so the only way to hand the device on mid-envelope is ADVANCE with its
// completion proof. Without this, START would be an ADVANCE bypass.
// ---------------------------------------------------------------------------

const resolveStartEligibleRecipients = async (options: GetHandoffOptions) => {
  const { envelope, eligible } = await resolveEligibleRecipients(options);

  const anyoneHasSigned = envelope.recipients.some(
    (r) => HANDOFF_ELIGIBLE_ROLES.includes(r.role) && r.signingStatus === SigningStatus.SIGNED,
  );

  return { envelope, eligible: anyoneHasSigned ? [] : eligible };
};

export const getStartHandoffCandidates = async (options: GetHandoffOptions): Promise<THandoffCandidate[]> => {
  const { eligible } = await resolveStartEligibleRecipients(options);

  return eligible.map(toCandidate);
};

export type GetStartHandoffSigningTokenOptions = GetHandoffOptions & {
  recipientId: number;
};

export const getStartHandoffSigningToken = async ({
  recipientId,
  ...options
}: GetStartHandoffSigningTokenOptions): Promise<(THandoffSigningToken & { envelopeId: string }) | null> => {
  const { envelope, eligible } = await resolveStartEligibleRecipients(options);

  const match = eligible.find((r) => r.id === recipientId);

  return match ? { token: match.token, name: match.name, email: match.email, envelopeId: envelope.id } : null;
};

// ---------------------------------------------------------------------------
// ADVANCE -- handing the device to the *next* signer after a specific
// recipient has genuinely finished. Runs on the handoff device, where the
// host's session was revoked at START, so it is authorized by the
// host-minted handoff capability rather than any session:
//
//   - the capability (HMAC-signed, envelope-bound, expiring) proves the
//     host started an in-person session for THIS envelope on this device.
//     A recipient token alone is never sufficient -- any emailed recipient
//     could otherwise fetch another recipient's link;
//   - the host's access to the envelope is re-verified fresh through
//     getEnvelopeById using the host identity inside the capability;
//   - the outgoing recipient is identified by its own token (the /complete
//     page it is shown on) and must be SIGNED under this fresh read.
// ---------------------------------------------------------------------------

export type AdvanceHandoffOptions = {
  handoffCapability: string;
  /** Token of the recipient who must have actually just completed -- proven fresh below, never trusted as a bare claim. */
  completedRecipientToken: string;
};

const resolveAdvanceEligibleRecipients = async ({
  handoffCapability,
  completedRecipientToken,
}: AdvanceHandoffOptions) => {
  const capability = verifyHandoffCapability(handoffCapability);

  if (!capability || !completedRecipientToken) {
    return [] as Recipient[];
  }

  const { envelope, eligible } = await resolveEligibleRecipients({
    documentId: capability.documentId,
    userId: capability.hostUserId,
    teamId: capability.teamId,
  });

  if (envelope.id !== capability.envelopeId) {
    return [] as Recipient[];
  }

  const completedRecipient = envelope.recipients.find((r) => r.token === completedRecipientToken);

  // The outgoing recipient must belong to this exact envelope and must have
  // an actually-SIGNED status under this fresh read -- NOT_SIGNED, REJECTED,
  // or a foreign token all fail closed here. This is what stops the device
  // from advancing past a signer who hasn't finished (or hasn't even
  // started), independent of whatever the client claims.
  if (!completedRecipient || completedRecipient.signingStatus !== SigningStatus.SIGNED) {
    return [] as Recipient[];
  }

  return eligible.filter((r) => r.id !== completedRecipient.id);
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
