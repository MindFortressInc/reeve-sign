import { isBase64Image } from '@documenso/lib/constants/signatures';
import { DocumentAuth, type TRecipientActionAuth } from '@documenso/lib/types/document-auth';
import { isSignatureFieldType } from '@documenso/prisma/guards/is-signature-field';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { RadioGroup, RadioGroupItem } from '@documenso/ui/primitives/radio-group';
import { SignaturePadDialog } from '@documenso/ui/primitives/signature-pad/signature-pad-dialog';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { FieldType, RecipientRole } from '@prisma/client';
import { useMemo } from 'react';

import { useEmbedSigningContext } from '~/components/embed/embed-signing-context';
import { getFieldsToSignWithAdoptedSignature } from '~/utils/field-signing/adopted-signature-fields';

import { useRequiredDocumentSigningAuthContext } from '../document-signing/document-signing-auth-provider';
import { useRequiredEnvelopeSigningContext } from '../document-signing/envelope-signing-provider';

export type EnvelopeSignerFormProps = {
  /**
   * Insert a signature adopted in the Signature box into the signer's unsigned
   * signature fields. Set by the mobile "Sign Document" bar, where signers
   * expect that box to sign the document. The desktop sidebar keeps the
   * upstream behaviour: the signature is a default applied when a field is
   * tapped.
   */
  insertAdoptedSignature?: boolean;
};

export default function EnvelopeSignerForm({ insertAdoptedSignature = false }: EnvelopeSignerFormProps) {
  const {
    fullName,
    signature,
    setFullName,
    setSignature,
    envelope,
    recipientFields,
    recipient,
    assistantFields,
    assistantRecipients,
    selectedAssistantRecipient,
    setSelectedAssistantRecipientId,
    signField,
  } = useRequiredEnvelopeSigningContext();

  const { executeActionAuthProcedure } = useRequiredDocumentSigningAuthContext();

  const { isNameLocked, onFieldSigned } = useEmbedSigningContext() || {};

  const { t } = useLingui();
  const { toast } = useToast();

  const hasSignatureField = useMemo(() => {
    return recipientFields.some((field) => isSignatureFieldType(field.type));
  }, [recipientFields]);

  const isSubmitting = false;

  // DEV-20648: see `insertAdoptedSignature`.
  const onSignatureAdopted = (value: string) => {
    setSignature(value);

    const fieldsToSign = getFieldsToSignWithAdoptedSignature(recipientFields);

    if (!insertAdoptedSignature || !value || fieldsToSign.length === 0) {
      return;
    }

    void executeActionAuthProcedure({
      actionTarget: FieldType.SIGNATURE,
      onReauthFormSubmit: async (authOptions?: TRecipientActionAuth) => {
        // A passkey response is single-use, so it covers one field. The rest
        // take the saved signature on tap.
        const targets = authOptions?.type === DocumentAuth.PASSKEY ? fieldsToSign.slice(0, 1) : fieldsToSign;

        try {
          for (const field of targets) {
            await signField(field.id, { type: FieldType.SIGNATURE, value }, authOptions);

            // Same payload shape as a field tap (EnvelopeSignerPageRenderer).
            const embedValue = JSON.stringify(value);
            onFieldSigned?.({ fieldId: field.id, value: embedValue, isBase64: isBase64Image(embedValue) });
          }
        } catch (err) {
          console.error(err);

          toast({
            title: t`Error`,
            description: t`An error occurred while signing the field.`,
            variant: 'destructive',
          });

          throw err;
        }
      },
    });
  };

  if (recipient.role === RecipientRole.VIEWER) {
    return null;
  }

  if (recipient.role === RecipientRole.ASSISTANT) {
    return (
      <fieldset className="embed--DocumentWidgetForm rounded-2xl border-border sm:border sm:p-3 dark:bg-background">
        <RadioGroup
          className="gap-0 space-y-2 shadow-none sm:space-y-3"
          value={selectedAssistantRecipient?.id?.toString()}
          onValueChange={(value) => {
            setSelectedAssistantRecipientId(Number(value));
          }}
        >
          {assistantRecipients
            .filter((r) => r.fields.length > 0)
            .map((r) => (
              <div key={r.id} className="relative flex flex-col gap-4 rounded-lg border border-border bg-widget p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <RadioGroupItem
                      id={r.id.toString()}
                      value={r.id.toString()}
                      className="after:absolute after:inset-0"
                    />

                    <div className="grid grow gap-1">
                      <Label className="inline-flex items-start" htmlFor={r.id.toString()}>
                        {r.name}

                        {r.id === recipient.id && (
                          <span className="ml-2 text-muted-foreground">
                            <Trans>(You)</Trans>
                          </span>
                        )}
                      </Label>
                      <p className="text-muted-foreground text-xs">{r.email}</p>
                    </div>
                  </div>
                  <div className="text-muted-foreground text-xs leading-[inherit]">
                    <Plural
                      value={assistantFields.filter((field) => field.recipientId === r.id).length}
                      one="# field"
                      other="# fields"
                    />
                  </div>
                </div>
              </div>
            ))}
        </RadioGroup>
      </fieldset>
    );
  }

  return (
    <fieldset disabled={isSubmitting} className="flex flex-1 flex-col gap-4">
      <div className="flex flex-1 flex-col gap-y-4">
        <div>
          <Label htmlFor="full-name">
            <Trans>Full Name</Trans>
          </Label>

          <Input
            type="text"
            id="full-name"
            className="mt-2 bg-background"
            value={fullName}
            disabled={isNameLocked}
            onChange={(e) => !isNameLocked && setFullName(e.target.value.trimStart())}
          />
        </div>

        {hasSignatureField && (
          <div>
            <Label htmlFor="Signature">
              <Trans>Signature</Trans>
            </Label>

            <SignaturePadDialog
              className="mt-2"
              disabled={isSubmitting}
              fullName={fullName}
              value={signature ?? ''}
              onChange={(v) => onSignatureAdopted(v ?? '')}
              typedSignatureEnabled={envelope.documentMeta.typedSignatureEnabled}
              uploadSignatureEnabled={envelope.documentMeta.uploadSignatureEnabled}
              drawSignatureEnabled={envelope.documentMeta.drawSignatureEnabled}
            />
          </div>
        )}
      </div>
    </fieldset>
  );
}
