import { useCurrentEnvelopeEditor } from '@documenso/lib/client-only/providers/envelope-editor-provider';
import { getEnvelopeItemPermissions, mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@documenso/ui/primitives/dropdown-menu';
import { Separator } from '@documenso/ui/primitives/separator';
import { Trans, useLingui } from '@lingui/react/macro';
import { DocumentStatus, EnvelopeType, TemplateType } from '@prisma/client';
import {
  AlertTriangleIcon,
  Building2Icon,
  Globe2Icon,
  LockIcon,
  MoreVerticalIcon,
  RefreshCwIcon,
  SendIcon,
  SettingsIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';

import { EnvelopeDistributeDialog } from '~/components/dialogs/envelope-distribute-dialog';
import { EnvelopeRedistributeDialog } from '~/components/dialogs/envelope-redistribute-dialog';
import { TemplateUseDialog } from '~/components/dialogs/template-use-dialog';
import { BrandingLogo } from '~/components/general/branding-logo';
import { DocumentAttachmentsPopover } from '~/components/general/document/document-attachments-popover';
import { EmbeddedEditorAttachmentPopover } from '~/components/general/document/embedded-editor-attachment-popover';
import { EnvelopeEditorSettingsDialog } from '~/components/general/envelope-editor/envelope-editor-settings-dialog';

import { TemplateDirectLinkBadge } from '../template/template-direct-link-badge';
import { EnvelopeItemTitleInput } from './envelope-editor-title-input';

/**
 * Lets badges shrink and truncate below the `md` breakpoint so they never paint
 * over the right-hand action cluster, while rendering exactly as before at `md+`.
 */
const collapsibleBadgeClassName =
  'min-w-0 max-w-full shrink overflow-hidden md:max-w-none md:shrink-0 md:overflow-visible';

/**
 * Expands the tap area of the compact mobile header controls to at least 44px
 * without changing their visual size.
 */
const mobileHitAreaClassName = "relative after:absolute after:-inset-y-1 after:inset-x-0 after:content-['']";

export default function EnvelopeEditorHeader() {
  const { t } = useLingui();

  const {
    envelope,
    isDocument,
    isTemplate,
    isEmbedded,
    updateEnvelope,
    autosaveError,
    relativePath,
    editorConfig,
    flushAutosave,
  } = useCurrentEnvelopeEditor();

  const {
    embedded,
    general: { allowConfigureEnvelopeTitle },
    actions: { allowAttachments, allowDistributing },
  } = editorConfig;

  const envelopeItemPermissions = useMemo(
    () => getEnvelopeItemPermissions(envelope, envelope.recipients),
    [envelope, envelope.recipients],
  );

  const handleCreateEmbeddedEnvelope = async () => {
    const latestEnvelope = await flushAutosave();

    embedded?.onCreate?.(latestEnvelope);
  };

  const handleUpdateEmbeddedEnvelope = async () => {
    const latestEnvelope = await flushAutosave();

    embedded?.onUpdate?.(latestEnvelope);
  };

  const showMobileOverflowMenu = Boolean(editorConfig.settings) || (!isEmbedded && isDocument && allowDistributing);

  return (
    <nav className="w-full border-border border-b bg-background px-4 py-3 md:px-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center space-x-4">
          {editorConfig.embedded?.customBrandingLogo ? (
            <img src={`/api/branding/logo/team/${envelope.teamId}`} alt="Logo" className="h-6 w-auto shrink-0" />
          ) : (
            <Link to="/" className="shrink-0">
              <BrandingLogo className="h-6 w-auto" />
            </Link>
          )}
          <Separator orientation="vertical" className="h-6 shrink-0" />

          <div className="flex min-w-0 items-center space-x-2">
            <div className="hidden min-w-0 max-w-full shrink md:block">
              <EnvelopeItemTitleInput
                dataTestId="envelope-title-input"
                disabled={!envelopeItemPermissions.canTitleBeChanged || !allowConfigureEnvelopeTitle}
                value={envelope.title}
                onChange={(title) => {
                  updateEnvelope({
                    data: {
                      title,
                    },
                  });
                }}
                placeholder={t`Envelope Title`}
              />
            </div>

            {envelope.type === EnvelopeType.TEMPLATE && (
              <>
                {envelope.templateType === TemplateType.PRIVATE && (
                  <Badge variant="secondary" className={collapsibleBadgeClassName}>
                    <LockIcon className="mr-2 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300" />
                    <span className="truncate">
                      <Trans>Private Template</Trans>
                    </span>
                  </Badge>
                )}
                {envelope.templateType === TemplateType.ORGANISATION && (
                  <Badge variant="orange" className={collapsibleBadgeClassName}>
                    <Building2Icon className="mr-2 size-4 shrink-0" />
                    <span className="truncate">
                      <Trans>Organisation Template</Trans>
                    </span>
                  </Badge>
                )}
                {envelope.templateType === TemplateType.PUBLIC && (
                  <Badge variant="default" className={collapsibleBadgeClassName}>
                    <Globe2Icon className="mr-2 h-4 w-4 shrink-0 text-green-500 dark:text-green-300" />
                    <span className="truncate">
                      <Trans>Public Template</Trans>
                    </span>
                  </Badge>
                )}

                {envelope.directLink?.token && (
                  <TemplateDirectLinkBadge
                    className="min-w-0 shrink overflow-hidden whitespace-nowrap py-1 md:shrink-0 md:overflow-visible"
                    token={envelope.directLink.token}
                    enabled={envelope.directLink.enabled}
                  />
                )}
              </>
            )}

            {envelope.type === EnvelopeType.DOCUMENT &&
              match(envelope.status)
                .with(DocumentStatus.DRAFT, () => (
                  <Badge variant="warning" className={collapsibleBadgeClassName}>
                    <span className="truncate">
                      <Trans>Draft</Trans>
                    </span>
                  </Badge>
                ))
                .with(DocumentStatus.PENDING, () => (
                  <Badge variant="secondary" className={collapsibleBadgeClassName}>
                    <span className="truncate">
                      <Trans>Pending</Trans>
                    </span>
                  </Badge>
                ))
                .with(DocumentStatus.COMPLETED, () => (
                  <Badge variant="default" className={collapsibleBadgeClassName}>
                    <span className="truncate">
                      <Trans>Completed</Trans>
                    </span>
                  </Badge>
                ))
                .with(DocumentStatus.REJECTED, () => (
                  <Badge variant="destructive" className={collapsibleBadgeClassName}>
                    <span className="truncate">
                      <Trans>Rejected</Trans>
                    </span>
                  </Badge>
                ))
                .exhaustive()}

            {autosaveError && (
              <>
                <Badge variant="destructive" className={collapsibleBadgeClassName}>
                  <AlertTriangleIcon className="mr-2 h-4 w-4 shrink-0" />
                  <span className="truncate">
                    <Trans>Sync failed, changes not saved</Trans>
                  </span>
                </Badge>

                <button
                  className="shrink-0"
                  onClick={() => {
                    window.location.reload();
                  }}
                >
                  <Badge variant="destructive" className="shrink-0">
                    <RefreshCwIcon className="mr-2 h-4 w-4" />
                    <Trans>Reload</Trans>
                  </Badge>
                </button>
              </>
            )}
          </div>
        </div>

        <div className="hidden shrink-0 items-center space-x-2 md:flex">
          {allowAttachments &&
            (isEmbedded ? (
              <EmbeddedEditorAttachmentPopover buttonSize="sm" />
            ) : (
              <DocumentAttachmentsPopover envelopeId={envelope.id} buttonSize="sm" />
            ))}

          {editorConfig.settings && (
            <EnvelopeEditorSettingsDialog
              trigger={
                <Button variant="outline" size="sm">
                  <SettingsIcon className="h-4 w-4" />
                </Button>
              }
            />
          )}

          {match({ isEmbedded, isDocument, isTemplate, allowDistributing })
            .with({ isEmbedded: false, isDocument: true, allowDistributing: true }, () => (
              <>
                <EnvelopeDistributeDialog
                  documentRootPath={relativePath.documentRootPath}
                  trigger={
                    <Button size="sm">
                      <SendIcon className="mr-2 h-4 w-4" />
                      <Trans>Send Document</Trans>
                    </Button>
                  }
                />

                <EnvelopeRedistributeDialog
                  envelope={envelope}
                  trigger={
                    <Button size="sm">
                      <SendIcon className="mr-2 h-4 w-4" />
                      <Trans>Resend Document</Trans>
                    </Button>
                  }
                />
              </>
            ))
            .with({ isEmbedded: false, isTemplate: true, allowDistributing: true }, () => (
              <TemplateUseDialog
                envelopeId={envelope.id}
                templateId={mapSecondaryIdToTemplateId(envelope.secondaryId)}
                templateSigningOrder={envelope.documentMeta?.signingOrder}
                recipients={envelope.recipients}
                documentRootPath={relativePath.documentRootPath}
                trigger={
                  <Button size="sm">
                    <Trans>Use Template</Trans>
                  </Button>
                }
              />
            ))

            .otherwise(() => null)}

          {embedded?.mode === 'create' && (
            <Button size="sm" onClick={handleCreateEmbeddedEnvelope}>
              {isDocument ? <Trans>Create Document</Trans> : <Trans>Create Template</Trans>}
            </Button>
          )}

          {embedded?.mode === 'edit' && (
            <Button size="sm" onClick={handleUpdateEmbeddedEnvelope}>
              {isDocument ? <Trans>Update Document</Trans> : <Trans>Update Template</Trans>}
            </Button>
          )}
        </div>

        {/* Compact action cluster for viewports below the `md` breakpoint. */}
        <div className="flex shrink-0 items-center space-x-2 md:hidden">
          {allowAttachments &&
            (isEmbedded ? (
              <EmbeddedEditorAttachmentPopover
                buttonSize="sm"
                buttonClassName={`h-9 w-11 justify-center gap-0 p-0 [&>span]:hidden ${mobileHitAreaClassName}`}
              />
            ) : (
              <DocumentAttachmentsPopover
                envelopeId={envelope.id}
                buttonSize="sm"
                buttonClassName={`h-9 w-11 justify-center gap-0 p-0 [&>span]:hidden ${mobileHitAreaClassName}`}
              />
            ))}

          {!isEmbedded && isTemplate && allowDistributing && (
            <TemplateUseDialog
              envelopeId={envelope.id}
              templateId={mapSecondaryIdToTemplateId(envelope.secondaryId)}
              templateSigningOrder={envelope.documentMeta?.signingOrder}
              recipients={envelope.recipients}
              documentRootPath={relativePath.documentRootPath}
              trigger={
                <Button size="sm" className={mobileHitAreaClassName}>
                  <Trans>Use Template</Trans>
                </Button>
              }
            />
          )}

          {embedded?.mode === 'create' && (
            <Button size="sm" className={mobileHitAreaClassName} onClick={handleCreateEmbeddedEnvelope}>
              {isDocument ? <Trans>Create Document</Trans> : <Trans>Create Template</Trans>}
            </Button>
          )}

          {embedded?.mode === 'edit' && (
            <Button size="sm" className={mobileHitAreaClassName} onClick={handleUpdateEmbeddedEnvelope}>
              {isDocument ? <Trans>Update Document</Trans> : <Trans>Update Template</Trans>}
            </Button>
          )}

          {showMobileOverflowMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="relative h-9 w-9 p-0 after:absolute after:-inset-1 after:content-['']"
                >
                  <MoreVerticalIcon className="h-4 w-4" />
                  <span className="sr-only">
                    <Trans>More options</Trans>
                  </span>
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent align="end">
                {editorConfig.settings && (
                  <EnvelopeEditorSettingsDialog
                    trigger={
                      <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                        <div>
                          <SettingsIcon className="mr-2 h-4 w-4" />
                          <Trans>Settings</Trans>
                        </div>
                      </DropdownMenuItem>
                    }
                  />
                )}

                {!isEmbedded && isDocument && allowDistributing && (
                  <>
                    <EnvelopeDistributeDialog
                      documentRootPath={relativePath.documentRootPath}
                      trigger={
                        <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                          <div>
                            <SendIcon className="mr-2 h-4 w-4" />
                            <Trans>Send Document</Trans>
                          </div>
                        </DropdownMenuItem>
                      }
                    />

                    <EnvelopeRedistributeDialog
                      envelope={envelope}
                      trigger={
                        <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                          <div>
                            <SendIcon className="mr-2 h-4 w-4" />
                            <Trans>Resend Document</Trans>
                          </div>
                        </DropdownMenuItem>
                      }
                    />
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </nav>
  );
}
