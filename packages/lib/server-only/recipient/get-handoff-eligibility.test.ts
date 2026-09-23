import { DocumentSigningOrder, DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getEnvelopeByIdMock } = vi.hoisted(() => ({
  getEnvelopeByIdMock: vi.fn(),
}));

vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeById: getEnvelopeByIdMock,
}));

import {
  getAdvanceHandoffCandidates,
  getAdvanceHandoffSigningToken,
  getStartHandoffCandidates,
  getStartHandoffSigningToken,
} from './get-handoff-eligibility';
import { HANDOFF_CAPABILITY_TTL_MS, mintHandoffCapability } from './handoff-capability';

beforeAll(() => {
  vi.stubEnv('NEXTAUTH_SECRET', 'test-secret');
});

/** A valid capability for the default fixture envelope, as minted by START. */
const capability = (overrides: Partial<Parameters<typeof mintHandoffCapability>[0]> = {}, now?: number) =>
  mintHandoffCapability({ envelopeId: 'envelope-1', documentId: 1, hostUserId: 1, teamId: 1, ...overrides }, now);

const baseRecipient = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  envelopeId: 'envelope-1',
  name: 'Recipient',
  email: 'recipient@example.com',
  role: RecipientRole.SIGNER,
  signingOrder: null,
  signingStatus: SigningStatus.NOT_SIGNED,
  token: `token-${overrides.id ?? 1}`,
  expiresAt: null,
  ...overrides,
});

const baseEnvelope = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'envelope-1',
  status: DocumentStatus.PENDING,
  deletedAt: null,
  documentMeta: { signingOrder: DocumentSigningOrder.PARALLEL },
  recipients: [],
  ...overrides,
});

