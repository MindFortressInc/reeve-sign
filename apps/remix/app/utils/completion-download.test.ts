import { DocumentStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { getCompletionDownloadState } from './completion-download';

describe('getCompletionDownloadState (DEV-14935)', () => {
  it('offers the signed PDF once the live status is COMPLETED', () => {
    expect(getCompletionDownloadState({ signingStatus: 'COMPLETED', deletedAt: null })).toEqual({
      kind: 'ready',
      envelopeStatus: DocumentStatus.COMPLETED,
    });
  });

  it('keeps the download for a completed envelope even if it was later deleted', () => {
    expect(getCompletionDownloadState({ signingStatus: 'COMPLETED', deletedAt: new Date() }).kind).toBe('ready');
  });

  it('passes REJECTED through so the dialog offers only the original', () => {
    expect(getCompletionDownloadState({ signingStatus: 'REJECTED', deletedAt: null })).toEqual({
      kind: 'ready',
      envelopeStatus: DocumentStatus.REJECTED,
    });
  });

  it('shows a disabled Download while others still have to sign or the seal job runs', () => {
    expect(getCompletionDownloadState({ signingStatus: 'PENDING', deletedAt: null })).toEqual({ kind: 'pending' });
    expect(getCompletionDownloadState({ signingStatus: 'PROCESSING', deletedAt: null })).toEqual({ kind: 'pending' });
  });

  it('hides Download for a cancelled (deleted) envelope that never completed', () => {
    expect(getCompletionDownloadState({ signingStatus: 'PENDING', deletedAt: new Date() })).toEqual({ kind: 'hidden' });
  });
});
