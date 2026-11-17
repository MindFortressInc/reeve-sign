import { PDF } from '@libpdf/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// DEV-18381: the PDF digital-signature reason is what a signer sees in the
// signature panel (Acrobat / Preview) of every sealed envelope. It used to be
// the hard-coded literal "Signed by Documenso". Signs a real PDF through
// `signPdf` with the local example cert (`./example/cert.p12`, the non-prod
// fallback, cwd = apps/remix) and reads the reason back out of the bytes.

const sealAndRead = async (key: 'Reason' | 'ContactInfo' = 'Reason') => {
  vi.resetModules();

  // Pin the signer to the example cert with no live timestamp server, whatever
  // the developer's shell exports.
  vi.stubEnv('NEXT_PRIVATE_SIGNING_TRANSPORT', 'local');
  vi.stubEnv('NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS', undefined);
  vi.stubEnv('NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH', undefined);
  vi.stubEnv('NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY', undefined);
  vi.stubEnv('NEXT_PRIVATE_SIGNING_PASSPHRASE', undefined);

  const { signPdf } = await import('@documenso/signing');

  const pdf = PDF.create();
  pdf.addPage();

  const bytes = await signPdf({ pdf });
  const match = new RegExp(`/${key}\\s*\\(([^)]*)\\)`).exec(Buffer.from(bytes).toString('latin1'));

  return match?.[1];
};

describe('signPdf signature reason', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the Reeve.Sign reason and never names Documenso', async () => {
    vi.stubEnv('NEXT_PUBLIC_SIGNING_REASON', undefined);

    const reason = await sealAndRead();

    expect(reason).toBe('Signed with Reeve.Sign');
    expect(reason).not.toMatch(/documenso/i);
  });

  it('uses NEXT_PUBLIC_SIGNING_REASON when set', async () => {
    vi.stubEnv('NEXT_PUBLIC_SIGNING_REASON', 'Signed with Acme Sign');

    expect(await sealAndRead()).toBe('Signed with Acme Sign');
  });

  it('treats a blank NEXT_PUBLIC_SIGNING_REASON as unset (NAME= copied from .env.example)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SIGNING_REASON', '   ');

    expect(await sealAndRead()).toBe('Signed with Reeve.Sign');
  });

  it('falls back to the webapp URL for a blank NEXT_PUBLIC_SIGNING_CONTACT_INFO', async () => {
    vi.stubEnv('NEXT_PUBLIC_WEBAPP_URL', 'https://sign.example.com');
    vi.stubEnv('NEXT_PUBLIC_SIGNING_CONTACT_INFO', '');

    expect(await sealAndRead('ContactInfo')).toBe('https://sign.example.com');
  });
});
