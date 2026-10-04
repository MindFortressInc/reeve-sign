import { putPdfFile } from '@documenso/lib/universal/upload/put-file';

/**
 * Uploads a PDF from the embedded V1 authoring pages. They run in a
 * third-party iframe with no session cookie, so `/api/files/upload-pdf`
 * authorizes them by the embedding presign token the authoring layout
 * verified from `?token=` (DEV-12801).
 */
export const uploadEmbedAuthoringPdf = async (
  file: Parameters<typeof putPdfFile>[0],
  search: string = window.location.search,
) => {
  const presignToken = new URLSearchParams(search).get('token') ?? undefined;

  return await putPdfFile(file, { presignToken });
};
