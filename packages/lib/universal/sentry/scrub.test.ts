import { describe, expect, it } from 'vitest';

import { buildSentryBeforeSend } from './scrub';

describe('buildSentryBeforeSend', () => {
  describe('headers', () => {
    it('redacts denylisted headers case-insensitively', () => {
      const beforeSend = buildSentryBeforeSend();

      const event = beforeSend({
        request: {
          headers: {
            Authorization: 'Bearer super-secret',
            Cookie: 'session=abc',
            'Set-Cookie': 'session=abc',
            'X-Api-Key': 'key-123',
            'X-Auth-Token': 'token-123',
            'User-Agent': 'test-agent',
          },
        },
      });

      expect(event.request?.headers).toEqual({
        Authorization: '[redacted]',
        Cookie: '[redacted]',
        'Set-Cookie': '[redacted]',
        'X-Api-Key': '[redacted]',
        'X-Auth-Token': '[redacted]',
        'User-Agent': 'test-agent',
      });
    });

    it('leaves non-sensitive headers untouched', () => {
      const beforeSend = buildSentryBeforeSend();

      const event = beforeSend({
        request: { headers: { 'Content-Type': 'application/json' } },
      });

      expect(event.request?.headers).toEqual({ 'Content-Type': 'application/json' });
    });
  });

  describe('request data/extra', () => {
    it('redacts sensitive keys in request.data', () => {
      const beforeSend = buildSentryBeforeSend();

      const event = beforeSend({
        request: {
          data: {
            email: 'user@example.com',
            password: 'hunter2',
            access_token: 'abc123',
            refresh_token: 'def456',
            apiKey: 'key-1',
            api_key: 'key-2',
            client_secret: 'shh',
            userId: '42',
          },
        },
      });

      expect(event.request?.data).toEqual({
        email: 'user@example.com',
        password: '[redacted]',
        access_token: '[redacted]',
        refresh_token: '[redacted]',
        apiKey: '[redacted]',
        api_key: '[redacted]',
        client_secret: '[redacted]',
        userId: '42',
      });
    });

    it('scrubs nested objects and arrays recursively', () => {
      const beforeSend = buildSentryBeforeSend();

      const event = beforeSend({
        request: {
          data: {
            user: { name: 'Matt', password: 'hunter2' },
            // `auth_token` (not bare `token`) to match the `.*_token$`
            // pattern -- same suffix-only convention as the Python
            // reference (reeve_monitor/sentry.py's _PII_KEY_PATTERNS).
            items: [{ auth_token: 'x' }, { safe: 'value' }],
          },
        },
      });

      expect(event.request?.data).toEqual({
        user: { name: 'Matt', password: '[redacted]' },
        items: [{ auth_token: '[redacted]' }, { safe: 'value' }],
      });
    });

    it('is case-insensitive on key patterns', () => {
      const beforeSend = buildSentryBeforeSend();

      const event = beforeSend({ request: { data: { PASSWORD: 'hunter2', Pwd: 'x' } } });

      expect(event.request?.data).toEqual({ PASSWORD: '[redacted]', Pwd: '[redacted]' });
    });
  });

  describe('extra and contexts', () => {
    it('scrubs top-level event.extra', () => {
      const beforeSend = buildSentryBeforeSend();

      const event = beforeSend({ extra: { secret_key: 'x', note: 'fine' } });

      expect(event.extra).toEqual({ secret_key: '[redacted]', note: 'fine' });
    });

    it('scrubs event.contexts', () => {
      const beforeSend = buildSentryBeforeSend();

      const event = beforeSend({ contexts: { session: { refresh_token: 'x' } } });

      expect(event.contexts).toEqual({ session: { refresh_token: '[redacted]' } });
    });
  });

  describe('extraPatterns', () => {
    it('redacts app-specific key patterns in addition to the shared denylist', () => {
      const beforeSend = buildSentryBeforeSend(['^ssn$', '.*_pin$']);

      const event = beforeSend({ request: { data: { ssn: '123-45-6789', card_pin: '1234', name: 'Matt' } } });

      expect(event.request?.data).toEqual({ ssn: '[redacted]', card_pin: '[redacted]', name: 'Matt' });
    });
  });

  describe('no-ops', () => {
    it('does not add a request key when the event has none', () => {
      const beforeSend = buildSentryBeforeSend();

      const event = beforeSend({ message: 'boom' });

      expect(event).toEqual({ message: 'boom' });
    });

    it('passes through an event with no PII untouched', () => {
      const beforeSend = buildSentryBeforeSend();

      const event = beforeSend({
        message: 'boom',
        request: { headers: { Accept: 'text/html' }, data: { page: 1 } },
        extra: { count: 5 },
      });

      expect(event).toEqual({
        message: 'boom',
        request: { headers: { Accept: 'text/html' }, data: { page: 1 } },
        extra: { count: 5 },
      });
    });
  });
});
