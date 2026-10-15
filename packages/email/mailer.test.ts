import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-15826: `mailer` is built once at module load, so each case stubs env,
// re-imports the module, and inspects the defaults handed to createTransport.

const { createTransportMock } = vi.hoisted(() => ({ createTransportMock: vi.fn() }));

vi.mock('nodemailer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nodemailer')>();

  createTransportMock.mockImplementation(actual.createTransport);

  return { ...actual, createTransport: createTransportMock };
});

const loadMailer = async () => {
  vi.resetModules();
  createTransportMock.mockClear();

  await import('./mailer');

  return createTransportMock.mock.calls[0];
};

describe('mailer SES configuration set', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PRIVATE_SMTP_HOST', 'email-smtp.us-east-1.amazonaws.com');
    vi.stubEnv('NEXT_PRIVATE_SMTP_APIKEY', 'test-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['smtp-auth', 'smtp-api'])('%s transport tags sends when the env var is set', async (transport) => {
    vi.stubEnv('NEXT_PRIVATE_SMTP_TRANSPORT', transport);
    vi.stubEnv('NEXT_PRIVATE_SES_CONFIGURATION_SET', 'reeve-sign');

    const [, defaults] = await loadMailer();

    expect(defaults).toEqual({ headers: { 'X-SES-CONFIGURATION-SET': 'reeve-sign' } });
  });

  it.each(['smtp-auth', 'smtp-api'])('%s transport passes no defaults when the env var is unset', async (transport) => {
    vi.stubEnv('NEXT_PRIVATE_SMTP_TRANSPORT', transport);
    vi.stubEnv('NEXT_PRIVATE_SES_CONFIGURATION_SET', undefined);

    const [, defaults] = await loadMailer();

    expect(defaults).toBeUndefined();
  });
});