describe('getStartHandoffCandidates', () => {
  beforeEach(() => {
    getEnvelopeByIdMock.mockReset();
  });

  it('returns no candidates when the envelope is not PENDING', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        status: DocumentStatus.COMPLETED,
        recipients: [baseRecipient({ id: 2, signingStatus: SigningStatus.NOT_SIGNED })],
      }),
    );

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result).toEqual([]);
  });

  it('returns no candidates when the envelope is deleted', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        deletedAt: new Date(),
        recipients: [baseRecipient({ id: 2 })],
      }),
    );

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result).toEqual([]);
  });

  it('PARALLEL: returns every NOT_SIGNED SIGNER/APPROVER recipient regardless of order', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.PARALLEL },
        recipients: [
          baseRecipient({ id: 1, role: RecipientRole.CC, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({ id: 2, role: RecipientRole.SIGNER, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({ id: 3, role: RecipientRole.APPROVER, signingStatus: SigningStatus.NOT_SIGNED }),
        ],
      }),
    );

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result.map((c) => c.recipientId).sort()).toEqual([2, 3]);
  });

  it('PARALLEL: excludes CC, VIEWER and ASSISTANT roles', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.PARALLEL },
        recipients: [
          baseRecipient({ id: 1, role: RecipientRole.CC, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({ id: 2, role: RecipientRole.VIEWER, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({ id: 3, role: RecipientRole.ASSISTANT, signingStatus: SigningStatus.NOT_SIGNED }),
        ],
      }),
    );

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result).toEqual([]);
  });

  it('PARALLEL: excludes expired recipients', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.PARALLEL },
        recipients: [
          baseRecipient({
            id: 1,
            signingStatus: SigningStatus.NOT_SIGNED,
            expiresAt: new Date(Date.now() - 60_000),
          }),
        ],
      }),
    );

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result).toEqual([]);
  });

  it('SEQUENTIAL: returns only the earliest-ordered unsigned eligible recipient', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.SEQUENTIAL },
        recipients: [
          baseRecipient({ id: 3, signingOrder: 3, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({ id: 1, signingOrder: 1, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({ id: 2, signingOrder: 2, signingStatus: SigningStatus.NOT_SIGNED }),
        ],
      }),
    );

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result.map((c) => c.recipientId)).toEqual([1]);
  });

  it('SEQUENTIAL: surfaces nobody when the next-in-order recipient is not an eligible role (e.g. CC)', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.SEQUENTIAL },
        recipients: [
          baseRecipient({ id: 2, role: RecipientRole.CC, signingOrder: 2, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({
            id: 3,
            role: RecipientRole.SIGNER,
            signingOrder: 3,
            signingStatus: SigningStatus.NOT_SIGNED,
          }),
        ],
      }),
    );

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result).toEqual([]);
  });

  it('SEQUENTIAL: returns nobody once everyone has signed', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.SEQUENTIAL },
        recipients: [
          baseRecipient({ id: 1, signingOrder: 1, signingStatus: SigningStatus.SIGNED }),
          baseRecipient({ id: 2, signingOrder: 2, signingStatus: SigningStatus.SIGNED }),
        ],
      }),
    );

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result).toEqual([]);
  });

  it('START boundary: discloses nobody once any SIGNER/APPROVER has signed (PARALLEL) -- mid-envelope handoff must go through ADVANCE', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.PARALLEL },
        recipients: [
          baseRecipient({ id: 1, role: RecipientRole.SIGNER, signingStatus: SigningStatus.SIGNED }),
          baseRecipient({ id: 2, role: RecipientRole.SIGNER, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({ id: 3, role: RecipientRole.APPROVER, signingStatus: SigningStatus.NOT_SIGNED }),
        ],
      }),
    );

    expect(await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 })).toEqual([]);
    expect(await getStartHandoffSigningToken({ documentId: 1, userId: 1, teamId: 1, recipientId: 2 })).toBeNull();
  });

  it('START boundary: discloses nobody once the first SEQUENTIAL signer has signed', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.SEQUENTIAL },
        recipients: [
          baseRecipient({ id: 1, signingOrder: 1, signingStatus: SigningStatus.SIGNED }),
          baseRecipient({ id: 2, signingOrder: 2, signingStatus: SigningStatus.NOT_SIGNED }),
        ],
      }),
    );

    expect(await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 })).toEqual([]);
    expect(await getStartHandoffSigningToken({ documentId: 1, userId: 1, teamId: 1, recipientId: 2 })).toBeNull();
  });

  it('START boundary: a VIEWER having viewed does not close it (only signing roles count)', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.PARALLEL },
        recipients: [
          baseRecipient({ id: 1, role: RecipientRole.VIEWER, signingStatus: SigningStatus.SIGNED }),
          baseRecipient({ id: 2, role: RecipientRole.SIGNER, signingStatus: SigningStatus.NOT_SIGNED }),
        ],
      }),
    );

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result.map((c) => c.recipientId)).toEqual([2]);
  });

  it('never includes a token field on candidates', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        recipients: [baseRecipient({ id: 2, token: 'super-secret-token' })],
      }),
    );

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result[0]).not.toHaveProperty('token');
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
  });
});

describe('getStartHandoffSigningToken', () => {
  beforeEach(() => {
    getEnvelopeByIdMock.mockReset();
  });

  it('returns the token only for a currently-eligible recipientId', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.PARALLEL },
        recipients: [baseRecipient({ id: 2, token: 'real-token', signingStatus: SigningStatus.NOT_SIGNED })],
      }),
    );

    const result = await getStartHandoffSigningToken({ documentId: 1, userId: 1, teamId: 1, recipientId: 2 });

    expect(result).toEqual({
      token: 'real-token',
      name: 'Recipient',
      email: 'recipient@example.com',
      envelopeId: 'envelope-1',
    });
  });

  it('returns null for a recipientId that is not currently eligible (e.g. already SIGNED)', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        recipients: [baseRecipient({ id: 2, token: 'real-token', signingStatus: SigningStatus.SIGNED })],
      }),
    );

    const result = await getStartHandoffSigningToken({ documentId: 1, userId: 1, teamId: 1, recipientId: 2 });

    expect(result).toBeNull();
  });

  it('returns null for a recipientId belonging to another envelope entirely', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        recipients: [baseRecipient({ id: 2, token: 'real-token' })],
      }),
    );

    const result = await getStartHandoffSigningToken({ documentId: 1, userId: 1, teamId: 1, recipientId: 999 });

    expect(result).toBeNull();
  });

  it('propagates the owner/team authorization failure from getEnvelopeById (never falls back to trusting the caller)', async () => {
    getEnvelopeByIdMock.mockRejectedValue(new Error('NOT_FOUND'));

    await expect(
      getStartHandoffSigningToken({ documentId: 1, userId: 999, teamId: 1, recipientId: 2 }),
    ).rejects.toThrow('NOT_FOUND');
  });
});

