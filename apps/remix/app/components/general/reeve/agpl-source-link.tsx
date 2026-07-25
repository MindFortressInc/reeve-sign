import { Trans } from '@lingui/react/macro';

import { cn } from '@documenso/ui/lib/utils';

/**
 * AGPL-3.0 §13 source offer for the Reeve.Sign fork.
 *
 * Reeve.Sign is a modified, network-served AGPL-3.0 work (a fork of Documenso),
 * so §13 obliges us to offer the Corresponding Source to every user who
 * interacts with the running instance remotely — both senders in the
 * authenticated app and recipients on the public signing page. This is the
 * single, fork-owned surface for that offer; it links to the public repository
 * that carries our modifications.
 *
 * Centralised in one component so the label and target stay consistent across
 * placements and the fork's diff against upstream Documenso stays contained for
 * periodic rebases.
 */
export const REEVE_SIGN_SOURCE_URL = 'https://github.com/MindFortressInc/reeve-sign';

export type AgplSourceLinkProps = {
  className?: string;
};

export const AgplSourceLink = ({ className }: AgplSourceLinkProps) => {
  return (
    <a
      href={REEVE_SIGN_SOURCE_URL}
      target="_blank"
      rel="noopener"
      title="Reeve.Sign source code (AGPL-3.0)"
      className={cn(
        'text-muted-foreground text-xs underline-offset-2 transition-colors hover:text-foreground hover:underline',
        className,
      )}
    >
      <Trans>Source</Trans>
    </a>
  );
};
