import { PDF } from '@libpdf/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// DEV-18381: the PDF digital-signature reason is what a signer sees in the
// signature panel (Acrobat / Preview) of every sealed envelope. It used to be
// the hard-coded literal "Signed by Documenso". Signs a real PDF through
// `signPdf` with the local example cert (`./example/cert.p12`, the non-prod
// fallback, cwd = apps/remix) and reads the reason back out of the bytes.

const sealAndReadReason = async () => {
  vi.resetModules();

  const { signPdf } = await import('@documenso/signing');

  const pdf = PDF.create();
  pdf.addPage();

  const bytes = await signPdf({ pdf });
  const match = /\/Reason\s*\(([^)]*)\)/.exec(Buffer.from(bytes).toString('latin1'));

  return match?.[1];
};

describe('signPdf signature reason', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the Reeve.Sign reason and never names Documenso', async () => {
    vi.stubEnv('NEXT_PRIVATE_SIGNING_TRANSPORT', 'local');
    vi.stubEnv('NEXT_PUBLIC_SIGNING_REASON', undefined);

    const reason = await sealAndReadReason();

    expect(reason).toBe('Signed with Reeve.Sign');
    expect(reason).not.toMatch(/documenso/i);
  });

  it('uses NEXT_PUBLIC_SIGNING_REASON when set', async () => {
    vi.stubEnv('NEXT_PRIVATE_SIGNING_TRANSPORT', 'local');
    vi.stubEnv('NEXT_PUBLIC_SIGNING_REASON', 'Signed with Acme Sign');

    expect(await sealAndReadReason()).toBe('Signed with Acme Sign');
  });
});
