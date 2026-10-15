import signingCelebration from '@documenso/assets/images/signing-celebration.png';
import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { loadRecipientBrandingByTeamId } from '@documenso/lib/server-only/branding/load-recipient-branding';
import { getDocumentAndSenderByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { isRecipientAuthorized } from '@documenso/lib/server-only/document/is-recipient-authorized';
import { getFieldsForToken } from '@documenso/lib/server-only/field/get-fields-for-token';
import { canViewCompletedLink } from '@documenso/lib/server-only/recipient/completed-link-access';
import { getRecipientByToken } from '@documenso/lib/server-only/recipient/get-recipient-by-token';
import { getRecipientSignatures } from '@documenso/lib/server-only/recipient/get-recipient-signatures';
import { trpc } from '@documenso/trpc/react';
import { DocumentShareButton } from '@documenso/ui/components/document/document-share-button';
import { SigningCard3D } from '@documenso/ui/components/signing-card';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus, FieldType, RecipientRole, SigningStatus } from '@prisma/client';
import { CheckCircle2, Clock8, DownloadIcon, Loader2 } from 'lucide-react';
import { Link, redirect } from 'react-router';
import { match } from 'ts-pattern';

import { EnvelopeDownloadDialog } from '~/components/dialogs/envelope-download-dialog';
import { CompletedLinkExpired } from '~/components/general/document/completed-link-expired';
import { DocumentSigningAuthPageView } from '~/components/general/document-signing/document-signing-auth-page';
import { DocumentSigningHandoffPanel } from '~/components/general/document-signing/document-signing-handoff-panel';
import { RecipientBranding } from '~/components/general/recipient-branding';
import { getCompletionDownloadState } from '~/utils/completion-download';
import { useCspNonce } from '~/utils/nonce';

import type { Route } from './+types/complete';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  const { token } = params;

  if (!token) {
    throw new Response('Not Found', { status: 404 });
  }

  const document = await getDocumentAndSenderByToken({
    token,
    requireAccessAuth: false,
  }).catch(() => null);

  if (!document || !document.documentData) {
    throw new Response('Not Found', { status: 404 });
  }

  const branding = await loadRecipientBrandingByTeamId({ teamId: document.teamId });

  const [fields, recipient] = await Promise.all([
    getFieldsForToken({ token }),
    getRecipientByToken({ token }).catch(() => null),
  ]);

  if (!recipient) {
    throw new Response('Not Found', { status: 404 });
  }

  // DEV-15772: a finished signing link lands here with ?redirect=1. The param is
  // consumed by this loader: either the sender's redirectUrl is applied (below,
  // once access auth passes and the recipient is done) or the viewer is sent to
  // the clean completion URL, so it never sticks to a page that can be shared.
  const completePath = `/sign/${token}/complete`;
  const isRedirectRequest = new URL(request.url).searchParams.has('redirect');

  // DEV-15772: anyone holding the link sees the completed page for the first
  // COMPLETED_LINK_TTL_DAYS after the envelope completes; after that only the
  // owner's or the recipient's session does. The expired state carries nothing
  // about the recipient or the document.
  if (
    !canViewCompletedLink({
      status: document.status,
      completedAt: document.completedAt,
      sessionUser: user,
      recipientEmail: recipient.email,
      ownerId: document.userId,
    })
  ) {
    if (isRedirectRequest) {
      throw redirect(completePath);
    }

    return {
      isExpired: true,
      isSignedIn: !!user,
      signInPath: `/signin?returnTo=${encodeURIComponent(completePath)}`,
      branding,
    } as const;
  }

  const isDocumentAccessValid = await isRecipientAuthorized({
    type: 'ACCESS',
    documentAuthOptions: document.authOptions,
    recipient,
    userId: user?.id,
  });

  if (!isDocumentAccessValid) {
    if (isRedirectRequest) {
      throw redirect(completePath);
    }

    // DEV-15772: no recipient email here; the link may have been forwarded.
    return {
      isDocumentAccessValid: false,
      branding,
    } as const;
  }

  // The sender's redirectUrl is only revealed once access auth has passed and the
  // recipient has actually finished. Direct visits (e.g. the completed email's
  // download link) still render this page.
  if (isRedirectRequest) {
    const redirectUrl = document.documentMeta?.redirectUrl;
    const isFinished = document.status === DocumentStatus.COMPLETED || recipient.signingStatus === SigningStatus.SIGNED;

    throw redirect(redirectUrl && isFinished ? redirectUrl : completePath);
  }

  const signatures = await getRecipientSignatures({ recipientId: recipient.id });

  const recipientName =
    recipient.name || fields.find((field) => field.type === FieldType.NAME)?.customText || recipient.email;

  const canRedirectToFolder = user && document.userId === user.id && document.folderId && document.team?.url;

  const returnToHomePath = canRedirectToFolder ? `/t/${document.team.url}/documents/f/${document.folderId}` : '/';

  return {
    isDocumentAccessValid: true,
    recipientName,
    signatures,
    document,
    recipient,
    returnToHomePath,
    branding,
  };
}

