import { createTransport } from 'nodemailer';
import { describe, expect, it } from 'vitest';

import { getSesConfigurationSetDefaults, SES_CONFIGURATION_SET_HEADER } from './ses-configuration-set';

// DEV-15826: SES only routes bounce/complaint events for a send to an event
// destination when the send names a configuration set. reeve.bot has no
// default set, so every Sign send must carry the header itself.

const renderRawMessage = async (configurationSet: string | undefined, headers?: Record<string, string>) => {
  const defaults = getSesConfigurationSetDefaults(configurationSet);

  // The stream-transport overload types `defaults` as full stream options, so
  // restate `streamTransport` there; only `headers` matters at runtime.
  const transport = createTransport(
    { streamTransport: true, buffer: true },
    defaults && { streamTransport: true, ...defaults },
  );

  const info = await transport.sendMail({
    from: 'sigrequest@reeve.bot',
    to: 'nobody@example.com',
    subject: 'Please sign',
    text: 'body',
    headers,
  });

  if (!Buffer.isBuffer(info.message)) {
    throw new Error('expected a buffered message');
  }

  return info.message.toString('utf8');
};

describe('getSesConfigurationSetDefaults', () => {
  it('returns the configuration-set header when the value is set', () => {
    expect(getSesConfigurationSetDefaults('reeve-sign')).toEqual({
      headers: { [SES_CONFIGURATION_SET_HEADER]: 'reeve-sign' },
    });
  });

  it('trims surrounding whitespace from the value', () => {
    expect(getSesConfigurationSetDefaults('  reeve-sign\n')).toEqual({
      headers: { [SES_CONFIGURATION_SET_HEADER]: 'reeve-sign' },
    });
  });

  it.each([undefined, '', '   '])('returns no defaults when the value is %j', (value) => {
    expect(getSesConfigurationSetDefaults(value)).toBeUndefined();
  });
});

describe('nodemailer transport defaults', () => {
  it('stamps X-SES-CONFIGURATION-SET on every outbound message when set', async () => {
    const raw = await renderRawMessage('reeve-sign');

    expect(raw).toMatch(/^X-SES-CONFIGURATION-SET: reeve-sign\r?$/im);
  });

  it('keeps the header when a message supplies its own headers', async () => {
    const raw = await renderRawMessage('reeve-sign', { 'X-Other': 'kept' });

    expect(raw).toMatch(/^X-SES-CONFIGURATION-SET: reeve-sign\r?$/im);
    expect(raw).toMatch(/^X-Other: kept\r?$/im);
  });

  it.each([undefined, '', '   '])('sends no configuration-set header when the value is %j', async (value) => {
    const raw = await renderRawMessage(value);

    expect(raw).not.toMatch(/X-SES-CONFIGURATION-SET/i);
  });
});
