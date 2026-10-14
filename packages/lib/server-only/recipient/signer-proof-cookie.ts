import { createHmac, timingSafeEqual } from 'node:crypto';

import { formatSecureCookieName, useSecureCookies } from '../../constants/auth';
import { env } from '../../utils/env';

/**
 * DEV-15772 signer proof.
 *
 * A signing link (`/sign/<token>`) is a bearer credential that outlives the
 * signing itself: the signer forwards it, and whoever opens it lands on the
 * completion page. This cookie is set on the browser that actually completed
 * the signing, so the completion page can show the full view to that browser
 * (or to a session logged in as the recipient) and a redacted, blurred view to
 * everyone else holding the same link.
 *
 * The value is an HMAC of the recipient token, so it cannot be minted without
 * NEXTAUTH_SECRET, and it is path-scoped to `/sign/<token>` so it is only ever
 * sent back to that one recipient's routes.
 */
export const SIGNER_PROOF_COOKIE_NAME = formatSecureCookieName('signer-proof');

export const SIGNER_PROOF_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/** Domain-separated from NEXTAUTH_SECRET's other uses (session/CSRF cookies, DEV-654 handoff). */
const getSigningKey = () => {
  const authSecret = env('NEXTAUTH_SECRET');

  if (!authSecret) {
    throw new Error('NEXTAUTH_SECRET is not set');
  }

  return createHmac('sha256', authSecret).update('reeve-sign:dev-15772:signer-proof').digest();
};

export const mintSignerProof = (token: string) =>
  createHmac('sha256', getSigningKey()).update(token).digest('base64url');

export const buildSignerProofSetCookie = (token: string) => {
  const attributes = [
    `${SIGNER_PROOF_COOKIE_NAME}=${mintSignerProof(token)}`,
    `Path=/sign/${encodeURIComponent(token)}`,
    `Max-Age=${SIGNER_PROOF_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (useSecureCookies) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
};

/**
 * True when the request carries a signer proof minted for exactly this token.
 * Never throws on attacker-supplied input.
 */
export const hasSignerProof = (token: string, headers: Headers): boolean => {
  const cookieHeader = headers.get('cookie');

  if (!token || !cookieHeader) {
    return false;
  }

  const expected = Buffer.from(mintSignerProof(token), 'utf8');

  return cookieHeader.split(';').some((pair) => {
    const separatorIndex = pair.indexOf('=');

    if (separatorIndex === -1 || pair.slice(0, separatorIndex).trim() !== SIGNER_PROOF_COOKIE_NAME) {
      return false;
    }

    const provided = Buffer.from(pair.slice(separatorIndex + 1).trim(), 'utf8');

    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
};

type IsRecipientViewerOptions = {
  token: string;
  headers: Headers;
  recipientEmail: string;
  sessionEmail?: string | null;
};

/**
 * The completion page's full view (signer name, signature, download) is for
 * the browser that signed, or a session logged in as the recipient. Everyone
 * else holding the link gets the redacted view.
 */
export const isRecipientViewer = ({ token, headers, recipientEmail, sessionEmail }: IsRecipientViewerOptions) => {
  if (sessionEmail && sessionEmail.toLowerCase() === recipientEmail.toLowerCase()) {
    return true;
  }

  return hasSignerProof(token, headers);
};
