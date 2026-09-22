import { DocumentSigningOrder, DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const baseRecipient = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  envelopeId: 'envelope-1',
  name: 'Recipient',
  email: 'recipient@example.com',
  role: RecipientRole.SIGNER,
  signingOrder: null,
  signingStatus: SigningStatus.NOT_SIGNED,
  token: 'token-1',
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
          baseRecipient({ id: 1, role: RecipientRole.SIGNER, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({ id: 2, role: RecipientRole.SIGNER, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({ id: 3, role: RecipientRole.APPROVER, signingStatus: SigningStatus.NOT_SIGNED }),
        ],
      }),
    );

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result.map((c) => c.recipientId).sort()).toEqual([1, 2, 3]);
  });

  it('PARALLEL: returns no candidates once any recipient has already signed -- START is only a genuine start; ADVANCE (with completion proof) is required once signing has begun (CR PR #58 finding)', async () => {
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

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result).toEqual([]);
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

  it('SEQUENTIAL: returns only the earliest-ordered eligible recipient, for a genuine (nobody-signed) start', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.SEQUENTIAL },
        recipients: [
          baseRecipient({ id: 1, signingOrder: 1, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({ id: 2, signingOrder: 2, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({ id: 3, signingOrder: 3, signingStatus: SigningStatus.NOT_SIGNED }),
        ],
      }),
    );

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result.map((c) => c.recipientId)).toEqual([1]);
  });

  it('SEQUENTIAL: returns no candidates once the first signer has already completed -- an authenticated host must use ADVANCE (with completion proof), not re-call START mid-sequence (CR PR #58 finding)', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.SEQUENTIAL },
        recipients: [
          baseRecipient({ id: 1, signingOrder: 1, signingStatus: SigningStatus.SIGNED }),
          baseRecipient({ id: 2, signingOrder: 2, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({ id: 3, signingOrder: 3, signingStatus: SigningStatus.NOT_SIGNED }),
        ],
      }),
    );

    const result = await getStartHandoffCandidates({ documentId: 1, userId: 1, teamId: 1 });

    expect(result).toEqual([]);
  });

  it('SEQUENTIAL: surfaces nobody when the next-in-order recipient is not an eligible role (e.g. CC)', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.SEQUENTIAL },
        recipients: [
          baseRecipient({ id: 1, role: RecipientRole.CC, signingOrder: 1, signingStatus: SigningStatus.NOT_SIGNED }),
          baseRecipient({
            id: 2,
            role: RecipientRole.SIGNER,
            signingOrder: 2,
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

    expect(result).toEqual({ token: 'real-token', name: 'Recipient', email: 'recipient@example.com' });
  });

  it('returns null once any recipient on the envelope has already signed, even for an otherwise-eligible recipientId -- START must not bypass ADVANCE mid-sequence (CR PR #58 finding)', async () => {
    getEnvelopeByIdMock.mockResolvedValue(
      baseEnvelope({
        documentMeta: { signingOrder: DocumentSigningOrder.PARALLEL },
        recipients: [
          baseRecipient({ id: 1, signingStatus: SigningStatus.SIGNED }),
          baseRecipient({ id: 2, token: 'real-token', signingStatus: SigningStatus.NOT_SIGNED }),
        ],
      }),
    );

    const result = await getStartHandoffSigningToken({ documentId: 1, userId: 1, teamId: 1, recipientId: 2 });

    expect(result).toBeNull();
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
      documentId: 1,
      userId: 1,
      teamId: 1,
      completedRecipientId: 1,
    });

    expect(candidates).toEqual([]);

    const token = await getAdvanceHandoffSigningToken({
      documentId: 1,
      userId: 1,
      teamId: 1,
      completedRecipientId: 1,
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
      documentId: 1,
      userId: 1,
      teamId: 1,
      completedRecipientId: 1,
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
      documentId: 1,
      userId: 1,
      teamId: 1,
      completedRecipientId: 999,
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
      documentId: 1,
      userId: 1,
      teamId: 1,
      completedRecipientId: 1,
    });

    expect(candidates).toEqual([
      { recipientId: 2, name: 'Next Signer', email: 'next@example.com', role: RecipientRole.SIGNER },
    ]);

    const token = await getAdvanceHandoffSigningToken({
      documentId: 1,
      userId: 1,
      teamId: 1,
      completedRecipientId: 1,
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
      documentId: 1,
      userId: 1,
      teamId: 1,
      completedRecipientId: 1,
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
      documentId: 1,
      userId: 1,
      teamId: 1,
      completedRecipientId: 1,
      nextRecipientId: 2,
    });

    expect(token).toBeNull();
  });

  it('propagates the owner/team authorization failure (foreign host) from getEnvelopeById', async () => {
    getEnvelopeByIdMock.mockRejectedValue(new Error('NOT_FOUND'));

    await expect(
      getAdvanceHandoffSigningToken({
        documentId: 1,
        userId: 999,
        teamId: 1,
        completedRecipientId: 1,
        nextRecipientId: 2,
      }),
    ).rejects.toThrow('NOT_FOUND');
  });
});
