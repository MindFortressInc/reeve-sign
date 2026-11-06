import { AppError } from '@documenso/lib/errors/app-error';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_CONVERSION_MIME_TYPE_DOC,
  DOCUMENT_CONVERSION_MIME_TYPE_DOCX,
} from '../../constants/document-conversion';
import { convertDocxToPdfViaGotenberg } from './gotenberg';

// Assigning `undefined` back to `process.env.KEY` stringifies to the literal
// "undefined" rather than deleting the key, so an absent original must be
// restored via `delete` instead.
const restoreEnv = (key: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

describe('convertDocxToPdfViaGotenberg', () => {
  const originalUrl = process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_URL;
  const originalUsername = process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_USERNAME;
  const originalPassword = process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_PASSWORD;

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_URL = 'http://localhost:3005';
    delete process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_USERNAME;
    delete process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_PASSWORD;

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 converted').buffer,
    });

    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    restoreEnv('NEXT_PRIVATE_DOCUMENT_CONVERSION_URL', originalUrl);
    restoreEnv('NEXT_PRIVATE_DOCUMENT_CONVERSION_USERNAME', originalUsername);
    restoreEnv('NEXT_PRIVATE_DOCUMENT_CONVERSION_PASSWORD', originalPassword);
  });

  const getSentFile = () => {
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = requestInit.body as FormData;

    return formData.get('files') as File;
  };

  it('defaults to the DOCX filename and mime type when none is provided (preserves existing behavior)', async () => {
    await convertDocxToPdfViaGotenberg({
      buffer: Buffer.from('docx-bytes'),
      filename: 'agreement.docx',
    });

    const sentFile = getSentFile();

    expect(sentFile.name).toBe('agreement.docx');
    expect(sentFile.type).toBe(DOCUMENT_CONVERSION_MIME_TYPE_DOCX);
  });

  it('forwards the real filename and mime type for a legacy .doc file', async () => {
    await convertDocxToPdfViaGotenberg({
      buffer: Buffer.from('doc-bytes'),
      filename: 'agreement.doc',
      mimeType: DOCUMENT_CONVERSION_MIME_TYPE_DOC,
    });

    const sentFile = getSentFile();

    expect(sentFile.name).toBe('agreement.doc');
    expect(sentFile.type).toBe(DOCUMENT_CONVERSION_MIME_TYPE_DOC);
  });

  it('forwards an explicit mime type for a DOCX file too (no hardcoding once passed)', async () => {
    await convertDocxToPdfViaGotenberg({
      buffer: Buffer.from('docx-bytes'),
      filename: 'weird-name.tmp',
      mimeType: DOCUMENT_CONVERSION_MIME_TYPE_DOCX,
    });

    const sentFile = getSentFile();

    expect(sentFile.name).toBe('weird-name.tmp');
    expect(sentFile.type).toBe(DOCUMENT_CONVERSION_MIME_TYPE_DOCX);
  });

  it('still posts to the /forms/libreoffice/convert endpoint with exportFormFields=false', async () => {
    await convertDocxToPdfViaGotenberg({
      buffer: Buffer.from('docx-bytes'),
      filename: 'agreement.docx',
    });

    const [endpoint, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = requestInit.body as FormData;

    expect(endpoint).toBe('http://localhost:3005/forms/libreoffice/convert');
    expect(formData.get('exportFormFields')).toBe('false');
  });

  it('keeps the upstream response body out of the AppError on a non-2xx response (DEV-17833)', async () => {
    const marker = 'UPSTREAM_INTERNAL_MARKER_libreoffice-stacktrace';
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => `Internal error: ${marker}` });

    const err = await convertDocxToPdfViaGotenberg({
      buffer: Buffer.from('docx-bytes'),
      filename: 'agreement.docx',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    const appError = err as AppError;
    expect(appError.code).toBe('CONVERSION_FAILED');
    expect(appError.statusCode).toBe(400);
    expect(appError.message).not.toContain(marker);
    expect(JSON.stringify(AppError.toJSON(appError))).not.toContain(marker);
  });

  it('keeps the raw transport error out of the AppError on a network failure (DEV-17833)', async () => {
    const marker = 'UPSTREAM_INTERNAL_MARKER_connect ECONNREFUSED 10.0.0.5:3000';
    fetchMock.mockRejectedValue(new TypeError(marker));

    const err = await convertDocxToPdfViaGotenberg({
      buffer: Buffer.from('docx-bytes'),
      filename: 'agreement.docx',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    const appError = err as AppError;
    expect(appError.code).toBe('CONVERSION_SERVICE_UNAVAILABLE');
    expect(appError.statusCode).toBe(503);
    expect(appError.message).not.toContain(marker);
    expect(JSON.stringify(AppError.toJSON(appError))).not.toContain(marker);
  });
});
