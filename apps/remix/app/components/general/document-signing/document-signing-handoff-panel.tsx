import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Label } from '@documenso/ui/primitives/label';
import { RadioGroup, RadioGroupItem } from '@documenso/ui/primitives/radio-group';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangleIcon, ArrowRightIcon, Loader2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { clearHandoffCapability, readHandoffCapability } from '~/utils/handoff-capability-storage';

export type DocumentSigningHandoffPanelProps = {
  documentId: number;
  /** Token of the recipient who must have actually just completed -- re-verified server-side on every call. */
  completedRecipientToken: string;
};

/**
 * DEV-654: renders only on the handoff device -- the tab where the host ran
 * START and received the envelope-bound handoff capability (the host's own
 * session there was revoked at the same time). Candidates and the next
 * signing link both come from capability-authorized procedures that
 * re-verify the host's envelope access and this recipient's SIGNED status
 * fresh, independent of anything this component sends.
 */
export const DocumentSigningHandoffPanel = ({
  documentId,
  completedRecipientToken,
}: DocumentSigningHandoffPanelProps) => {
  const { t } = useLingui();

  // sessionStorage only exists in the browser; read after mount so SSR and
  // hydration agree (both render nothing).
  const [handoffCapability, setHandoffCapability] = useState<string | null>(null);
  const [selectedRecipientId, setSelectedRecipientId] = useState<number | null>(null);

  useEffect(() => {
    setHandoffCapability(readHandoffCapability(documentId));
  }, [documentId]);

  const { data: candidates } = trpc.recipient.advanceHandoffCandidates.useQuery(
    { handoffCapability: handoffCapability ?? '', completedRecipientToken },
    { enabled: !!handoffCapability },
  );

  // Nobody left to hand to: the in-person session is over on this device.
  useEffect(() => {
    if (candidates?.length === 0) {
      clearHandoffCapability(documentId);
    }
  }, [candidates, documentId]);

  const {
    mutateAsync: advanceHandoffSigningLink,
    isPending,
    error,
  } = trpc.recipient.advanceHandoffSigningLink.useMutation();

  if (!handoffCapability || !candidates || candidates.length === 0) {
    return null;
  }

  const selectionStillValid = candidates.some((c) => c.recipientId === selectedRecipientId);
  const effectiveSelectedId = (selectionStillValid ? selectedRecipientId : null) ?? candidates[0].recipientId;

  const handOffDevice = async () => {
    const { signingLink } = await advanceHandoffSigningLink({
      handoffCapability,
      completedRecipientToken,
      nextRecipientId: effectiveSelectedId,
    });

    // Hard navigation is required, not a SPA transition: it is what forces a
    // fresh loader run and a fresh DocumentSigningProvider/SignaturePad
    // mount for the next recipient's token, so no name/signature/auth state
    // from this signer carries over to the next one. replace() keeps the
    // previous signer's pages out of the back stack.
    window.location.replace(signingLink);
  };

  return (
    <div className="mt-10 w-full max-w-sm rounded-xl border border-border bg-widget p-6 dark:bg-background">
      <h3 className="font-medium text-foreground text-sm">
        <Trans>Signing in person?</Trans>
      </h3>

      <p className="mt-1 text-muted-foreground text-xs">
        <Trans>Hand this device to the next signer to continue.</Trans>
      </p>

      {candidates.length === 1 ? (
        <p className="mt-4 font-medium text-foreground text-sm">{candidates[0].name || candidates[0].email}</p>
      ) : (
        <RadioGroup
          className="mt-4"
          value={String(effectiveSelectedId)}
          onValueChange={(value) => setSelectedRecipientId(Number(value))}
        >
          {candidates.map((candidate) => (
            <div key={candidate.recipientId} className="flex items-center space-x-2 py-1">
              <RadioGroupItem value={String(candidate.recipientId)} id={`handoff-candidate-${candidate.recipientId}`} />

              <Label htmlFor={`handoff-candidate-${candidate.recipientId}`} className="font-normal text-sm">
                {candidate.name || candidate.email}
              </Label>
            </div>
          ))}
        </RadioGroup>
      )}

      {error && (
        <div className="mt-3 flex items-start gap-2 text-destructive text-xs">
          <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />

          <span>
            <Trans>
              This signer is no longer available to sign (they may have already completed, or the document changed).
              Refresh this page to see the current status.
            </Trans>
          </span>
        </div>
      )}

      <Button
        type="button"
        className="mt-4 w-full"
        disabled={isPending}
        onClick={handOffDevice}
        aria-label={t`Hand off device to next signer`}
      >
        {isPending ? (
          <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <ArrowRightIcon className="mr-2 h-4 w-4" />
        )}

        <Trans>Hand off device</Trans>
      </Button>
    </div>
  );
};
