import {
  FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES,
  FIELD_FILE_UPLOAD_SIZE_LIMIT_MB,
} from '@documenso/lib/types/field-file-upload';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { createCallable } from 'react-call';

export type SignFieldFileUploadDialogProps = {
  token: string;
  fieldId: number;
};

export type SignFieldFileUploadResult = {
  key: string;
  fileName: string;
  size: number;
  mimeType: string;
};

const ALLOWED_MIME_TYPES: readonly string[] = FIELD_FILE_UPLOAD_ALLOWED_MIME_TYPES;

export const SignFieldFileUploadDialog = createCallable<
  SignFieldFileUploadDialogProps,
  SignFieldFileUploadResult | null
>(({ call, token, fieldId }) => {
  const { t } = useLingui();

  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const { mutateAsync: presignFileUpload } = trpc.envelope.field.presignFileUpload.useMutation();

  const onFileSelected = async (file: File | undefined) => {
    if (!file) {
      return;
    }

    setError(null);

    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      setError(t`This file type is not supported. Please upload a PDF, JPEG, PNG, WEBP, or HEIC file.`);
      return;
    }

    if (file.size > FIELD_FILE_UPLOAD_SIZE_LIMIT_MB * 1024 * 1024) {
      setError(t`File exceeds the ${FIELD_FILE_UPLOAD_SIZE_LIMIT_MB}MB limit.`);
      return;
    }

    setIsUploading(true);

    try {
      const { key, url } = await presignFileUpload({
        token,
        fieldId,
        fileName: file.name,
        contentType: file.type,
        fileSize: file.size,
      });

      const response = await fetch(url, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });

      if (!response.ok) {
        throw new Error(`Upload failed with status ${response.status}`);
      }

      call.end({ key, fileName: file.name, size: file.size, mimeType: file.type });
    } catch (err) {
      console.error(err);
      setError(t`Something went wrong while uploading your file. Please try again.`);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(value) => (!value ? call.end(null) : null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Upload a file</Trans>
          </DialogTitle>

          <DialogDescription className="mt-4">
            {t`PDF, JPEG, PNG, WEBP, or HEIC, up to ${FIELD_FILE_UPLOAD_SIZE_LIMIT_MB}MB.`}
          </DialogDescription>
        </DialogHeader>

        <fieldset className="flex h-full flex-col space-y-4" disabled={isUploading}>
          <input
            type="file"
            accept={ALLOWED_MIME_TYPES.join(',')}
            onChange={(event) => void onFileSelected(event.target.files?.[0])}
            data-testid="file-upload-field-input"
            className="w-full rounded-md border border-input text-sm file:mr-4 file:border-0 file:bg-muted file:px-4 file:py-2"
          />

          {isUploading && (
            <p className="text-muted-foreground text-sm">
              <Trans>Uploading…</Trans>
            </p>
          )}

          {error && <p className="text-destructive text-sm">{error}</p>}
        </fieldset>

        <DialogFooter>
          <Button type="button" variant="secondary" disabled={isUploading} onClick={() => call.end(null)}>
            <Trans>Cancel</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
