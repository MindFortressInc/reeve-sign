import { describe, expect, it } from 'vitest';

import {
  detectFieldFileUploadMimeType,
  FIELD_FILE_UPLOAD_MAX_FTYP_BYTES,
  FIELD_FILE_UPLOAD_SIGNATURE_BYTES,
  getFtypBoxReadLength,
} from './detect-field-file-upload-mime-type';

const ascii = (value: string) => Array.from(value, (char) => char.charCodeAt(0));

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === 'string' ? ascii(part) : part)));

const isoBmff = (brand: string, ...compatibleBrands: string[]) =>
  bytes(
    [0x00, 0x00, 0x00, 16 + 4 * compatibleBrands.length],
    'ftyp',
    brand,
    [0x00, 0x00, 0x00, 0x00],
    ...compatibleBrands,
  );

describe('detectFieldFileUploadMimeType', () => {
  it.each([
    ['application/pdf', bytes('%PDF-1.7\n%\xe2\xe3')],
    ['image/jpeg', bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF')],
    ['image/png', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d], 'IHDR')],
    ['image/webp', bytes('RIFF', [0x24, 0x00, 0x00, 0x00], 'WEBPVP8 ')],
    ['image/heic', isoBmff('heic', 'mif1', 'heic')],
    ['image/heic', isoBmff('heix', 'mif1', 'heix')],
    ['image/heic', isoBmff('mif1', 'mif1', 'miaf', 'heic')],
  ])('detects %s from its file signature', (expected, input) => {
    expect(detectFieldFileUploadMimeType(input)).toBe(expected);
  });

  it.each([
    ['HTML with a script', bytes('<html><script>alert(1)</script>')],
    ['a Windows executable', bytes('MZ', [0x90, 0x00, 0x03, 0x00, 0x00, 0x00])],
    ['a ZIP archive', bytes('PK', [0x03, 0x04, 0x14, 0x00])],
    ['an AVIF image (HEIF container, non-HEIC brand)', isoBmff('avif')],
    ['an MP4 video (ISO-BMFF, non-HEIC brand)', isoBmff('isom')],
    ['a generic HEIF image with no HEIC compatible brand', isoBmff('mif1')],
    ['a bare heic major brand with no compatible brands', isoBmff('heic')],
    ['an AVIF image written with the generic mif1 major brand', isoBmff('mif1', 'mif1', 'miaf', 'avif')],
    ['a HEIF image sequence (msf1)', isoBmff('msf1', 'msf1', 'hevc')],
    ['a HEVC image sequence (hevc)', isoBmff('hevc', 'msf1', 'hevc')],
    [
      'a HEIC brand past the ftyp box end',
      bytes([0x00, 0x00, 0x00, 0x10], 'ftypmif1', [0x00, 0x00, 0x00, 0x00], 'heic'),
    ],
    ['a RIFF container that is not WEBP (WAV)', bytes('RIFF', [0x24, 0x00, 0x00, 0x00], 'WAVEfmt ')],
    ['a PDF header that does not start at byte 0 (polyglot)', bytes('<html>%PDF-1.7')],
    ['a truncated PNG signature', bytes([0x89, 0x50, 0x4e, 0x47])],
    ['an empty object', new Uint8Array()],
  ])('returns null for %s', (_label, input) => {
    expect(detectFieldFileUploadMimeType(input)).toBeNull();
  });

  it('reads a mif1 compatible-brand list within FIELD_FILE_UPLOAD_SIGNATURE_BYTES', () => {
    const iphoneLike = isoBmff('mif1', 'mif1', 'MiHE', 'MiPr', 'miaf', 'MiHB', 'heic');

    expect(detectFieldFileUploadMimeType(iphoneLike.subarray(0, FIELD_FILE_UPLOAD_SIGNATURE_BYTES))).toBe('image/heic');
  });

  it('finds a HEIC brand past FIELD_FILE_UPLOAD_SIGNATURE_BYTES once the whole ftyp box is read', () => {
    const longList = isoBmff('mif1', ...Array<string>(12).fill('miaf'), 'heic');
    const ftypLength = getFtypBoxReadLength(longList.subarray(0, FIELD_FILE_UPLOAD_SIGNATURE_BYTES));

    expect(ftypLength).toBe(longList.length);
    expect(detectFieldFileUploadMimeType(longList.subarray(0, FIELD_FILE_UPLOAD_SIGNATURE_BYTES))).toBeNull();
    expect(detectFieldFileUploadMimeType(longList.subarray(0, ftypLength))).toBe('image/heic');
  });

  it('bounds the ftyp re-read and ignores non-ftyp prefixes', () => {
    expect(getFtypBoxReadLength(bytes([0x7f, 0xff, 0xff, 0xff], 'ftypmif1'))).toBe(FIELD_FILE_UPLOAD_MAX_FTYP_BYTES);
    expect(getFtypBoxReadLength(bytes('%PDF-1.7\n%'))).toBe(0);
  });

  it('only ever needs the first FIELD_FILE_UPLOAD_SIGNATURE_BYTES bytes', () => {
    const webp = bytes('RIFF', [0x24, 0x00, 0x00, 0x00], 'WEBPVP8 ', [0x01, 0x02, 0x03, 0x04]);

    expect(detectFieldFileUploadMimeType(webp.subarray(0, FIELD_FILE_UPLOAD_SIGNATURE_BYTES))).toBe('image/webp');
  });
});
