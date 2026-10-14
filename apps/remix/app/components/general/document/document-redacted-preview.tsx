import { authClient } from '@documenso/auth/client';
import { Button } from '@documenso/ui/primitives/button';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { LockIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

export type DocumentRedactedPreviewProps = {
  /** Where "Sign in" lands, e.g. `/signin?returnTo=...`. */
  signInPath: string;
  /** A session that isn't the recipient must sign out first, or /signin bounces straight back here. */
  isSignedIn?: boolean;
};

/**
 * DEV-15772: what a viewer who is not the recipient sees on a signing link.
 *
 * The "document" behind the blur is a placeholder, never the real PDF: a CSS
 * blur over the signed PDF would still ship the signer's name and signature to
 * the browser. Nothing about the recipient or the document reaches this view.
 */
export const DocumentRedactedPreview = ({ signInPath, isSignedIn = false }: DocumentRedactedPreviewProps) => {
  const { _ } = useLingui();
  const { toast } = useToast();

  const [isSigningOut, setIsSigningOut] = useState(false);

  const onSwitchAccount = async () => {
    setIsSigningOut(true);

    try {
      await authClient.signOut({ redirectPath: signInPath });
    } catch {
      toast({
        title: _(msg`Something went wrong`),
        description: _(msg`We were unable to log you out at this time.`),
        variant: 'destructive',
      });

      setIsSigningOut(false);
    }
  };

  return (
    <div className="relative mx-auto w-full max-w-2xl" data-testid="document-redacted-preview">
      <div
        aria-hidden="true"
        className="pointer-events-none select-none rounded-lg border bg-white p-8 shadow-sm blur-sm md:p-12"
      >
        {PLACEHOLDER_LINE_WIDTHS.map((width) => (
          <div key={width} className="mb-4 h-3 rounded bg-neutral-200" style={{ width: `${width}%` }} />
        ))}

        <div className="mt-12 flex justify-between gap-8">
          <div className="h-12 w-2/5 rounded border-neutral-300 border-b-2" />
          <div className="h-12 w-2/5 rounded border-neutral-300 border-b-2" />
        </div>
      </div>

      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div className="flex max-w-sm flex-col items-center rounded-xl border bg-background/95 p-6 text-center shadow-lg">
          <LockIcon className="h-8 w-8 text-muted-foreground" />

          <h2 className="mt-4 font-semibold text-xl">
            <Trans>This document is private</Trans>
          </h2>

          <p className="mt-2 text-muted-foreground text-sm">
            {isSignedIn ? (
              <Trans>You're signed in with an account that isn't a recipient of this document.</Trans>
            ) : (
              <Trans>Only the people this document was sent to can view it.</Trans>
            )}
          </p>

          {isSignedIn ? (
            <Button className="mt-6 w-full" onClick={onSwitchAccount} loading={isSigningOut}>
              <Trans>Sign in to Reeve to view</Trans>
            </Button>
          ) : (
            <Button asChild className="mt-6 w-full">
              <Link to={signInPath}>
                <Trans>Sign in to Reeve to view</Trans>
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

// Unique widths: each doubles as the line's React key.
const PLACEHOLDER_LINE_WIDTHS = [60, 95, 90, 98, 85, 40, 92, 97, 88, 70, 94, 91, 55];
