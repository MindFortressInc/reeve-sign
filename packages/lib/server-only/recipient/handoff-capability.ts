import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { env } from '../../utils/env';

/**
 * DEV-654 in-person handoff capability.
 *
 * Minted by START (the only step that runs under the host's own
 * authenticated session) and held by the handoff device from then on. The
 * host's session on that device is revoked at the same moment, so every
 * later ADVANCE is authorized by this capability -- never by a host session
 * sitting in a browser that a signer is holding.
 *
 * It is scoped to exactly one envelope and one host, expires, and on its own
 * discloses nothing: ADVANCE still re-verifies the host's access to the
 * envelope and the outgoing recipient's SIGNED status fresh on every call.
 */
export const HANDOFF_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1000;

const ZHandoffCapabilityPayloadSchema = z.object({
  envelopeId: z.string(),
  documentId: z.number(),
  hostUserId: z.number(),
  teamId: z.number(),
  expiresAt: z.number(),
});

export type THandoffCapabilityPayload = z.infer<typeof ZHandoffCapabilityPayloadSchema>;

/** Domain-separated from NEXTAUTH_SECRET's other uses (session/CSRF cookie signing). */
const getSigningKey = () => {
  const authSecret = env('NEXTAUTH_SECRET');

  if (!authSecret) {
    throw new Error('NEXTAUTH_SECRET is not set');
  }

  return createHmac('sha256', authSecret).update('reeve-sign:dev-654:in-person-handoff-capability').digest();
};

const sign = (encodedPayload: string) =>
  createHmac('sha256', getSigningKey()).update(encodedPayload).digest('base64url');

export const mintHandoffCapability = (
  payload: Omit<THandoffCapabilityPayload, 'expiresAt'>,
  now = Date.now(),
): string => {
  const encodedPayload = Buffer.from(
    JSON.stringify({ ...payload, expiresAt: now + HANDOFF_CAPABILITY_TTL_MS }),
    'utf8',
  ).toString('base64url');

  return `${encodedPayload}.${sign(encodedPayload)}`;
};

/**
 * Returns the payload only for an untampered, unexpired capability. Never
 * throws on attacker-supplied input -- any malformed value is simply null.
 */
export const verifyHandoffCapability = (
  capability: string | null | undefined,
  now = Date.now(),
): THandoffCapabilityPayload | null => {
  if (!capability) {
    return null;
  }

  const [encodedPayload, signature, ...rest] = capability.split('.');

  if (!encodedPayload || !signature || rest.length > 0) {
    return null;
  }

  const expected = Buffer.from(sign(encodedPayload), 'utf8');
  const provided = Buffer.from(signature, 'utf8');

  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return null;
  }

  try {
    const payload = ZHandoffCapabilityPayloadSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')),
    );

    return payload.expiresAt > now ? payload : null;
  } catch {
    return null;
  }
};
