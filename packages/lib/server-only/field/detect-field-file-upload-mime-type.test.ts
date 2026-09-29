import { describe, expect, it } from 'vitest';

import { detectFieldFileUploadMimeType, FIELD_FILE_UPLOAD_SIGNATURE_BYTES } from './detect-field-file-upload-mime-type';

const ascii = (value: string) => Array.from(value, (char) => char.charCodeAt(0));

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === 'string' ? ascii(part) : part)));

const isoBmff = (brand: string) => bytes([0x00, 0x00, 0x00, 0x18], 'ftyp', brand, [0x00, 0x00, 0x00, 0x00]);

describe('detectFieldFileUploadMimeType', () => {
  it.each([
    ['application/pdf', bytes('%PDF-1.7\n%\xe2\xe3')],
    ['image/jpeg', bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF')],
    ['image/png', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d], 'IHDR')],
    ['image/webp', bytes('RIFF', [0x24, 0x00, 0x00, 0x00], 'WEBPVP8 ')],
    ['image/heic', isoBmff('heic')],
    ['image/heic', isoBmff('heix')],
    ['image/heic', isoBmff('mif1')],
  ])('detects %s from its file signature', (expected, input) => {
    expect(detectFieldFileUploadMimeType(input)).toBe(expected);
  });

  it.each([
    ['HTML with a script', bytes('<html><script>alert(1)</script>')],
    ['a Windows executable', bytes('MZ', [0x90, 0x00, 0x03, 0x00, 0x00, 0x00])],
    ['a ZIP archive', bytes('PK', [0x03, 0x04, 0x14, 0x00])],
    ['an AVIF image (HEIF container, non-HEIC brand)', isoBmff('avif')],
    ['an MP4 video (ISO-BMFF, non-HEIC brand)', isoBmff('isom')],
    ['a RIFF container that is not WEBP (WAV)', bytes('RIFF', [0x24, 0x00, 0x00, 0x00], 'WAVEfmt ')],
    ['a PDF header that does not start at byte 0 (polyglot)', bytes('<html>%PDF-1.7')],
    ['a truncated PNG signature', bytes([0x89, 0x50, 0x4e, 0x47])],
    ['an empty object', new Uint8Array()],
  ])('returns null for %s', (_label, input) => {
    expect(detectFieldFileUploadMimeType(input)).toBeNull();
  });

  it('only ever needs the first FIELD_FILE_UPLOAD_SIGNATURE_BYTES bytes', () => {
    const webp = bytes('RIFF', [0x24, 0x00, 0x00, 0x00], 'WEBPVP8 ', [0x01, 0x02, 0x03, 0x04]);

    expect(detectFieldFileUploadMimeType(webp.subarray(0, FIELD_FILE_UPLOAD_SIGNATURE_BYTES))).toBe('image/webp');
  });
});
