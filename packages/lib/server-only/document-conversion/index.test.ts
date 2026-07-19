import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOCUMENT_CONVERSION_MIME_TYPE_DOC,
  DOCUMENT_CONVERSION_MIME_TYPE_DOCX,
} from '../../constants/document-conversion';
import { convertToPdf } from './index';

const { convertDocxToPdfMock } = vi.hoisted(() => ({
  convertDocxToPdfMock: vi.fn(),
}));

vi.mock('./docx-to-pdf', () => ({
  convertDocxToPdf: convertDocxToPdfMock,
}));

const makeFile = (type: string, name: string, bytes = 'file-bytes') => ({
  name,
  type,
  arrayBuffer: async () => new TextEncoder().encode(bytes).buffer,
});

describe('convertToPdf', () => {
  beforeEach(() => {
    convertDocxToPdfMock.mockReset();
    convertDocxToPdfMock.mockResolvedValue(Buffer.from('converted-pdf'));
  });

  it('returns the raw bytes unchanged for a PDF file (no conversion, no network call)', async () => {
    const file = makeFile('application/pdf', 'contract.pdf', '%PDF-1.4 ...');

    const result = await convertToPdf(file);

    expect(result.toString()).toBe('%PDF-1.4 ...');
    expect(convertDocxToPdfMock).not.toHaveBeenCalled();
  });

  it('dispatches a DOCX file to the converter', async () => {
    const file = makeFile(DOCUMENT_CONVERSION_MIME_TYPE_DOCX, 'agreement.docx');

    const result = await convertToPdf(file);

    expect(result.toString()).toBe('converted-pdf');
    expect(convertDocxToPdfMock).toHaveBeenCalledTimes(1);
    expect(convertDocxToPdfMock).toHaveBeenCalledWith(
      {
        buffer: Buffer.from('file-bytes'),
        filename: 'agreement.docx',
        mimeType: DOCUMENT_CONVERSION_MIME_TYPE_DOCX,
      },
      undefined,
    );
  });

  it('dispatches a legacy .doc (application/msword) file to the converter', async () => {
    const file = makeFile(DOCUMENT_CONVERSION_MIME_TYPE_DOC, 'agreement.doc');

    const result = await convertToPdf(file);

    expect(result.toString()).toBe('converted-pdf');
    expect(convertDocxToPdfMock).toHaveBeenCalledTimes(1);
    expect(convertDocxToPdfMock).toHaveBeenCalledWith(
      {
        buffer: Buffer.from('file-bytes'),
        filename: 'agreement.doc',
        mimeType: DOCUMENT_CONVERSION_MIME_TYPE_DOC,
      },
      undefined,
    );
  });

  it('throws UNSUPPORTED_FILE_TYPE for anything else', async () => {
    const file = makeFile('image/png', 'photo.png');

    await expect(convertToPdf(file)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE_TYPE',
    });
    expect(convertDocxToPdfMock).not.toHaveBeenCalled();
  });
});
