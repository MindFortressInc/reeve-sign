import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { TFieldFileUpload } from '@documenso/lib/types/field';
import type { TSignEnvelopeFieldValue } from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';
import { FieldType } from '@prisma/client';

import { SignFieldFileUploadDialog } from '~/components/dialogs/sign-field-file-upload-dialog';

type HandleFileUploadFieldClickOptions = {
  field: TFieldFileUpload;
  token: string;
};

export const handleFileUploadFieldClick = async (
  options: HandleFileUploadFieldClickOptions,
): Promise<Extract<TSignEnvelopeFieldValue, { type: typeof FieldType.FILE_UPLOAD }> | null> => {
  const { field, token } = options;

  if (field.type !== FieldType.FILE_UPLOAD) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Invalid field type',
    });
  }

  if (field.inserted) {
    return {
      type: FieldType.FILE_UPLOAD,
      value: null,
    };
  }

  const uploadResult = await SignFieldFileUploadDialog.call({ token, fieldId: field.id });

  if (!uploadResult) {
    return null;
  }

  return {
    type: FieldType.FILE_UPLOAD,
    value: uploadResult,
  };
};