describe('getAdvanceHandoffCandidates / getAdvanceHandoffSigningToken -- completion-gated advance', () => {
  beforeEach(() => {
    getEnvelopeByIdMock.mockReset();
  });

  it('denies advance when the outgoing (completed) recipient has NOT actually signed yet (PARALLEL) -- the DEV-654 review finding', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.PARALLEL },
        recipients: [
          baseRecipient({ id: 1, signingStatus: SigningStatus.NOT_SIGNED }), // "outgoing" -- still mid-signing, not SIGNED
          baseRecipient({ id: 2, token: 'signer-2-token', signingStatus: SigningStatus.NOT_SIGNED }),
        ],
      }),
    );

    const candidates = await getAdvanceHandoffCandidates({
      handoffCapability: capability(),
      completedRecipientToken: 'token-1',
    });

    expect(candidates).toEqual([]);

    const token = await getAdvanceHandoffSigningToken({
      handoffCapability: capability(),
      completedRecipientToken: 'token-1',
      nextRecipientId: 2,
    });

    expect(token).toBeNull();
  });

  it('denies advance when the outgoing recipient is REJECTED, not SIGNED', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        recipients: [
          baseRecipient({ id: 1, signingStatus: SigningStatus.REJECTED }),
          baseRecipient({ id: 2, signingStatus: SigningStatus.NOT_SIGNED }),
        ],
      }),
    );

    const token = await getAdvanceHandoffSigningToken({
      handoffCapability: capability(),
      completedRecipientToken: 'token-1',
      nextRecipientId: 2,
    });

    expect(token).toBeNull();
  });

  it('denies advance when completedRecipientId does not belong to this envelope at all', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        recipients: [baseRecipient({ id: 2, signingStatus: SigningStatus.NOT_SIGNED })],
      }),
    );

    const token = await getAdvanceHandoffSigningToken({
      handoffCapability: capability(),
      completedRecipientToken: 'token-999',
      nextRecipientId: 2,
    });

    expect(token).toBeNull();
  });

  it('allows advance once the outgoing recipient is genuinely SIGNED, to a distinct eligible next recipient', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.SEQUENTIAL },
        recipients: [
          baseRecipient({ id: 1, signingOrder: 1, signingStatus: SigningStatus.SIGNED }),
          baseRecipient({
            id: 2,
            signingOrder: 2,
            token: 'signer-2-token',
            name: 'Next Signer',
            email: 'next@example.com',
            signingStatus: SigningStatus.NOT_SIGNED,
          }),
        ],
      }),
    );

    const candidates = await getAdvanceHandoffCandidates({
      handoffCapability: capability(),
      completedRecipientToken: 'token-1',
    });

    expect(candidates).toEqual([
      { recipientId: 2, name: 'Next Signer', email: 'next@example.com', role: RecipientRole.SIGNER },
    ]);

    const token = await getAdvanceHandoffSigningToken({
      handoffCapability: capability(),
      completedRecipientToken: 'token-1',
      nextRecipientId: 2,
    });

    expect(token).toEqual({ token: 'signer-2-token', name: 'Next Signer', email: 'next@example.com' });
  });

  it('never returns the just-completed recipient itself as a next candidate, even if nextRecipientId==completedRecipientId is requested', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        recipients: [baseRecipient({ id: 1, signingStatus: SigningStatus.SIGNED })],
      }),
    );

    const token = await getAdvanceHandoffSigningToken({
      handoffCapability: capability(),
      completedRecipientToken: 'token-1',
      nextRecipientId: 1,
    });

    expect(token).toBeNull();
  });

  it('denies advance when the envelope has moved to a terminal state since the completed page loaded (stale link)', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        status: DocumentStatus.REJECTED,
        recipients: [
          baseRecipient({ id: 1, signingStatus: SigningStatus.SIGNED }),
          baseRecipient({ id: 2, signingStatus: SigningStatus.NOT_SIGNED }),
        ],
      }),
    );

    const token = await getAdvanceHandoffSigningToken({
      handoffCapability: capability(),
      completedRecipientToken: 'token-1',
      nextRecipientId: 2,
    });

    expect(token).toBeNull();
  });

  it('propagates the owner/team authorization failure (foreign host) from getEnvelopeById', async () => {
    getEnvelopeByIdMock.mockRejectedValue(new Error('NOT_FOUND'));

    await expect(
      getAdvanceHandoffSigningToken({
        handoffCapability: capability({ hostUserId: 999 }),
        completedRecipientToken: 'token-1',
        nextRecipientId: 2,
      }),
    ).rejects.toThrow('NOT_FOUND');

    // Host access is re-verified with the identity the capability was minted for.
    expect(getEnvelopeByIdMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 999, teamId: 1 }));
  });
});

