import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSignerProofSetCookie,
  hasSignerProof,
  isRecipientViewer,
  mintSignerProof,
  SIGNER_PROOF_COOKIE_NAME,
} from './signer-proof-cookie';

const TOKEN = 'recipient-token-abc';

const headersWithCookie = (cookie: string) => new Headers({ cookie });

describe('signer proof cookie', () => {
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_SECRET', 'test-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds an HttpOnly, SameSite=Lax cookie path-scoped to the recipient token', () => {
    const setCookie = buildSignerProofSetCookie(TOKEN);

    expect(setCookie).toContain(`${SIGNER_PROOF_COOKIE_NAME}=${mintSignerProof(TOKEN)}`);
    expect(setCookie).toContain(`Path=/sign/${TOKEN}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('never carries the raw token as the cookie value', () => {
    expect(mintSignerProof(TOKEN)).not.toContain(TOKEN);
  });

  it('accepts the proof minted for this token among other cookies', () => {
    const headers = headersWithCookie(`lang=en; ${SIGNER_PROOF_COOKIE_NAME}=${mintSignerProof(TOKEN)}; theme=dark`);

    expect(hasSignerProof(TOKEN, headers)).toBe(true);
  });

  it('rejects a proof minted for a different token', () => {
    const headers = headersWithCookie(`${SIGNER_PROOF_COOKIE_NAME}=${mintSignerProof('other-token')}`);

    expect(hasSignerProof(TOKEN, headers)).toBe(false);
  });

  it('rejects a proof minted under a different secret', () => {
    const proof = mintSignerProof(TOKEN);

    vi.stubEnv('NEXTAUTH_SECRET', 'another-secret');

    expect(hasSignerProof(TOKEN, headersWithCookie(`${SIGNER_PROOF_COOKIE_NAME}=${proof}`))).toBe(false);
  });

  it('rejects missing, empty, malformed and prefix-lookalike cookies without throwing', () => {
    const proof = mintSignerProof(TOKEN);

    expect(hasSignerProof(TOKEN, new Headers())).toBe(false);
    expect(hasSignerProof(TOKEN, headersWithCookie(`${SIGNER_PROOF_COOKIE_NAME}=`))).toBe(false);
    expect(hasSignerProof(TOKEN, headersWithCookie(`${SIGNER_PROOF_COOKIE_NAME}`))).toBe(false);
    expect(hasSignerProof(TOKEN, headersWithCookie(`${SIGNER_PROOF_COOKIE_NAME}x=${proof}`))).toBe(false);
    expect(hasSignerProof(TOKEN, headersWithCookie(`${SIGNER_PROOF_COOKIE_NAME}=${TOKEN}`))).toBe(false);
    expect(hasSignerProof('', headersWithCookie(`${SIGNER_PROOF_COOKIE_NAME}=${proof}`))).toBe(false);
  });

  describe('isRecipientViewer', () => {
    it('admits a session logged in as the recipient, case-insensitively', () => {
      expect(
        isRecipientViewer({
          token: TOKEN,
          headers: new Headers(),
          recipientEmail: 'Signer@Example.com',
          sessionEmail: 'signer@example.com',
        }),
      ).toBe(true);
    });

    it('admits the browser that signed even when logged out', () => {
      expect(
        isRecipientViewer({
          token: TOKEN,
          headers: headersWithCookie(`${SIGNER_PROOF_COOKIE_NAME}=${mintSignerProof(TOKEN)}`),
          recipientEmail: 'signer@example.com',
          sessionEmail: null,
        }),
      ).toBe(true);
    });

    it('refuses an anonymous viewer and a logged-in non-recipient without the proof', () => {
      expect(isRecipientViewer({ token: TOKEN, headers: new Headers(), recipientEmail: 'signer@example.com' })).toBe(
        false,
      );
      expect(
        isRecipientViewer({
          token: TOKEN,
          headers: new Headers(),
          recipientEmail: 'signer@example.com',
          sessionEmail: 'someone-else@example.com',
        }),
      ).toBe(false);
    });
  });
});
