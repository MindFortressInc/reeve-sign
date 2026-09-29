import { AppError } from '@documenso/lib/errors/app-error';
import { afterEach, describe, expect, it, vi } from 'vitest';

const headS3File = vi.fn();
const copyS3File = vi.fn();
const deleteS3File = vi.fn();
const readS3FilePrefix = vi.fn();

vi.mock('@documenso/lib/universal/upload/server-actions', () => ({
  headS3File: (...args: unknown[]) => headS3File(...args),
  copyS3File: (...args: unknown[]) => copyS3File(...args),
  deleteS3File: (...args: unknown[]) => deleteS3File(...args),
  readS3FilePrefix: (...args: unknown[]) => readS3FilePrefix(...args),
  buildFinalizedFieldFileUploadKey: ({
    envelopeId,
    fieldId,
    fileName,
  }: {
    envelopeId: string;
    fieldId: number;
    fileName: string;
  }) => `field-uploads/${envelopeId}/${fieldId}/finalrand12/${fileName}`,
}));

const { finalizeFieldFileUpload } = await import('./finalize-field-file-upload');

const baseOptions = {
  tmpKey: 'field-uploads-tmp/env_abc/42/tmprand123/license.pdf',
  fileName: 'license.pdf',
  envelopeId: 'env_abc',
  fieldId: 42,
  claimedSize: 1024,
  claimedMimeType: 'application/pdf',
};

const FINAL_KEY = 'field-uploads/env_abc/42/finalrand12/license.pdf';

const PDF_PREFIX = new TextEncoder().encode('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n');
const HTML_PREFIX = new TextEncoder().encode('<html><script>alert(1)</script></html>');
const JPEG_PREFIX = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

afterEach(() => {
  vi.resetAllMocks();
});

