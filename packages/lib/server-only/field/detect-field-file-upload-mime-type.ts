import type { TFieldFileUploadAllowedMimeType } from '@documenso/lib/types/field-file-upload';

/**
 * How many leading bytes `detectFieldFileUploadMimeType` needs. The longest
 * signature below ends at byte 12 (WEBP's `RIFF....WEBP`, the HEIC `ftyp`
 * major brand), so finalize only ever range-reads this much of an object.
 */
export const FIELD_FILE_UPLOAD_SIGNATURE_BYTES = 16;

/**
 * ISO-BMFF `ftyp` major brands for HEIC/HEIF still images. `mif1`/`msf1` are
 * the generic HEIF image/sequence brands some encoders (e.g. Samsung) write
 * as the major brand. Deliberately excludes `avif` and video brands
 * (`isom`, `mp41`, `qt  `, ...), which share the same container.
 */
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

const matchesAt = (bytes: Uint8Array, offset: number, signature: readonly number[]) =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);

const asciiAt = (bytes: Uint8Array, offset: number, length: number) =>
  bytes.length >= offset + length ? String.fromCharCode(...bytes.subarray(offset, offset + length)) : null;

/**
 * Identifies which allowlisted FILE_UPLOAD type a file really is from its
 * leading bytes (magic numbers), or `null` if it is none of them.
 *
 * Every signature must start at byte 0 — including PDF, even though some
 * readers tolerate junk before `%PDF-`. Allowing an offset would accept
 * polyglots such as `<html>...%PDF-`, which content sniffers treat as HTML.
 */
export const detectFieldFileUploadMimeType = (bytes: Uint8Array): TFieldFileUploadAllowedMimeType | null => {
  if (asciiAt(bytes, 0, 5) === '%PDF-') {
    return 'application/pdf';
  }

  if (matchesAt(bytes, 0, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }

  if (matchesAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }

  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') {
    return 'image/webp';
  }

  const brand = asciiAt(bytes, 4, 4) === 'ftyp' ? asciiAt(bytes, 8, 4) : null;

  if (brand && HEIC_BRANDS.has(brand)) {
    return 'image/heic';
  }

  return null;
};
