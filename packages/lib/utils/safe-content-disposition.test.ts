import { describe, expect, it } from 'vitest';

import { buildSafeAttachmentContentDisposition } from './safe-content-disposition';

describe('buildSafeAttachmentContentDisposition', () => {
  it('forces an attachment disposition (never inline)', () => {
    expect(buildSafeAttachmentContentDisposition('license.pdf')).toMatch(/^attachment;/);
  });

  it('quotes a normal filename verbatim', () => {
    expect(buildSafeAttachmentContentDisposition('license.pdf')).toContain('filename="license.pdf"');
  });

  it('escapes embedded quotes so they cannot close the quoted value early', () => {
    const result = buildSafeAttachmentContentDisposition('license".pdf');

    expect(result).toContain('filename="license\\".pdf"');
  });

  it('escapes embedded backslashes', () => {
    const result = buildSafeAttachmentContentDisposition('a\\b.pdf');

    expect(result).toContain('filename="a\\\\b.pdf"');
  });

  it('strips CR/LF and other control characters to prevent header injection', () => {
    const malicious = 'a.pdf"\r\nX-Injected: evil';

    const result = buildSafeAttachmentContentDisposition(malicious);

    expect(result).not.toContain('\r');
    expect(result).not.toContain('\n');
  });

  it('includes an RFC 5987 UTF-8 fallback for non-ASCII filenames', () => {
    const result = buildSafeAttachmentContentDisposition('pré-approval letter.pdf');

    expect(result).toContain("filename*=UTF-8''");
  });
});
