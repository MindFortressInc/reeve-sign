import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Label } from '@documenso/ui/primitives/label';
import { RadioGroup, RadioGroupItem } from '@documenso/ui/primitives/radio-group';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle, ArrowRightIcon, Loader2 } from 'lucide-react';
import { useState } from 'react';

export type DocumentSigningHandoffCandidate = {
  recipientId: number;
  name: string;
  email: string;
};

export type DocumentSigningHandoffPanelProps = {
  documentId: number;
  teamId: number;
  /** The recipient who must have actually just completed -- re-verified server-side on every call. */
  completedRecipientId: number;
  candidates: DocumentSigningHandoffCandidate[];
};

/**
 * DEV-654: shown only when the loader has verified BOTH (a) an authenticated
 * owner/team member is viewing this page and (b) completedRecipientId has
 * actually reached SIGNED status. Fetching the actual next signing link
 * happens on explicit click via the ADVANCE mutation, which re-verifies both
 * of those server-side, fresh, independent of anything this component sends.
 */
export const DocumentSigningHandoffPanel = ({
  documentId,
  teamId,
  completedRecipientId,
  candidates,
}: DocumentSigningHandoffPanelProps) => {
  const { _ } = useLingui();

  const [selectedRecipientId, setSelectedRecipientId] = useState<number | null>(candidates[0]?.recipientId ?? null);

  const {
    mutateAsync: advanceHandoffSigningLink,
    isPending,
    error,
  } = trpc.recipient.advanceHandoffSigningLink.useMutation();

  if (candidates.length === 0) {
    return null;
  }

  const handOffDevice = async () => {
    if (!selectedRecipientId) {
      return;
    }

    const { signingLink } = await advanceHandoffSigningLink({
      documentId,
      teamId,
      completedRecipientId,
      nextRecipientId: selectedRecipientId,
    });

    // Hard navigation is required, not a SPA transition: it is what forces a
    // fresh loader run and a fresh DocumentSigningProvider/SignaturePad
    // mount for the next recipient's token, so no name/signature/auth state
    // from this signer carries over to the next one.
    window.location.href = signingLink;
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
          value={selectedRecipientId ? String(selectedRecipientId) : undefined}
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
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />

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
        disabled={!selectedRecipientId || isPending}
        onClick={handOffDevice}
        aria-label={_(msg`Hand off device to next signer`)}
      >
        {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRightIcon className="mr-2 h-4 w-4" />}

        <Trans>Hand off device</Trans>
      </Button>
    </div>
  );
};