export default function CompletedSigningPage({ loaderData }: Route.ComponentProps) {
  const cspNonce = useCspNonce();

  if (loaderData.isExpired) {
    return (
      <>
        <RecipientBranding branding={loaderData.branding} cspNonce={cspNonce} />
        <CompletedLinkExpired signInPath={loaderData.signInPath} isSignedIn={loaderData.isSignedIn} />
      </>
    );
  }

  return <CompletedSigningPageView loaderData={loaderData} />;
}

type CompletedSigningPageViewProps = {
  loaderData: Exclude<Route.ComponentProps['loaderData'], { isExpired: true }>;
};

const CompletedSigningPageView = ({ loaderData }: CompletedSigningPageViewProps) => {
  const { _ } = useLingui();

  const { sessionData } = useOptionalSession();
  const user = sessionData?.user;
  const cspNonce = useCspNonce();

  const { isDocumentAccessValid, recipientName, signatures, document, recipient, returnToHomePath, branding } =
    loaderData;

  // Poll signing status every few seconds
  const { data: signingStatusData, error: signingStatusError } = trpc.envelope.signingStatus.useQuery(
    {
      token: recipient?.token || '',
    },
    {
      refetchInterval: 3000,
      initialData: match(document?.status)
        .with(DocumentStatus.COMPLETED, () => ({ status: 'COMPLETED' }) as const)
        .with(DocumentStatus.REJECTED, () => ({ status: 'REJECTED' }) as const)
        .with(DocumentStatus.PENDING, () => ({ status: 'PENDING' }) as const)
        .otherwise(() => ({ status: 'PENDING' }) as const),
    },
  );

  // Use signing status from query if available, otherwise fall back to document status
  const signingStatus = signingStatusData?.status ?? 'PENDING';

  const downloadState = getCompletionDownloadState({
    signingStatus,
    deletedAt: document?.deletedAt ?? null,
    envelopeNotFound: !!signingStatusError && AppError.parseError(signingStatusError).code === AppErrorCode.NOT_FOUND,
  });

  if (!isDocumentAccessValid) {
    return (
      <>
        <RecipientBranding branding={branding} cspNonce={cspNonce} />
        <DocumentSigningAuthPageView emailHasAccount />
      </>
    );
  }

  return (
    <>
      <RecipientBranding branding={branding} cspNonce={cspNonce} />
      <div className="-mx-4 flex flex-col items-center overflow-hidden px-4 pt-16 md:-mx-8 md:px-8 lg:pt-20 xl:pt-28">
        <div className="relative mt-6 flex w-full flex-col items-center justify-center">
          <div className="flex flex-col items-center">
            <Badge variant="neutral" size="default" className="mb-6 rounded-xl border bg-transparent">
              <span className="block max-w-[10rem] truncate font-medium hover:underline md:max-w-[20rem]">
                {document.title}
              </span>
            </Badge>

            {/* Card with recipient */}
            <SigningCard3D
              name={recipientName}
              signature={signatures.at(0)}
              signingCelebrationImage={signingCelebration}
            />

            <h2 className="mt-6 max-w-[35ch] text-center font-semibold text-2xl leading-normal md:text-3xl lg:text-4xl">
              {recipient.role === RecipientRole.SIGNER && <Trans>Document Signed</Trans>}
              {recipient.role === RecipientRole.VIEWER && <Trans>Document Viewed</Trans>}
              {recipient.role === RecipientRole.APPROVER && <Trans>Document Approved</Trans>}
            </h2>

            {match({ status: signingStatus, deletedAt: document.deletedAt })
              .with({ status: 'COMPLETED' }, () => (
                <div className="mt-4 flex items-center text-center text-brand-700">
                  <CheckCircle2 className="mr-2 h-5 w-5" />
                  <span className="text-sm">
                    <Trans>Everyone has signed</Trans>
                  </span>
                </div>
              ))
              .with({ status: 'PROCESSING' }, () => (
                <div className="mt-4 flex items-center text-center text-orange-600">
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  <span className="text-sm">
                    <Trans>Processing document</Trans>
                  </span>
                </div>
              ))
              .with({ deletedAt: null }, () => (
                <div className="mt-4 flex items-center text-center text-blue-600">
                  <Clock8 className="mr-2 h-5 w-5" />
                  <span className="text-sm">
                    <Trans>Waiting for others to sign</Trans>
                  </span>
                </div>
              ))
              .otherwise(() => (
                <div className="flex items-center text-center text-red-600">
                  <Clock8 className="mr-2 h-5 w-5" />
                  <span className="text-sm">
                    <Trans>Document no longer available to sign</Trans>
                  </span>
                </div>
              ))}

            {match({ status: signingStatus, deletedAt: document.deletedAt })
              .with({ status: 'COMPLETED' }, () => (
                <p className="mt-2.5 max-w-[60ch] text-center font-medium text-muted-foreground/60 text-sm md:text-base">
                  <Trans>Everyone has signed! You will receive an email copy of the signed document.</Trans>
                </p>
              ))
              .with({ status: 'PROCESSING' }, () => (
                <p className="mt-2.5 max-w-[60ch] text-center font-medium text-muted-foreground/60 text-sm md:text-base">
                  <Trans>
                    All recipients have signed. The document is being processed and you will receive an email copy
                    shortly.
                  </Trans>
                </p>
              ))
              .with({ deletedAt: null }, () => (
                <p className="mt-2.5 max-w-[60ch] text-center font-medium text-muted-foreground/60 text-sm md:text-base">
                  <Trans>You will receive an email copy of the signed document once everyone has signed.</Trans>
                </p>
              ))
              .otherwise(() => (
                <p className="mt-2.5 max-w-[60ch] text-center font-medium text-muted-foreground/60 text-sm md:text-base">
                  <Trans>
                    This document has been cancelled by the owner and is no longer available for others to sign.
                  </Trans>
                </p>
              ))}

            <div className="mt-8 flex w-full max-w-xs flex-col items-stretch gap-4 md:w-auto md:max-w-none md:flex-row md:items-center">
              <DocumentShareButton
                documentId={document.id}
                token={recipient.token}
                className="w-full max-w-none md:flex-1"
              />

              {downloadState.kind === 'ready' && (
                <EnvelopeDownloadDialog
                  envelopeId={document.envelopeId}
                  envelopeStatus={downloadState.envelopeStatus}
                  envelopeItems={document.envelopeItems}
                  token={recipient?.token}
                  trigger={
                    <Button type="button" variant="outline" className="flex-1 md:flex-initial">
                      <DownloadIcon className="mr-2 h-5 w-5" />
                      <Trans>Download</Trans>
                    </Button>
                  }
                />
              )}

              {downloadState.kind === 'pending' && (
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 md:flex-initial"
                  disabled
                  aria-describedby="completion-download-reason"
                >
                  <DownloadIcon className="mr-2 h-5 w-5" />
                  <Trans>Download</Trans>
                </Button>
              )}

              {user && (
                <Button asChild>
                  <Link to={returnToHomePath}>
                    <Trans>Go Back Home</Trans>
                  </Link>
                </Button>
              )}
            </div>

            {downloadState.kind === 'pending' && (
              <p id="completion-download-reason" className="mt-3 text-center text-muted-foreground/60 text-xs">
                <Trans>The signed PDF can be downloaded once the document is complete.</Trans>
              </p>
            )}

            {/* DEV-654: renders only on an in-person handoff device (see the panel). */}
            {document.status === DocumentStatus.PENDING && (
              <DocumentSigningHandoffPanel documentId={document.id} completedRecipientToken={recipient.token} />
            )}
          </div>
        </div>
      </div>
    </>
  );
};
