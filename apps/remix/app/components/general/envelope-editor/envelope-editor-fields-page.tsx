import { useIsBelowLg } from '@documenso/lib/client-only/hooks/use-is-below-lg';
import { useCurrentEnvelopeEditor } from '@documenso/lib/client-only/providers/envelope-editor-provider';
import { useCurrentEnvelopeRender } from '@documenso/lib/client-only/providers/envelope-render-provider';
import { PDF_VIEWER_ERROR_MESSAGES } from '@documenso/lib/constants/pdf-viewer-i18n';
import type { NormalizedFieldWithContext } from '@documenso/lib/server-only/ai/envelope/detect-fields/types';
import {
  FIELD_META_DEFAULT_VALUES,
  type TCheckboxFieldMeta,
  type TDateFieldMeta,
  type TDropdownFieldMeta,
  type TEmailFieldMeta,
  type TFieldMetaSchema,
  type TInitialsFieldMeta,
  type TNameFieldMeta,
  type TNumberFieldMeta,
  type TRadioFieldMeta,
  type TSignatureFieldMeta,
  type TTextFieldMeta,
} from '@documenso/lib/types/field-meta';
import { getEnvelopeItemPermissions } from '@documenso/lib/utils/envelope';
import { canRecipientFieldsBeModified } from '@documenso/lib/utils/recipients';
import { AnimateGenericFadeInOut } from '@documenso/ui/components/animate/animate-generic-fade-in-out';
import { cn } from '@documenso/ui/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@documenso/ui/primitives/alert';
import { Button } from '@documenso/ui/primitives/button';
import { Separator } from '@documenso/ui/primitives/separator';
import { Sheet, SheetContent, SheetTitle } from '@documenso/ui/primitives/sheet';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus, FieldType, RecipientRole } from '@prisma/client';
import { FileTextIcon, PencilIcon, SparklesIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRevalidator, useSearchParams } from 'react-router';
import { isDeepEqual } from 'remeda';
import { match } from 'ts-pattern';

import { AiFeaturesEnableDialog } from '~/components/dialogs/ai-features-enable-dialog';
import { AiFieldDetectionDialog } from '~/components/dialogs/ai-field-detection-dialog';
import { EnvelopeItemEditDialog } from '~/components/dialogs/envelope-item-edit-dialog';
import { EditorFieldCheckboxForm } from '~/components/forms/editor/editor-field-checkbox-form';
import { EditorFieldDateForm } from '~/components/forms/editor/editor-field-date-form';
import { EditorFieldDropdownForm } from '~/components/forms/editor/editor-field-dropdown-form';
import { EditorFieldEmailForm } from '~/components/forms/editor/editor-field-email-form';
import { EditorFieldInitialsForm } from '~/components/forms/editor/editor-field-initials-form';
import { EditorFieldNameForm } from '~/components/forms/editor/editor-field-name-form';
import { EditorFieldNumberForm } from '~/components/forms/editor/editor-field-number-form';
import { EditorFieldRadioForm } from '~/components/forms/editor/editor-field-radio-form';
import { EditorFieldSignatureForm } from '~/components/forms/editor/editor-field-signature-form';
import { EditorFieldTextForm } from '~/components/forms/editor/editor-field-text-form';
import { EnvelopePdfViewer } from '~/components/general/pdf-viewer/envelope-pdf-viewer';
import { useCurrentTeam } from '~/providers/team';

import { EnvelopeEditorFieldPalette, EnvelopeEditorFieldPlacementLayer } from './envelope-editor-fields-drag-drop';
import { EnvelopeEditorFieldsPageRenderer } from './envelope-editor-fields-page-renderer';
import { EnvelopeRendererFileSelector } from './envelope-file-selector';
import { EnvelopeRecipientSelector } from './envelope-recipient-selector';

const FieldSettingsTypeTranslations: Record<FieldType, MessageDescriptor> = {
  [FieldType.SIGNATURE]: msg`Signature Settings`,
  [FieldType.FREE_SIGNATURE]: msg`Free Signature Settings`,
  [FieldType.TEXT]: msg`Text Settings`,
  [FieldType.DATE]: msg`Date Settings`,
  [FieldType.EMAIL]: msg`Email Settings`,
  [FieldType.NAME]: msg`Name Settings`,
  [FieldType.INITIALS]: msg`Initials Settings`,
  [FieldType.NUMBER]: msg`Number Settings`,
  [FieldType.RADIO]: msg`Radio Settings`,
  [FieldType.CHECKBOX]: msg`Checkbox Settings`,
  [FieldType.DROPDOWN]: msg`Dropdown Settings`,
};

