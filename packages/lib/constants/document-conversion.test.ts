import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DOCUMENT_CONVERSION_MIME_TYPE_DOC,
  DOCUMENT_CONVERSION_MIME_TYPE_DOCX,
  getAllowedUploadMimeTypes,
} from './document-conversion';

describe('getAllowedUploadMimeTypes', () => {
  const originalUrl = process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_URL;

  beforeEach(() => {
    delete process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_URL;
  });

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_URL;
    } else {
      process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_URL = originalUrl;
    }
  });

  it('only allows PDF when conversion is disabled', () => {
    const allowed = getAllowedUploadMimeTypes();

    expect(allowed).toEqual({
      'application/pdf': ['.pdf'],
    });
    expect(allowed[DOCUMENT_CONVERSION_MIME_TYPE_DOCX]).toBeUndefined();
    expect(allowed[DOCUMENT_CONVERSION_MIME_TYPE_DOC]).toBeUndefined();
  });

  it('allows PDF, DOCX, and legacy DOC when conversion is enabled', () => {
    process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_URL = 'http://localhost:3005';

    const allowed = getAllowedUploadMimeTypes();

    expect(allowed).toEqual({
      'application/pdf': ['.pdf'],
      [DOCUMENT_CONVERSION_MIME_TYPE_DOCX]: ['.docx'],
      [DOCUMENT_CONVERSION_MIME_TYPE_DOC]: ['.doc'],
    });
  });

  it('exposes the legacy Word mime type constant', () => {
    expect(DOCUMENT_CONVERSION_MIME_TYPE_DOC).toBe('application/msword');
  });
});
