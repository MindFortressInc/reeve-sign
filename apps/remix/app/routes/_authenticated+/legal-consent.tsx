import { getSession } from '@documenso/auth/server/lib/utils/get-session';
import {
  getCurrentLegalDocuments,
  IS_REEVE_COMPLIANCE_ENABLED,
  REEVE_COMPLIANCE_DOC_TYPES,
  recordConsent,
} from '@documenso/lib/server-only/compliance';
import { extractRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { isValidReturnTo, normalizeReturnTo } from '@documenso/lib/utils/is-valid-return-to';
import { logger } from '@documenso/lib/utils/logger';
import { Button } from '@documenso/ui/primitives/button';
import { Card, CardContent } from '@documenso/ui/primitives/card';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';
import { data, Form, redirect, useActionData, useNavigation } from 'react-router';

import { appMetaTags } from '~/utils/meta';

import type { Route } from './+types/legal-consent';

const resolveReturnTo = (raw: string | null): string => {
  return raw && isValidReturnTo(raw) ? (normalizeReturnTo(raw) ?? '/') : '/';
};

const FALLBACK_LEGAL_LINK = '/articles/signature-disclosure';

/**
 * Defense-in-depth (deep-review finding, DEV-2837): `contentUrl` is
 * server-authored on reeve-services, not attacker-reachable through this
 * app — but this page renders it as a raw `<a href>`, so a non-http(s)
 * scheme (e.g. `javascript:`) is rejected rather than trusted blindly.
 */
const safeLegalLink = (contentUrl: string | null): string => {
  if (!contentUrl) {
    return FALLBACK_LEGAL_LINK;
  }

  try {
    const parsed = new URL(contentUrl);

    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? contentUrl : FALLBACK_LEGAL_LINK;
  } catch {
    return FALLBACK_LEGAL_LINK;
  }
};

export function meta() {
  return appMetaTags(msg`Terms & Privacy`);
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await getSession(request);

  const url = new URL(request.url);
  const returnTo = resolveReturnTo(url.searchParams.get('returnTo'));

  if (!IS_REEVE_COMPLIANCE_ENABLED()) {
    // Not normally reachable — the gate in `_layout.tsx` no-ops (and never
    // redirects here) when the compliance API isn't configured. Covers a
    // bookmarked/deep-linked URL on a self-hosted instance with the gate off.
    throw redirect(returnTo);
  }

  const documents = await getCurrentLegalDocuments({ docTypes: REEVE_COMPLIANCE_DOC_TYPES });

  if (!documents || documents.length === 0) {
    // Fail-open: the compliance API is unreachable right now. Let the user
    // through rather than dead-end them on a broken page — the gate will
    // re-check (and re-prompt if still needed) on their next request.
    logger.warn({ event: 'reeve_compliance_legal_documents_fetch_failed', subjectId: user.email });

    throw redirect(returnTo);
  }

  return { documents, returnTo };
}

export async function action({ request }: Route.ActionArgs) {
  const { user } = await getSession(request);

  const formData = await request.formData();
  const accepted = formData.get('accepted') === 'true';
  const returnTo = resolveReturnTo(formData.get('returnTo')?.toString() ?? null);

  if (!accepted) {
    return data({ error: true }, { status: 400 });
  }

  const documents = await getCurrentLegalDocuments({ docTypes: REEVE_COMPLIANCE_DOC_TYPES });

  if (documents) {
    const metadata = extractRequestMetadata(request);

    const results = await Promise.all(
      documents.map((doc) =>
        recordConsent({
          subjectId: user.email,
          docType: doc.docType,
          version: doc.version,
          ip: metadata.ipAddress,
          userAgent: metadata.userAgent,
        }),
      ),
    );

    if (results.some((ok) => !ok)) {
      logger.error({ event: 'reeve_compliance_consent_record_failed', subjectId: user.email });
    }
  } else {
    logger.error({ event: 'reeve_compliance_legal_documents_fetch_failed_on_accept', subjectId: user.email });
  }

  // Deliberately not caching the session cookie here. The destination
  // page's own layout loader will re-check consent status once (confirming
  // the record above actually landed) and cache from there — so if the
  // write above silently failed, the user is correctly re-prompted rather
  // than optimistically waved through on an unconfirmed write.
  throw redirect(returnTo);
}

export default function LegalConsentPage({ loaderData }: Route.ComponentProps) {
  const { documents, returnTo } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();

  const [accepted, setAccepted] = useState(false);

  const isSubmitting = navigation.state === 'submitting';

  const tos = documents.find((doc) => doc.docType === 'tos');
  const privacy = documents.find((doc) => doc.docType === 'privacy');

  return (
    <div className="mx-auto flex w-full max-w-screen-sm flex-col items-center px-4 py-24">
      <Card className="w-full">
        <CardContent className="p-8">
          <h1 className="font-bold text-2xl">
            <Trans>Before you continue</Trans>
          </h1>

          <p className="mt-2 text-muted-foreground text-sm">
            <Trans>
              Please review and accept our Terms of Service and Privacy Policy to continue using Reeve.Sign.
            </Trans>
          </p>

          <Form method="post" className="mt-8 flex flex-col gap-4">
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="hidden" name="accepted" value={accepted ? 'true' : 'false'} />

            <label className="flex items-start gap-3 text-sm">
              <Checkbox
                checked={accepted}
                onCheckedChange={(value) => setAccepted(value === true)}
                className="mt-0.5"
              />

              <span>
                <Trans>I have read and agree to the</Trans>{' '}
                <a
                  href={safeLegalLink(tos?.contentUrl ?? null)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-700 underline"
                >
                  <Trans>Terms of Service</Trans>
                </a>{' '}
                <Trans>and</Trans>{' '}
                <a
                  href={safeLegalLink(privacy?.contentUrl ?? null)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-700 underline"
                >
                  <Trans>Privacy Policy</Trans>
                </a>
                .
              </span>
            </label>

            {actionData?.error && (
              <p className="text-destructive text-sm">
                <Trans>You must accept the Terms of Service and Privacy Policy to continue.</Trans>
              </p>
            )}

            <Button type="submit" disabled={!accepted} loading={isSubmitting} className="mt-2">
              <Trans>Accept and continue</Trans>
            </Button>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
