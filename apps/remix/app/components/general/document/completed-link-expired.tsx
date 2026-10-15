import { authClient } from '@documenso/auth/client';
import { Button } from '@documenso/ui/primitives/button';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { TimerOffIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

export type CompletedLinkExpiredProps = {
  /** Where "Sign in" lands, e.g. `/signin?returnTo=...`. */
  signInPath: string;
  /** A session that isn't the owner or recipient must sign out first, or /signin bounces straight back here. */
  isSignedIn?: boolean;
};

/**
 * DEV-15772: a completed signing or share link, opened more than
 * COMPLETED_LINK_TTL_DAYS after completion by someone who isn't signed in as
 * the document owner or the recipient. Carries nothing about the recipient or
 * the document.
 */
export const CompletedLinkExpired = ({ signInPath, isSignedIn = false }: CompletedLinkExpiredProps) => {
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
    <div className="flex flex-col items-center pt-24 lg:pt-36 xl:pt-44" data-testid="completed-link-expired">
      <div className="flex items-center gap-x-4">
        <TimerOffIcon className="h-10 w-10 text-orange-500" />

        <h2 className="max-w-[35ch] text-center font-semibold text-2xl leading-normal md:text-3xl lg:text-4xl">
          <Trans>This link has expired</Trans>
        </h2>
      </div>

      <p className="mt-6 max-w-[60ch] text-center text-muted-foreground text-sm">
        {isSignedIn ? (
          <Trans>You're signed in with an account that can't view this document.</Trans>
        ) : (
          <Trans>Sign in to Reeve to view this document.</Trans>
        )}
      </p>

      {isSignedIn ? (
        <Button className="mt-6" onClick={onSwitchAccount} loading={isSigningOut}>
          <Trans>Sign in to Reeve to view</Trans>
        </Button>
      ) : (
        <Button asChild className="mt-6">
          <Link to={signInPath}>
            <Trans>Sign in to Reeve to view</Trans>
          </Link>
        </Button>
      )}
    </div>
  );
};
