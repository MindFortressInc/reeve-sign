import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { OrganisationProvider } from '@documenso/lib/client-only/providers/organisation';
import { useSession } from '@documenso/lib/client-only/providers/session';
import { getSiteSettings } from '@documenso/lib/server-only/site-settings/get-site-settings';
import { SITE_SETTINGS_BANNER_ID } from '@documenso/lib/server-only/site-settings/schemas/banner';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { data, Link, Outlet, redirect, type ShouldRevalidateFunctionArgs } from 'react-router';

import { AppBanner } from '~/components/general/app-banner';
import { Header } from '~/components/general/app-header';
import { GenericErrorLayout } from '~/components/general/generic-error-layout';
import { OrganisationBillingBanner } from '~/components/general/organisations/organisation-billing-banner';
import { AgplSourceLink } from '~/components/general/reeve/agpl-source-link';
import { VerifyEmailBanner } from '~/components/general/verify-email-banner';
import { TeamProvider } from '~/providers/team';
import { CONSENT_GATE_ROUTE_PATH } from '~/utils/consent-gate-route';
import { checkConsentGate } from '~/utils/consent-gate.server';

import type { Route } from './+types/_layout';

/**
 * Don't revalidate (run the loader on sequential navigations) — values are
 * updated via providers, so re-running the loader on every client navigation
 * is wasted work.
 *
 * Exception (DEV-2837): the ToS/Privacy consent gate lives in this loader. A
 * `false` here means the loader (and the gate) is skipped on client-side
 * navigations, which let a not-yet-accepted user escape `/legal-consent` by
 * clicking any in-app link (an SPA nav that skips this parent loader). Force a
 * revalidation whenever we navigate *away* from the consent page so the gate
 * re-runs and bounces an un-accepted user right back. Accepted users are never
 * on the consent page, so their fast (no-revalidate, no-API-call) path is
 * unaffected.
 */
export const shouldRevalidate = ({ currentUrl, nextUrl }: ShouldRevalidateFunctionArgs) => {
  return currentUrl.pathname === CONSENT_GATE_ROUTE_PATH && nextUrl.pathname !== CONSENT_GATE_ROUTE_PATH;
};

export async function loader({ request }: Route.LoaderArgs) {
  const [session, banner] = await Promise.all([
    getOptionalSession(request),
    getSiteSettings().then((settings) => settings.find((setting) => setting.id === SITE_SETTINGS_BANNER_ID)),
  ]);

  if (!session.isAuthenticated) {
    throw redirect('/signin');
  }

  // DEV-2837: ToS/Privacy consent gate via Reeve.Compliance. No-ops entirely
  // when unconfigured, and fails open (logs + lets the user through) on any
  // API error — see `checkConsentGate` for the full policy.
  const consentGate = await checkConsentGate({ request, user: session.user });

  if (consentGate.type === 'redirect') {
    throw redirect(consentGate.to);
  }

  return data(
    { banner },
    consentGate.type === 'cache' ? { headers: { 'Set-Cookie': consentGate.setCookieHeader } } : undefined,
  );
}

export default function Layout({ loaderData, params, matches }: Route.ComponentProps) {
  const { banner } = loaderData;

  const { user, organisations } = useSession();

  const teamUrl = params.teamUrl;
  const orgUrl = params.orgUrl;

  const teams = organisations.flatMap((org) => org.teams);

  const extractCurrentOrganisation = () => {
    if (orgUrl) {
      return organisations.find((org) => org.url === orgUrl);
    }

    // Search organisations to find the team since we don't have access to the orgUrl in the URL.
    if (teamUrl) {
      return organisations.find((org) => org.teams.some((team) => team.url === teamUrl));
    }

    return null;
  };

  const currentTeam = teams.find((team) => team.url === teamUrl);
  const currentOrganisation = extractCurrentOrganisation() || null;

  const orgNotFound = params.orgUrl && !currentOrganisation;
  const teamNotFound = params.teamUrl && !currentTeam;

  // Hide the header for editor routes.
  const hideHeader = matches.some(
    (match) =>
      match?.id === 'routes/_authenticated+/t.$teamUrl+/documents.$id.edit' ||
      match?.id === 'routes/_authenticated+/t.$teamUrl+/templates.$id.edit',
  );

  if (orgNotFound || teamNotFound) {
    return (
      <GenericErrorLayout
        errorCode={404}
        errorCodeMap={{
          404: orgNotFound
            ? {
                heading: msg`Organisation not found`,
                subHeading: msg`404 Organisation not found`,
                message: msg`The organisation you are looking for may have been removed, renamed or may have never existed.`,
              }
            : {
                heading: msg`Team not found`,
                subHeading: msg`404 Team not found`,
                message: msg`The team you are looking for may have been removed, renamed or may have never existed.`,
              },
        }}
        primaryButton={
          <Button asChild>
            <Link to="/">
              <Trans>Go home</Trans>
            </Link>
          </Button>
        }
      />
    );
  }

  return (
    <OrganisationProvider organisation={currentOrganisation}>
      <TeamProvider team={currentTeam || null}>
        <OrganisationBillingBanner />

        {!user.emailVerified && <VerifyEmailBanner email={user.email} />}

        {banner && !hideHeader && <AppBanner banner={banner} />}

        {!hideHeader && <Header />}

        <main
          className={cn({
            'mt-8 pb-8 md:mt-12 md:pb-12': !hideHeader,
          })}
        >
          <Outlet />
        </main>

        {/* AGPL-3.0 §13 source offer for senders in the authenticated app.
            Hidden on the full-screen editor routes (same gate as the header). */}
        {!hideHeader && (
          <footer className="border-border/40 border-t py-4">
            <div className="mx-auto flex max-w-screen-xl items-center justify-center px-4">
              <AgplSourceLink />
            </div>
          </footer>
        )}
      </TeamProvider>
    </OrganisationProvider>
  );
}