describe('ADVANCE authorization -- host-minted handoff capability (the host session is revoked at START)', () => {
  const signedThenPending = () =>
    baseEnvelope({
      recipients: [
        baseRecipient({ id: 1, signingStatus: SigningStatus.SIGNED }),
        baseRecipient({ id: 2, token: 'signer-2-token', signingStatus: SigningStatus.NOT_SIGNED }),
      ],
    });

  beforeEach(() => {
    getEnvelopeByIdMock.mockReset();
    getEnvelopeByIdMock.mockResolvedValue(signedThenPending());
  });

  it('allows advance with a valid capability and the completed recipient token', async () => {
    const token = await getAdvanceHandoffSigningToken({
      handoffCapability: capability(),
      completedRecipientToken: 'token-1',
      nextRecipientId: 2,
    });

    expect(token?.token).toBe('signer-2-token');
  });

  it('a completed recipient token WITHOUT the capability discloses nothing (any emailed recipient has one)', async () => {
    expect(
      await getAdvanceHandoffSigningToken({
        handoffCapability: '',
        completedRecipientToken: 'token-1',
        nextRecipientId: 2,
      }),
    ).toBeNull();
    expect(getEnvelopeByIdMock).not.toHaveBeenCalled();
  });

  it('rejects a forged capability (payload re-signed with the wrong key or tampered)', async () => {
    const [payload] = capability().split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        envelopeId: 'envelope-1',
        documentId: 1,
        hostUserId: 1,
        teamId: 1,
        expiresAt: Date.now() + 1e9,
      }),
    ).toString('base64url');

    for (const forged of [`${payload}.not-the-signature`, `${tamperedPayload}.${capability().split('.')[1]}`]) {
      expect(
        await getAdvanceHandoffCandidates({ handoffCapability: forged, completedRecipientToken: 'token-1' }),
      ).toEqual([]);
    }

    expect(getEnvelopeByIdMock).not.toHaveBeenCalled();
  });

  it('rejects an expired capability', async () => {
    const expired = capability({}, Date.now() - HANDOFF_CAPABILITY_TTL_MS - 1);

    expect(
      await getAdvanceHandoffSigningToken({
        handoffCapability: expired,
        completedRecipientToken: 'token-1',
        nextRecipientId: 2,
      }),
    ).toBeNull();
  });

  it('rejects a capability minted for a different envelope', async () => {
    expect(
      await getAdvanceHandoffSigningToken({
        handoffCapability: capability({ envelopeId: 'envelope-other' }),
        completedRecipientToken: 'token-1',
        nextRecipientId: 2,
      }),
    ).toBeNull();
  });
});