export const EnvelopeEditorFieldsPage = () => {
  const [searchParams] = useSearchParams();

  const team = useCurrentTeam();

  const scrollableContainerRef = useRef<HTMLDivElement>(null);

  const { envelope, editorFields, navigateToStep, editorConfig } = useCurrentEnvelopeEditor();

  const { currentEnvelopeItem } = useCurrentEnvelopeRender();

  const { _ } = useLingui();

  const [isAiFieldDialogOpen, setIsAiFieldDialogOpen] = useState(false);
  const [isAiEnableDialogOpen, setIsAiEnableDialogOpen] = useState(false);
  const [isMobileFieldsPanelOpen, setIsMobileFieldsPanelOpen] = useState(false);
  const { revalidate } = useRevalidator();

  const isBelowLg = useIsBelowLg();

  const envelopeItemPermissions = useMemo(
    () => getEnvelopeItemPermissions(envelope, envelope.recipients),
    [envelope, envelope.recipients],
  );

  const selectedField = useMemo(() => structuredClone(editorFields.selectedField), [editorFields.selectedField]);

  const updateSelectedFieldMeta = (fieldMeta: TFieldMetaSchema) => {
    if (!selectedField) {
      return;
    }

    const isMetaSame = isDeepEqual(selectedField.fieldMeta, fieldMeta);

    if (!isMetaSame) {
      editorFields.updateFieldByFormId(selectedField.formId, {
        fieldMeta,
      });
    }
  };

  const onFieldDetectionComplete = (fields: NormalizedFieldWithContext[]) => {
    for (const field of fields) {
      editorFields.addField({
        height: field.height,
        width: field.width,
        positionX: field.positionX,
        positionY: field.positionY,
        type: field.type,
        envelopeItemId: field.envelopeItemId,
        recipientId: field.recipientId,
        page: field.pageNumber,
        fieldMeta: structuredClone(FIELD_META_DEFAULT_VALUES[field.type]),
      });
    }

    setIsAiFieldDialogOpen(false);
  };

  /**
   * Set the selected recipient to the first recipient in the envelope.
   */
  useEffect(() => {
    const firstSelectableRecipient = envelope.recipients.find(
      (recipient) => recipient.role === RecipientRole.SIGNER || recipient.role === RecipientRole.APPROVER,
    );

    editorFields.setSelectedRecipient(firstSelectableRecipient?.id ?? null);
  }, []);

  const onDetectClick = () => {
    // Below lg the button that got us here is inside the sheet; leaving the
    // sheet up would stack a dialog on it and lock body scroll twice.
    setIsMobileFieldsPanelOpen(false);

    if (!team.preferences.aiFeaturesEnabled) {
      setIsAiEnableDialogOpen(true);
      return;
    }

    setIsAiFieldDialogOpen(true);
  };

  const onAiFeaturesEnabled = () => {
    void revalidate().then(() => {
      setIsAiEnableDialogOpen(false);
      setIsAiFieldDialogOpen(true);
    });
  };

  const hasFieldsPanel = currentEnvelopeItem !== null && envelope.recipients.length > 0;

  const selectedFieldFormId = editorFields.selectedField?.formId ?? null;

  const knownFieldFormIds = useRef<Set<string>>(new Set());
  const autoOpenedForFormId = useRef<string | null>(null);

  /**
   * Placement spans two surfaces — arm a type in the palette, click the page to
   * drop it — and below lg the palette's sheet must close in between. So the
   * armed type lives here, not in the palette: the palette unmounts with the
   * sheet, and an armed type that unmounts is a placement the user can never
   * finish.
   */
  const [armedFieldType, setArmedFieldType] = useState<FieldType | null>(null);

  const onPickFieldType = (fieldType: FieldType) => {
    setArmedFieldType(fieldType);

    // The document is what gets clicked next, and below lg the sheet is on top
    // of it.
    setIsMobileFieldsPanelOpen(false);
  };

  /**
   * Below lg the settings form lives in a sheet, so tapping a field on the
   * document would otherwise change something the user cannot see. Open the
   * sheet on selection so tapping a field reveals its settings — the sidebar
   * equivalent at lg needs no such nudge because it is always on screen.
   *
   * Placement is the exception: `addField` selects the field it just created,
   * so opening here would cover the document after every tap-to-place and
   * break placing several fields in a row. A field that was not on the page
   * before this render is a placement, not a tap — skip it. The sticky
   * trigger bar stays on screen either way, so the panel is always one tap
   * away for the field that was just placed.
   */
  useEffect(() => {
    const knownBeforeThisRender = knownFieldFormIds.current;

    knownFieldFormIds.current = new Set(editorFields.localFields.map((field) => field.formId));

    if (!isBelowLg || !selectedFieldFormId) {
      // Selection cleared — the next tap on this same field is a new intent.
      autoOpenedForFormId.current = null;
      return;
    }

    // `localFields` also changes on move/resize/meta edits. Acting on those
    // would reopen a sheet the user just dismissed mid-drag, so each selection
    // gets exactly one chance to open the panel.
    if (autoOpenedForFormId.current === selectedFieldFormId) {
      return;
    }

    autoOpenedForFormId.current = selectedFieldFormId;

    if (!knownBeforeThisRender.has(selectedFieldFormId)) {
      return;
    }

    setIsMobileFieldsPanelOpen(true);
  }, [isBelowLg, selectedFieldFormId, editorFields.localFields]);

  const fieldsPanelContent = (
    <>
      {/* Recipient selector section. */}
      <section className="px-4">
        <h3 className="mb-2 font-semibold text-foreground text-sm">
          <Trans>Selected Recipient</Trans>
        </h3>

        <EnvelopeRecipientSelector
          selectedRecipient={editorFields.selectedRecipient}
          onSelectedRecipientChange={(recipient) => editorFields.setSelectedRecipient(recipient.id)}
          recipients={envelope.recipients}
          fields={envelope.fields}
          className="w-full"
          align="end"
        />

        {editorFields.selectedRecipient &&
          !canRecipientFieldsBeModified(editorFields.selectedRecipient, envelope.fields) && (
            <Alert className="mt-4" variant="warning">
              <AlertDescription>
                <Trans>
                  This recipient can no longer be modified as they have signed a field, or completed the document.
                </Trans>
              </AlertDescription>
            </Alert>
          )}
      </section>

      <Separator className="my-4" />

      {/* Add fields section. */}
      <section className="px-4">
        <h3 className="mb-2 font-semibold text-foreground text-sm">
          <Trans>Add Fields</Trans>
        </h3>

        <EnvelopeEditorFieldPalette
          selectedRecipientId={editorFields.selectedRecipient?.id ?? null}
          armedFieldType={armedFieldType}
          onPickFieldType={onPickFieldType}
        />

        {editorConfig.fields?.allowAIDetection && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4 w-full"
            onClick={onDetectClick}
            disabled={envelope.status !== DocumentStatus.DRAFT}
            title={
              envelope.status !== DocumentStatus.DRAFT
                ? _(msg`You can only detect fields in draft envelopes`)
                : undefined
            }
          >
            <SparklesIcon className="mr-2 -ml-1 h-4 w-4" />
            <Trans>Detect with AI</Trans>
          </Button>
        )}
      </section>

      {/* Field details section. */}
      <AnimateGenericFadeInOut key={editorFields.selectedField?.formId}>
        {selectedField && (
          <section>
            <Separator className="my-4" />

            {searchParams.get('devmode') && (
              <>
                <div className="px-4">
                  <h3 className="mb-3 font-semibold text-foreground text-sm">
                    <Trans>Developer Mode</Trans>
                  </h3>

                  <div className="space-y-2 rounded-md border border-border bg-muted/50 p-3 text-foreground text-sm">
                    {selectedField.id && (
                      <p>
                        <span className="min-w-12 text-muted-foreground">
                          <Trans>Field ID:</Trans>
                        </span>{' '}
                        {selectedField.id}
                      </p>
                    )}
                    <p>
                      <span className="min-w-12 text-muted-foreground">
                        <Trans>Recipient ID:</Trans>
                      </span>{' '}
                      {selectedField.recipientId}
                    </p>
                    <p>
                      <span className="min-w-12 text-muted-foreground">
                        <Trans>Pos X:</Trans>
                      </span>{' '}
                      {selectedField.positionX.toFixed(2)}
                    </p>
                    <p>
                      <span className="min-w-12 text-muted-foreground">
                        <Trans>Pos Y:</Trans>
                      </span>{' '}
                      {selectedField.positionY.toFixed(2)}
                    </p>
                    <p>
                      <span className="min-w-12 text-muted-foreground">
                        <Trans>Width:</Trans>
                      </span>{' '}
                      {selectedField.width.toFixed(2)}
                    </p>
                    <p>
                      <span className="min-w-12 text-muted-foreground">
                        <Trans>Height:</Trans>
                      </span>{' '}
                      {selectedField.height.toFixed(2)}
                    </p>
                  </div>
                </div>

                <Separator className="my-4" />
              </>
            )}

            <div className="px-4 [&_label]:text-foreground/70 [&_label]:text-xs">
              <h3 className="font-semibold text-sm">{_(FieldSettingsTypeTranslations[selectedField.type])}</h3>

              {match(selectedField.type)
                .with(FieldType.SIGNATURE, () => (
                  <EditorFieldSignatureForm
                    value={selectedField?.fieldMeta as TSignatureFieldMeta | undefined}
                    onValueChange={(value) => updateSelectedFieldMeta(value)}
                  />
                ))
                .with(FieldType.CHECKBOX, () => (
                  <EditorFieldCheckboxForm
                    value={selectedField?.fieldMeta as TCheckboxFieldMeta | undefined}
                    onValueChange={(value) => updateSelectedFieldMeta(value)}
                  />
                ))
                .with(FieldType.DATE, () => (
                  <EditorFieldDateForm
                    value={selectedField?.fieldMeta as TDateFieldMeta | undefined}
                    onValueChange={(value) => updateSelectedFieldMeta(value)}
                  />
                ))
                .with(FieldType.DROPDOWN, () => (
                  <EditorFieldDropdownForm
                    value={selectedField?.fieldMeta as TDropdownFieldMeta | undefined}
                    onValueChange={(value) => updateSelectedFieldMeta(value)}
                  />
                ))
                .with(FieldType.EMAIL, () => (
                  <EditorFieldEmailForm
                    value={selectedField?.fieldMeta as TEmailFieldMeta | undefined}
                    onValueChange={(value) => updateSelectedFieldMeta(value)}
                  />
                ))
                .with(FieldType.INITIALS, () => (
                  <EditorFieldInitialsForm
                    value={selectedField?.fieldMeta as TInitialsFieldMeta | undefined}
                    onValueChange={(value) => updateSelectedFieldMeta(value)}
                  />
                ))
                .with(FieldType.NAME, () => (
                  <EditorFieldNameForm
                    value={selectedField?.fieldMeta as TNameFieldMeta | undefined}
                    onValueChange={(value) => updateSelectedFieldMeta(value)}
                  />
                ))
                .with(FieldType.NUMBER, () => (
                  <EditorFieldNumberForm
                    value={selectedField?.fieldMeta as TNumberFieldMeta | undefined}
                    onValueChange={(value) => updateSelectedFieldMeta(value)}
                  />
                ))
                .with(FieldType.RADIO, () => (
                  <EditorFieldRadioForm
                    value={selectedField?.fieldMeta as TRadioFieldMeta | undefined}
                    onValueChange={(value) => updateSelectedFieldMeta(value)}
                  />
                ))
                .with(FieldType.TEXT, () => (
                  <EditorFieldTextForm
                    value={selectedField?.fieldMeta as TTextFieldMeta | undefined}
                    onValueChange={(value) => updateSelectedFieldMeta(value)}
                  />
                ))
                .otherwise(() => null)}
            </div>
          </section>
        )}
      </AnimateGenericFadeInOut>
    </>
  );

  return (
    <div className="relative flex h-full">
      <div className="flex h-full w-full flex-col overflow-y-auto px-2" ref={scrollableContainerRef}>
        {/* Horizontal envelope item selector */}
        <EnvelopeRendererFileSelector
          className="px-0"
          fields={editorFields.localFields}
          renderItemAction={
            editorConfig.envelopeItems !== null &&
            editorConfig.envelopeItems.allowReplace &&
            envelopeItemPermissions.canFileBeChanged
              ? (item) => (
                  <div className="relative flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    <div
                      className={cn('h-2 w-2 rounded-full transition-opacity duration-150 group-hover:opacity-0', {
                        'bg-green-500': currentEnvelopeItem?.id === item.id,
                      })}
                    />
                    <EnvelopeItemEditDialog
                      envelopeItem={item}
                      allowConfigureTitle={editorConfig.envelopeItems?.allowConfigureTitle ?? false}
                      trigger={
                        <span
                          className="absolute inset-0 flex cursor-pointer items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`envelope-item-edit-button-${item.id}`}
                        >
                          <PencilIcon className="h-3.5 w-3.5" />
                        </span>
                      }
                    />
                  </div>
                )
              : undefined
          }
        />

        {/* Document View */}
        <div className="mt-4 flex h-full flex-col items-center justify-center">
          {envelope.recipients.length === 0 && (
            <Alert
              variant="neutral"
              className="mb-4 flex max-w-[800px] flex-row items-center justify-between space-y-0 rounded-sm border border-border bg-background"
            >
              <div className="flex flex-col gap-1">
                <AlertTitle>
                  <Trans>Missing Recipients</Trans>
                </AlertTitle>
                <AlertDescription>
                  <Trans>You need at least one recipient to add fields</Trans>
                </AlertDescription>
              </div>

              <Button variant="outline" onClick={() => void navigateToStep('upload')}>
                <Trans>Add Recipients</Trans>
              </Button>
            </Alert>
          )}

          {currentEnvelopeItem !== null ? (
            <EnvelopePdfViewer
              customPageRenderer={EnvelopeEditorFieldsPageRenderer}
              scrollParentRef={scrollableContainerRef}
              errorMessage={PDF_VIEWER_ERROR_MESSAGES.editor}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-32">
              <FileTextIcon className="h-10 w-10 text-muted-foreground" />
              <p className="mt-1 text-foreground text-sm">
                <Trans>No documents found</Trans>
              </p>
              <p className="mt-1 text-muted-foreground text-sm">
                <Trans>Please upload a document to continue</Trans>
              </p>
            </div>
          )}
        </div>

        {/* Mobile affordance for the panel that is a static sidebar at lg.
            Sticky to the bottom so it stays thumb-reachable while the document
            scrolls, and it names the selected recipient because that is the
            context every field placed from here inherits. */}
        {hasFieldsPanel && (
          <div className="sticky bottom-0 flex flex-shrink-0 items-center gap-2 border-border border-t bg-background px-4 py-2 lg:hidden">
            <Button
              type="button"
              size="sm"
              className="flex-shrink-0"
              data-testid="envelope-editor-mobile-fields-panel-trigger"
              onClick={() => setIsMobileFieldsPanelOpen(true)}
            >
              <PencilIcon className="mr-2 -ml-1 h-4 w-4" />
              <Trans>Add Fields</Trans>
            </Button>

            {editorFields.selectedRecipient && (
              <span className="truncate text-muted-foreground text-sm" data-testid="envelope-editor-mobile-recipient">
                {editorFields.selectedRecipient.name || editorFields.selectedRecipient.email}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Right Section - Form Fields Panel.
          Rendered from a single `fieldsPanelContent`: at lg and above as the
          static sidebar, below lg inside a sheet reached from the bar above.
          Two render sites, one implementation — the panel must not fork.
          The two sites are mutually exclusive on `isBelowLg`, not on CSS: a
          `hidden lg:block` sidebar stays MOUNTED below lg, so the panel's
          dialogs and field forms would mount twice against the same state. */}
      {hasFieldsPanel && !isBelowLg && (
        <div className="sticky top-0 hidden h-full w-80 flex-shrink-0 overflow-y-auto border-border border-l bg-background py-4 lg:block">
          {fieldsPanelContent}
        </div>
      )}

      {hasFieldsPanel && isBelowLg && (
        <Sheet open={isMobileFieldsPanelOpen} onOpenChange={setIsMobileFieldsPanelOpen}>
          <SheetContent position="bottom" size="lg" className="overflow-y-auto">
            <SheetTitle>
              <Trans>Fields</Trans>
            </SheetTitle>

            <div className="mt-4 pb-2">{fieldsPanelContent}</div>
          </SheetContent>
        </Sheet>
      )}

      {/* The placement layer is a root-level sibling of both panel hosts, so a
          field armed in the palette survives the sheet closing — closing it is
          exactly what makes the document clickable below lg. */}
      <EnvelopeEditorFieldPlacementLayer
        selectedRecipientId={editorFields.selectedRecipient?.id ?? null}
        selectedEnvelopeItemId={currentEnvelopeItem?.id ?? null}
        armedFieldType={armedFieldType}
        onArmedFieldTypeChange={setArmedFieldType}
      />

      {/* The AI dialogs live at the root, NOT inside `fieldsPanelContent`.
          Below lg that content is a child of the sheet, so a dialog rendered
          from it would unmount the moment the sheet closes — taking an
          in-flight detection with it. They are open-state controlled, so the
          root is the natural home and nothing about lg changes. */}
      {editorConfig.fields?.allowAIDetection && (
        <>
          <AiFieldDetectionDialog
            open={isAiFieldDialogOpen}
            onOpenChange={setIsAiFieldDialogOpen}
            onComplete={onFieldDetectionComplete}
            envelopeId={envelope.id}
            teamId={envelope.teamId}
          />

          <AiFeaturesEnableDialog
            open={isAiEnableDialogOpen}
            onOpenChange={setIsAiEnableDialogOpen}
            onEnabled={onAiFeaturesEnabled}
          />
        </>
      )}
    </div>
  );
};
