import type { TFieldFileUploadAllowedMimeType } from '@documenso/lib/types/field-file-upload';

/**
 * How many leading bytes `detectFieldFileUploadMimeType` needs. The fixed
 * signatures all end by byte 12 (WEBP's `RIFF....WEBP`, the HEIC `ftyp`
 * major brand); the extra room covers the `ftyp` compatible-brand list a
 * generic-HEIF (`mif1`) file must be checked against. Finalize only ever
 * range-reads this much of an object.
 */
export const FIELD_FILE_UPLOAD_SIGNATURE_BYTES = 64;

/**
 * ISO-BMFF `ftyp` brands that identify a HEIC still image. Image-sequence
 * brands (`msf1`, `hevc`, `hevx`) are `image/heic-sequence`, not
 * `image/heic`, and are deliberately excluded along with `avif` and video
 * brands (`isom`, `mp41`, `qt  `, ...), which share the same container.
 */
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis']);

/**
 * The generic HEIF still-image brand some encoders (e.g. Samsung) write as
 * the major brand. On its own it only says "HEIF" — AVIF uses it too — so it
 * counts as HEIC only when a HEIC brand is also in the compatible brands.
 */
const GENERIC_HEIF_BRAND = 'mif1';

const matchesAt = (bytes: Uint8Array, offset: number, signature: readonly number[]) =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);

const asciiAt = (bytes: Uint8Array, offset: number, length: number) =>
  bytes.length >= offset + length ? String.fromCharCode(...bytes.subarray(offset, offset + length)) : null;

/**
 * Whether the `ftyp` box's compatible-brand list (4-byte brands from byte 16
 * to the box's declared size) names a HEIC brand. Only brands fully inside
 * both the box and the bytes read are considered.
 */
const hasHeicCompatibleBrand = (bytes: Uint8Array) => {
  if (bytes.length < 8) {
    return false;
  }

  const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(boxSize, bytes.length);

  for (let offset = 16; offset + 4 <= end; offset += 4) {
    const brand = asciiAt(bytes, offset, 4);

    if (brand && HEIC_BRANDS.has(brand)) {
      return true;
    }
  }

  return false;
};

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

  if (asciiAt(bytes, 4, 4) === 'ftyp') {
    const majorBrand = asciiAt(bytes, 8, 4);

    if (majorBrand && HEIC_BRANDS.has(majorBrand)) {
      return 'image/heic';
    }

    if (majorBrand === GENERIC_HEIF_BRAND && hasHeicCompatibleBrand(bytes)) {
      return 'image/heic';
    }
  }

  return null;
};
