/**
 * Builds a `Content-Disposition: attachment` value safe to hand straight to
 * S3's `ResponseContentDisposition` (or any header sink): always forces a
 * download rather than an inline render — relevant even for allowlisted
 * types like PDF/images, which browsers otherwise happily render inline —
 * and neutralizes header-injection / quote-breakout attempts from a
 * user-supplied filename.
 */
export const buildSafeAttachmentContentDisposition = (fileName: string): string => {
  const withoutControlChars = Array.from(fileName)
    .filter((char) => char.charCodeAt(0) > 0x1f)
    .join('');

  const quoted = withoutControlChars.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const encoded = encodeURIComponent(withoutControlChars);

  return `attachment; filename="${quoted}"; filename*=UTF-8''${encoded}`;
};
