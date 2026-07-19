import { AppError } from '@documenso/lib/errors/app-error';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOCUMENT_CONVERSION_MIME_TYPE_DOC,
  DOCUMENT_CONVERSION_MIME_TYPE_DOCX,
} from '../../constants/document-conversion';
import { convertDocxToPdf } from './docx-to-pdf';

const { isCircuitOpenMock, recordFailureMock, recordSuccessMock, convertDocxToPdfViaGotenbergMock } = vi.hoisted(
  () => ({
    isCircuitOpenMock: vi.fn(),
    recordFailureMock: vi.fn(),
    recordSuccessMock: vi.fn(),
    convertDocxToPdfViaGotenbergMock: vi.fn(),
  }),
);

vi.mock('./circuit-breaker', () => ({
  isCircuitOpen: isCircuitOpenMock,
  recordFailure: recordFailureMock,
  recordSuccess: recordSuccessMock,
}));

vi.mock('./gotenberg', () => ({
  convertDocxToPdfViaGotenberg: convertDocxToPdfViaGotenbergMock,
}));

describe('convertDocxToPdf', () => {
  const originalUrl = process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_URL;

  beforeEach(() => {
    process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_URL = 'http://localhost:3005';
    isCircuitOpenMock.mockReset().mockReturnValue(false);
    recordFailureMock.mockReset();
    recordSuccessMock.mockReset();
    convertDocxToPdfViaGotenbergMock.mockReset().mockResolvedValue(Buffer.from('converted-pdf'));
  });

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_URL;
    } else {
      process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_URL = originalUrl;
    }
  });

  it('throws CONVERSION_SERVICE_UNAVAILABLE without calling Gotenberg when the feature is disabled', async () => {
    delete process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_URL;

    await expect(convertDocxToPdf({ buffer: Buffer.from('x'), filename: 'a.docx' })).rejects.toMatchObject({
      code: 'CONVERSION_SERVICE_UNAVAILABLE',
    });
    expect(convertDocxToPdfViaGotenbergMock).not.toHaveBeenCalled();
  });

  it('throws CONVERSION_SERVICE_UNAVAILABLE without calling Gotenberg when the circuit is open', async () => {
    isCircuitOpenMock.mockReturnValue(true);

    await expect(convertDocxToPdf({ buffer: Buffer.from('x'), filename: 'a.docx' })).rejects.toMatchObject({
      code: 'CONVERSION_SERVICE_UNAVAILABLE',
    });
    expect(convertDocxToPdfViaGotenbergMock).not.toHaveBeenCalled();
  });

  it('defaults to the DOCX mime type and logs it when none is passed (preserves existing behavior)', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };

    const result = await convertDocxToPdf({ buffer: Buffer.from('x'), filename: 'agreement.docx' }, logger as never);

    expect(result.toString()).toBe('converted-pdf');
    expect(convertDocxToPdfViaGotenbergMock).toHaveBeenCalledWith({
      buffer: Buffer.from('x'),
      filename: 'agreement.docx',
      mimeType: DOCUMENT_CONVERSION_MIME_TYPE_DOCX,
    });
    expect(recordSuccessMock).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMimeType: DOCUMENT_CONVERSION_MIME_TYPE_DOCX, filename: 'agreement.docx' }),
    );
  });

  it('threads a legacy .doc mime type through to Gotenberg and the success log (the historical bug this fixes)', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };

    await convertDocxToPdf(
      { buffer: Buffer.from('x'), filename: 'agreement.doc', mimeType: DOCUMENT_CONVERSION_MIME_TYPE_DOC },
      logger as never,
    );

    expect(convertDocxToPdfViaGotenbergMock).toHaveBeenCalledWith({
      buffer: Buffer.from('x'),
      filename: 'agreement.doc',
      mimeType: DOCUMENT_CONVERSION_MIME_TYPE_DOC,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMimeType: DOCUMENT_CONVERSION_MIME_TYPE_DOC, filename: 'agreement.doc' }),
    );
  });

  it('records failure and logs the real mime type (not the DOCX default) when Gotenberg rejects a .doc conversion', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };

    convertDocxToPdfViaGotenbergMock.mockRejectedValue(
      new AppError('CONVERSION_FAILED', { message: 'boom', statusCode: 400 }),
    );

    await expect(
      convertDocxToPdf(
        { buffer: Buffer.from('x'), filename: 'agreement.doc', mimeType: DOCUMENT_CONVERSION_MIME_TYPE_DOC },
        logger as never,
      ),
    ).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });

    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMimeType: DOCUMENT_CONVERSION_MIME_TYPE_DOC,
        errorCode: 'CONVERSION_FAILED',
        failed: true,
      }),
    );
  });
});
