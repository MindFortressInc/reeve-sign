import signingCelebration from '@documenso/assets/images/signing-celebration.png';
import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { loadRecipientBrandingByTeamId } from '@documenso/lib/server-only/branding/load-recipient-branding';
import { getDocumentAndSenderByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { isRecipientAuthorized } from '@documenso/lib/server-only/document/is-recipient-authorized';
import { getFieldsForToken } from '@documenso/lib/server-only/field/get-fields-for-token';
import { getRecipientByToken } from '@documenso/lib/server-only/recipient/get-recipient-by-token';
import { getRecipientSignatures } from '@documenso/lib/server-only/recipient/get-recipient-signatures';
import { isRecipientViewer } from '@documenso/lib/server-only/recipient/signer-proof-cookie';
import { trpc } from '@documenso/trpc/react';
import { DocumentShareButton } from '@documenso/ui/components/document/document-share-button';
import { SigningCard3D } from '@documenso/ui/components/signing-card';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus, FieldType, RecipientRole } from '@prisma/client';
import { CheckCircle2, Clock8, DownloadIcon, Loader2 } from 'lucide-react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';

import { EnvelopeDownloadDialog } from '~/components/dialogs/envelope-download-dialog';
import { DocumentRedactedPreview } from '~/components/general/document/document-redacted-preview';
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

  // DEV-15772: a signing link gets forwarded. Only the browser that signed, or a
  // session logged in as the recipient, sees who signed and can download; anyone
  // else gets a redacted view carrying nothing about the recipient or document.
  if (
    !isRecipientViewer({
      token,
      headers: request.headers,
      recipientEmail: recipient.email,
      sessionEmail: user?.email,
    })
  ) {
    return {
      isRedacted: true,
      isSignedIn: !!user,
      signInPath: `/signin?returnTo=${encodeURIComponent(`/sign/${token}/complete`)}`,
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
    return {
      isDocumentAccessValid: false,
      recipientEmail: recipient.email,
      branding,
    } as const;
  }

  const signatures = await getRecipientSignatures({ recipientId: recipient.id });

  const recipientName =
    recipient.name || fields.find((field) => field.type === FieldType.NAME)?.customText || recipient.email;

  const canRedirectToFolder = user && document.userId === user.id && document.folderId && document.team?.url;

  const returnToHomePath = canRedirectToFolder ? `/t/${document.team.url}/documents/f/${document.folderId}` : '/';

  return {
    isDocumentAccessValid: true,
    recipientName,
    recipientEmail: recipient.email,
    signatures,
    document,
    recipient,
    returnToHomePath,
    branding,
  };
}

export default function CompletedSigningPage({ loaderData }: Route.ComponentProps) {
  const cspNonce = useCspNonce();

  if (loaderData.isRedacted) {
    return (
      <>
        <RecipientBranding branding={loaderData.branding} cspNonce={cspNonce} />
        <div className="flex flex-col items-center pt-8 lg:pt-16">
          <DocumentRedactedPreview signInPath={loaderData.signInPath} isSignedIn={loaderData.isSignedIn} />
        </div>
      </>
    );
  }

  return <CompletedSigningPageView loaderData={loaderData} />;
}

type CompletedSigningPageViewProps = {
  loaderData: Exclude<Route.ComponentProps['loaderData'], { isRedacted: true }>;
};

const CompletedSigningPageView = ({ loaderData }: CompletedSigningPageViewProps) => {
  const { _ } = useLingui();

  const { sessionData } = useOptionalSession();
  const user = sessionData?.user;
  const cspNonce = useCspNonce();

  const {
    isDocumentAccessValid,
    recipientName,
    signatures,
    document,
    recipient,
    recipientEmail,
    returnToHomePath,
    branding,
  } = loaderData;

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
        <DocumentSigningAuthPageView email={recipientEmail} />
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
