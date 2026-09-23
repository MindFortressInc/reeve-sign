import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HANDOFF_CAPABILITY_TTL_MS, mintHandoffCapability, verifyHandoffCapability } from './handoff-capability';

const PAYLOAD = { envelopeId: 'envelope-1', documentId: 1, hostUserId: 7, teamId: 3 };

describe('handoff capability', () => {
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_SECRET', 'test-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('round-trips the payload with an expiry TTL from mint time', () => {
    const now = 1_700_000_000_000;

    expect(verifyHandoffCapability(mintHandoffCapability(PAYLOAD, now), now)).toEqual({
      ...PAYLOAD,
      expiresAt: now + HANDOFF_CAPABILITY_TTL_MS,
    });
  });

  it('rejects once expired', () => {
    const now = 1_700_000_000_000;
    const capability = mintHandoffCapability(PAYLOAD, now);

    expect(verifyHandoffCapability(capability, now + HANDOFF_CAPABILITY_TTL_MS)).toBeNull();
  });

  it('rejects a capability signed under a different secret', () => {
    const capability = mintHandoffCapability(PAYLOAD);

    vi.stubEnv('NEXTAUTH_SECRET', 'another-secret');

    expect(verifyHandoffCapability(capability)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const [, signature] = mintHandoffCapability(PAYLOAD).split('.');
    const escalated = Buffer.from(
      JSON.stringify({ ...PAYLOAD, envelopeId: 'envelope-2', expiresAt: Date.now() + 1e9 }),
    ).toString('base64url');

    expect(verifyHandoffCapability(`${escalated}.${signature}`)).toBeNull();
  });

  it('never throws on malformed input', () => {
    for (const value of [undefined, null, '', 'abc', 'a.b', 'a.b.c', '..', `${'x'.repeat(10)}.`]) {
      expect(verifyHandoffCapability(value)).toBeNull();
    }
  });

  it('refuses to mint without NEXTAUTH_SECRET (fails closed)', () => {
    vi.stubEnv('NEXTAUTH_SECRET', '');

    expect(() => mintHandoffCapability(PAYLOAD)).toThrow('NEXTAUTH_SECRET is not set');
  });
});
