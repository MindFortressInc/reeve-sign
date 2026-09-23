import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@documenso/ui/primitives/dialog';
import { Label } from '@documenso/ui/primitives/label';
import { RadioGroup, RadioGroupItem } from '@documenso/ui/primitives/radio-group';
import { Spinner } from '@documenso/ui/primitives/spinner';
import { Trans } from '@lingui/react/macro';
import { AlertTriangleIcon, SmartphoneIcon } from 'lucide-react';
import { useState } from 'react';

import { saveHandoffCapability } from '~/utils/handoff-capability-storage';

export type DocumentStartHandoffDialogProps = {
  documentId: number;
  teamId: number;
};

/**
 * DEV-654 native in-person handoff entry point. The host explicitly starts
 * a session here (authenticated owner/team member, same authorization
 * boundary as the existing "Copy Signing Links" dialog on this page) and
 * hands the device to the first eligible signer. START also revokes the
 * host's session on this device, so no signer ever holds the host's account;
 * every subsequent hop is driven from DocumentSigningHandoffPanel on the
 * recipient completion page, authorized by the envelope-bound capability
 * START returns, which re-verifies actual completion before advancing.
 */
export const DocumentStartHandoffDialog = ({ documentId, teamId }: DocumentStartHandoffDialogProps) => {
  const [open, setOpen] = useState(false);
  const [selectedRecipientId, setSelectedRecipientId] = useState<number | null>(null);

  const {
    data: candidates,
    isLoading,
    isError,
  } = trpc.recipient.startHandoffCandidates.useQuery({ documentId, teamId }, { enabled: open });

  const {
    mutateAsync: startHandoffSigningLink,
    isPending,
    error,
  } = trpc.recipient.startHandoffSigningLink.useMutation();

  // Only trust selectedRecipientId while it names a recipient in the CURRENT
  // candidate list -- a stale selection from a previous open (made before a
  // refetch dropped that recipient) must never silently submit.
  const selectionStillValid = candidates?.some((c) => c.recipientId === selectedRecipientId) ?? false;
  const effectiveSelectedId =
    (selectionStillValid ? selectedRecipientId : null) ?? candidates?.[0]?.recipientId ?? null;

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);

    if (!nextOpen) {
      setSelectedRecipientId(null);
    }
  };

  const startInPerson = async () => {
    if (!effectiveSelectedId) {
      return;
    }

    const { signingLink, handoffCapability } = await startHandoffSigningLink({
      documentId,
      teamId,
      recipientId: effectiveSelectedId,
    });

    saveHandoffCapability(documentId, handoffCapability);

    // Hard navigation, same reason as the handoff panel: forces a fresh
    // loader run and a fresh signing provider mount for this recipient.
    // replace() keeps this (now signed-out) page out of the back stack.
    window.location.replace(signingLink);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild onClick={(e) => e.stopPropagation()}>
        <Button type="button" variant="outline">
          <SmartphoneIcon className="mr-2 h-4 w-4" />
          <Trans>Start in-person signing</Trans>
        </Button>
      </DialogTrigger>

      <DialogContent position="center">
        <DialogHeader>
          <DialogTitle className="pb-0.5">
            <Trans>Start in-person signing</Trans>
          </DialogTitle>

          <DialogDescription>
            <Trans>
              Hand this device to the first signer. Each signer completes their own section with their own consent and
              signature before the device is handed to the next signer.
            </Trans>
          </DialogDescription>

          <p className="text-muted-foreground text-sm">
            <Trans>You will be signed out on this device so signers cannot access your account.</Trans>
          </p>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-6">
            <Spinner className="h-5 w-5" />
          </div>
        )}

        {!isLoading && (isError || candidates?.length === 0) && (
          <p className="py-4 text-muted-foreground text-sm">
            <Trans>No recipients are currently able to sign in person (they may have all signed already).</Trans>
          </p>
        )}

        {!isLoading && candidates && candidates.length > 0 && (
          <RadioGroup
            value={effectiveSelectedId ? String(effectiveSelectedId) : undefined}
            onValueChange={(value) => setSelectedRecipientId(Number(value))}
          >
            {candidates.map((candidate) => (
              <div key={candidate.recipientId} className="flex items-center space-x-2 py-1">
                <RadioGroupItem value={String(candidate.recipientId)} id={`start-handoff-${candidate.recipientId}`} />

                <Label htmlFor={`start-handoff-${candidate.recipientId}`} className="font-normal text-sm">
                  {candidate.name || candidate.email}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}

        {error && (
          <div className="flex items-start gap-2 text-destructive text-xs">
            <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />

            <span>
              <Trans>That signer is no longer available. Close this dialog and try again.</Trans>
            </span>
          </div>
        )}

        <DialogFooter>
          <Button type="button" disabled={!effectiveSelectedId || isPending} onClick={startInPerson}>
            <Trans>Start</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
