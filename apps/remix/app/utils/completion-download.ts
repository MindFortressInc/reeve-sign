import type { TSigningStatusEnvelopeResponse } from '@documenso/trpc/server/envelope-router/signing-status-envelope.types';
import { DocumentStatus } from '@prisma/client';

export type CompletionDownloadState =
  | { kind: 'ready'; envelopeStatus: DocumentStatus }
  | { kind: 'pending' }
  | { kind: 'hidden' };

/**
 * DEV-14935: what the recipient completion page offers for downloading the PDF.
 *
 * Driven by the live (polled) signing status, not the loader's envelope status.
 * The last signer usually lands on the page before the seal job has flipped the
 * envelope to COMPLETED, so a loader-time gate hid Download for exactly the
 * recipient who just completed the document.
 *
 * `envelopeNotFound` is the poll returning NOT_FOUND: an owner cancelling a
 * non-completed envelope hard-deletes it, so the loader-time `deletedAt` never
 * reflects that cancellation and the last polled status is stale.
 */
export const getCompletionDownloadState = ({
  signingStatus,
  deletedAt,
  envelopeNotFound,
}: {
  signingStatus: TSigningStatusEnvelopeResponse['status'];
  deletedAt: Date | null;
  envelopeNotFound: boolean;
}): CompletionDownloadState => {
  if (envelopeNotFound) {
    return { kind: 'hidden' };
  }

  if (signingStatus === 'COMPLETED') {
    return { kind: 'ready', envelopeStatus: DocumentStatus.COMPLETED };
  }

  // Rejected envelopes keep upstream behaviour: the dialog offers the original only.
  if (signingStatus === 'REJECTED') {
    return { kind: 'ready', envelopeStatus: DocumentStatus.REJECTED };
  }

  if (deletedAt) {
    return { kind: 'hidden' };
  }

  return { kind: 'pending' };
};