describe('finalizeFieldFileUpload', () => {
  it('copies the tmp object to a final key and returns server-verified customText', async () => {
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'application/pdf' }); // tmp HEAD
    copyS3File.mockResolvedValueOnce(undefined);
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'application/pdf' }); // final HEAD
    readS3FilePrefix.mockResolvedValueOnce(PDF_PREFIX);
    deleteS3File.mockResolvedValueOnce(undefined);

    const customText = await finalizeFieldFileUpload(baseOptions);

    expect(copyS3File).toHaveBeenCalledWith(baseOptions.tmpKey, FINAL_KEY);
    // Sniffs the FINAL (client-unwritable) key, never the replayable tmp key.
    expect(readS3FilePrefix).toHaveBeenCalledWith(FINAL_KEY, expect.any(Number));
    expect(deleteS3File).toHaveBeenCalledWith(baseOptions.tmpKey);
    expect(JSON.parse(customText)).toEqual({
      key: 'field-uploads/env_abc/42/finalrand12/license.pdf',
      fileName: 'license.pdf',
      size: 1024,
      mimeType: 'application/pdf',
    });
  });

  it('throws when the tmp object does not exist (never uploaded / already replayed away)', async () => {
    headS3File.mockResolvedValueOnce({ exists: false, size: null, contentType: null });

    await expect(finalizeFieldFileUpload(baseOptions)).rejects.toThrow(AppError);
    expect(copyS3File).not.toHaveBeenCalled();
  });

  it('rejects when the client-claimed size does not match the actual stored size', async () => {
    headS3File.mockResolvedValueOnce({ exists: true, size: 999, contentType: 'application/pdf' });
    deleteS3File.mockResolvedValueOnce(undefined);

    await expect(finalizeFieldFileUpload({ ...baseOptions, claimedSize: 1024 })).rejects.toThrow(AppError);
    expect(copyS3File).not.toHaveBeenCalled();
    // The tmp object was uploaded but rejected — it must not be left behind.
    expect(deleteS3File).toHaveBeenCalledWith(baseOptions.tmpKey);
  });

  it('rejects a zero-byte object (aborted/empty upload) even if the client still claims its original size', async () => {
    // e.g. the PUT was aborted mid-transfer leaving an empty object, but the
    // client's sign call still carries the size it originally set out to
    // upload — this must not slip through as a "mismatch happens to not
    // apply" edge case.
    headS3File.mockResolvedValueOnce({ exists: true, size: 0, contentType: 'application/pdf' });
    deleteS3File.mockResolvedValueOnce(undefined);

    await expect(
      finalizeFieldFileUpload({ ...baseOptions, claimedSize: 0, claimedMimeType: 'application/pdf' }),
    ).rejects.toThrow(AppError);
    expect(copyS3File).not.toHaveBeenCalled();
    expect(deleteS3File).toHaveBeenCalledWith(baseOptions.tmpKey);
  });

  it('rejects when the client-claimed mimeType does not match the actual stored content-type', async () => {
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'application/x-msdownload' });
    deleteS3File.mockResolvedValueOnce(undefined);

    await expect(finalizeFieldFileUpload({ ...baseOptions, claimedMimeType: 'application/pdf' })).rejects.toThrow(
      AppError,
    );
    expect(copyS3File).not.toHaveBeenCalled();
    expect(deleteS3File).toHaveBeenCalledWith(baseOptions.tmpKey);
  });

  it('rejects based on actual stored content-type even when the client never lied (disallowed type slipped past presign)', async () => {
    headS3File.mockResolvedValueOnce({
      exists: true,
      size: 1024,
      contentType: 'application/x-msdownload',
    });
    deleteS3File.mockResolvedValueOnce(undefined);

    await expect(
      finalizeFieldFileUpload({
        ...baseOptions,
        claimedMimeType: 'application/x-msdownload',
      }),
    ).rejects.toThrow(AppError);
    expect(copyS3File).not.toHaveBeenCalled();
    expect(deleteS3File).toHaveBeenCalledWith(baseOptions.tmpKey);
  });

  it('rejects based on actual stored size even when the client never lied (oversized object slipped past presign)', async () => {
    const actualSize = 16 * 1024 * 1024;

    headS3File.mockResolvedValueOnce({ exists: true, size: actualSize, contentType: 'application/pdf' });
    deleteS3File.mockResolvedValueOnce(undefined);

    await expect(finalizeFieldFileUpload({ ...baseOptions, claimedSize: actualSize })).rejects.toThrow(AppError);
    expect(copyS3File).not.toHaveBeenCalled();
    expect(deleteS3File).toHaveBeenCalledWith(baseOptions.tmpKey);
  });

  it('re-validates the FINAL object after copy and rejects if it is missing (avoids trusting the copy blindly), and cleans up both the tmp AND the orphaned final object', async () => {
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'application/pdf' }); // tmp HEAD
    copyS3File.mockResolvedValueOnce(undefined);
    headS3File.mockResolvedValueOnce({ exists: false, size: null, contentType: null }); // final HEAD fails
    deleteS3File.mockResolvedValue(undefined);

    await expect(finalizeFieldFileUpload(baseOptions)).rejects.toThrow(AppError);
    expect(deleteS3File).toHaveBeenCalledWith(baseOptions.tmpKey);
    expect(deleteS3File).toHaveBeenCalledWith('field-uploads/env_abc/42/finalrand12/license.pdf');
  });

  it('rejects if the final object HEAD reports different metadata than the tmp object (race/corruption guard), and cleans up both the tmp AND the orphaned final object', async () => {
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'application/pdf' }); // tmp HEAD
    copyS3File.mockResolvedValueOnce(undefined);
    headS3File.mockResolvedValueOnce({ exists: true, size: 999, contentType: 'application/pdf' }); // final HEAD mismatched
    deleteS3File.mockResolvedValue(undefined);

    await expect(finalizeFieldFileUpload(baseOptions)).rejects.toThrow(AppError);
    expect(deleteS3File).toHaveBeenCalledWith(baseOptions.tmpKey);
    expect(deleteS3File).toHaveBeenCalledWith('field-uploads/env_abc/42/finalrand12/license.pdf');
  });

  it('does not fail finalize when best-effort tmp cleanup fails', async () => {
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'application/pdf' });
    copyS3File.mockResolvedValueOnce(undefined);
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'application/pdf' });
    readS3FilePrefix.mockResolvedValueOnce(PDF_PREFIX);
    deleteS3File.mockRejectedValueOnce(new Error('boom'));

    await expect(finalizeFieldFileUpload(baseOptions)).resolves.toBeTypeOf('string');
  });

  it('does not fail rethrow when best-effort cleanup of the orphaned final object fails', async () => {
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'application/pdf' }); // tmp HEAD
    copyS3File.mockResolvedValueOnce(undefined);
    headS3File.mockResolvedValueOnce({ exists: false, size: null, contentType: null }); // final HEAD fails
    deleteS3File.mockResolvedValueOnce(undefined); // tmp delete succeeds
    deleteS3File.mockRejectedValueOnce(new Error('boom')); // final delete fails

    await expect(finalizeFieldFileUpload(baseOptions)).rejects.toThrow(AppError);
  });

  it('rejects an upload whose real bytes are not the declared type (HTML declared as application/pdf at PUT and sign time), and cleans up both keys', async () => {
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'application/pdf' }); // tmp HEAD
    copyS3File.mockResolvedValueOnce(undefined);
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'application/pdf' }); // final HEAD
    readS3FilePrefix.mockResolvedValueOnce(HTML_PREFIX);
    deleteS3File.mockResolvedValue(undefined);

    await expect(finalizeFieldFileUpload(baseOptions)).rejects.toThrow(
      'Uploaded file content does not match its declared type',
    );
    expect(deleteS3File).toHaveBeenCalledWith(baseOptions.tmpKey);
    expect(deleteS3File).toHaveBeenCalledWith(FINAL_KEY);
  });

  it('rejects an allowlisted type mislabelled as a different allowlisted type (JPEG bytes declared as image/png)', async () => {
    const pngOptions = { ...baseOptions, fileName: 'photo.png', claimedMimeType: 'image/png' };

    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'image/png' }); // tmp HEAD
    copyS3File.mockResolvedValueOnce(undefined);
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'image/png' }); // final HEAD
    readS3FilePrefix.mockResolvedValueOnce(JPEG_PREFIX);
    deleteS3File.mockResolvedValue(undefined);

    await expect(finalizeFieldFileUpload(pngOptions)).rejects.toThrow(AppError);
    expect(deleteS3File).toHaveBeenCalledWith('field-uploads/env_abc/42/finalrand12/photo.png');
  });

  it('re-reads a HEIC ftyp box longer than the first read and accepts a late HEIC brand', async () => {
    const heicOptions = { ...baseOptions, fileName: 'photo.heic', claimedMimeType: 'image/heic' };
    const brands = ['mif1', ...Array<string>(12).fill('miaf'), 'heic'];
    const ftyp = new Uint8Array(16 + 4 * brands.length);
    ftyp.set([0x00, 0x00, 0x00, ftyp.length]);
    ftyp.set(new TextEncoder().encode(`ftypmif1\0\0\0\0${brands.join('')}`), 4);

    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'image/heic' }); // tmp HEAD
    copyS3File.mockResolvedValueOnce(undefined);
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'image/heic' }); // final HEAD
    readS3FilePrefix.mockImplementation(async (_key: string, length: number) => ftyp.subarray(0, length));
    deleteS3File.mockResolvedValue(undefined);

    await expect(finalizeFieldFileUpload(heicOptions)).resolves.toBeTypeOf('string');
    expect(readS3FilePrefix).toHaveBeenLastCalledWith('field-uploads/env_abc/42/finalrand12/photo.heic', ftyp.length);
  });

  it('cleans up both keys and rethrows when the content read itself fails', async () => {
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'application/pdf' }); // tmp HEAD
    copyS3File.mockResolvedValueOnce(undefined);
    headS3File.mockResolvedValueOnce({ exists: true, size: 1024, contentType: 'application/pdf' }); // final HEAD
    readS3FilePrefix.mockRejectedValueOnce(new Error('S3 GetObject failed'));
    deleteS3File.mockResolvedValue(undefined);

    await expect(finalizeFieldFileUpload(baseOptions)).rejects.toThrow('S3 GetObject failed');
    expect(deleteS3File).toHaveBeenCalledWith(baseOptions.tmpKey);
    expect(deleteS3File).toHaveBeenCalledWith(FINAL_KEY);
  });
});
