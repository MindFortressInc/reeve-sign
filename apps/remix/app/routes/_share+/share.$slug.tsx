import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { getDocumentByAccessToken } from '@documenso/lib/server-only/document/get-document-by-access-token';
import { canViewCompletedLink } from '@documenso/lib/server-only/recipient/completed-link-access';
import { prisma } from '@documenso/prisma';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus } from '@prisma/client';
import { CheckCircle2 } from 'lucide-react';
import { redirect, useLoaderData } from 'react-router';
import { CompletedLinkExpired } from '~/components/general/document/completed-link-expired';
import { DocumentCertificateQRView } from '~/components/general/document/document-certificate-qr-view';

import type { Route } from './+types/share.$slug';

export function meta({ params: { slug } }: Route.MetaArgs) {
  if (slug.startsWith('qr_')) {
    return undefined;
  }

  return [
    { title: 'Reeve.Sign - Share' },
    { description: 'I just signed a document in style with Reeve.Sign!' },
    {
      property: 'og:title',
      content: 'Reeve.Sign - Fast, secure document signing',
    },
    {
      property: 'og:description',
      content: 'I just signed with Reeve.Sign!',
    },
    {
      property: 'og:type',
      content: 'website',
    },
    {
      property: 'og:image',
      content: `${NEXT_PUBLIC_WEBAPP_URL()}/share/${slug}/opengraph`,
    },
    {
      name: 'twitter:site',
      content: '@meetreeve',
    },
    {
      name: 'twitter:card',
      content: 'summary_large_image',
    },
    {
      name: 'twitter:image',
      content: `${NEXT_PUBLIC_WEBAPP_URL()}/share/${slug}/opengraph`,
    },
    {
      name: 'twitter:description',
      content: 'I just signed with Reeve.Sign!',
    },
  ];
}

export const loader = async ({ request, params: { slug } }: Route.LoaderArgs) => {
  if (slug.startsWith('qr_')) {
    const document = await getDocumentByAccessToken({ token: slug });

    if (!document) {
      throw redirect('/');
    }

    return {
      kind: 'qr',
      document,
      token: slug,
    } as const;
  }

  const userAgent = request.headers.get('User-Agent') ?? '';

  if (/bot|facebookexternalhit|WhatsApp|google|bing|duckduckbot|MetaInspector/i.test(userAgent)) {
    return { kind: 'bot' } as const;
  }

  // DEV-15772: humans used to be bounced to the marketing site, which read as the
  // link "just redirecting to the website". They now get a generic card with no
  // recipient data, under the same 7-day rule as /sign/<token>/complete.
  const shareLink = await prisma.documentShareLink.findUnique({
    where: { slug },
    select: { email: true, envelope: { select: { status: true, completedAt: true, userId: true } } },
  });

  if (!shareLink) {
    throw new Response('Not Found', { status: 404 });
  }

  const { user } = await getOptionalSession(request);

  const canView = canViewCompletedLink({
    status: shareLink.envelope.status,
    completedAt: shareLink.envelope.completedAt,
    sessionUser: user,
    recipientEmail: shareLink.email,
    ownerId: shareLink.envelope.userId,
  });

  if (!canView) {
    return {
      kind: 'expired',
      isSignedIn: !!user,
      signInPath: `/signin?returnTo=${encodeURIComponent(`/share/${slug}`)}`,
    } as const;
  }

  return { kind: 'card', isCompleted: shareLink.envelope.status === DocumentStatus.COMPLETED } as const;
};

export default function SharePage() {
  const loaderData = useLoaderData<typeof loader>();

  if (loaderData.kind === 'expired') {
    return <CompletedLinkExpired signInPath={loaderData.signInPath} isSignedIn={loaderData.isSignedIn} />;
  }

  if (loaderData.kind === 'card') {
    return (
      <div className="flex flex-col items-center pt-24 text-center lg:pt-36 xl:pt-44" data-testid="share-card">
        <CheckCircle2 className="h-10 w-10 text-brand-700" />

        <h2 className="mt-4 font-semibold text-2xl md:text-3xl">
          {loaderData.isCompleted ? <Trans>Document Signed</Trans> : <Trans>Document Sent</Trans>}
        </h2>

        <p className="mt-2 max-w-[60ch] text-muted-foreground text-sm">
          <Trans>Shared from Reeve.Sign.</Trans>
        </p>
      </div>
    );
  }

  if (loaderData.kind === 'qr') {
    const { document, token } = loaderData;

    return (
      <DocumentCertificateQRView
        documentId={document.id}
        title={document.title}
        documentTeamUrl={document.documentTeamUrl}
        internalVersion={document.internalVersion}
        envelopeItems={document.envelopeItems}
        recipientCount={document.recipientCount}
        completedDate={document.completedAt ?? undefined}
        token={token}
      />
    );
  }

  return <div></div>;
}
