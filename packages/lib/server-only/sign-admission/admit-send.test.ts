import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors/app-error';
import { REEVE_PROVISIONED_ORGANISATION_URL_PREFIX } from '../reeve-admin/derive-organisation-url';
import { admitSignSend, SIGN_ADMISSION_PATH, SignAdmissionError } from './admit-send';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../utils/logger', () => ({ logger: loggerMock }));

const SECRET = 'test-shared-secret';
const BASE_URL = 'https://services.example.test';
const REEVE_ORG_URL = `${REEVE_PROVISIONED_ORGANISATION_URL_PREFIX}abc123`;

const SEND = {
  envelopeId: 'envelope_abc',
  legacyDocumentId: 42,
  organisationUrl: REEVE_ORG_URL,
  attempt: 'send',
};

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const ALLOW = { decision: 'allow', account: 'org_1', consumed: false, replay: true };

const expectRefusal = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );

  expect(err).toBeInstanceOf(SignAdmissionError);
  expect(err).toBeInstanceOf(AppError);

  return err as SignAdmissionError;
};

beforeEach(() => {
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('admitSignSend: fork-native organisations', () => {
  it('is exempt: no call, one structured log line, enforced=false', async () => {
    vi.stubEnv('REEVE_SIGN_ADMISSION_API_URL', BASE_URL);
    vi.stubEnv('REEVE_SHARED_HMAC_SECRET', SECRET);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await admitSignSend({ ...SEND, organisationUrl: 'personal-org-7' });

    expect(result).toEqual({ enforced: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'sign_admission_exempt', envelopeId: 'envelope_abc', attempt: 'send' }),
    );
  });

  it('is exempt even when admission is unconfigured (self-host / dev)', async () => {
    vi.stubEnv('REEVE_SIGN_ADMISSION_API_URL', '');
    vi.stubEnv('REEVE_SHARED_HMAC_SECRET', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(admitSignSend({ ...SEND, organisationUrl: 'acme' })).resolves.toEqual({ enforced: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('admitSignSend: Reeve-provisioned organisations, unconfigured', () => {
  it.each([
    ['no url', '', SECRET],
    ['no secret', BASE_URL, ''],
  ])('fails closed (%s): 503 SIGN_ADMISSION_UNAVAILABLE, never calls fetch', async (_label, url, secret) => {
    vi.stubEnv('REEVE_SIGN_ADMISSION_API_URL', url);
    vi.stubEnv('REEVE_SHARED_HMAC_SECRET', secret);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const err = await expectRefusal(admitSignSend(SEND));

    expect(err.code).toBe('SIGN_ADMISSION_UNAVAILABLE');
    expect(err.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('admitSignSend: Reeve-provisioned organisations, configured', () => {
  beforeEach(() => {
    vi.stubEnv('REEVE_SIGN_ADMISSION_API_URL', BASE_URL);
    vi.stubEnv('REEVE_SHARED_HMAC_SECRET', SECRET);
  });

  it('POSTs the signed contract body and returns the allow decision', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ALLOW));
    vi.stubGlobal('fetch', fetchMock);

    const result = await admitSignSend(SEND);

    expect(result).toEqual({ enforced: true, account: 'org_1', consumed: false, replay: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(`${BASE_URL}${SIGN_ADMISSION_PATH}`);
    expect(SIGN_ADMISSION_PATH).toBe('/api/sign/v1/internal/admission');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = init.body as string;

    expect(JSON.parse(body)).toEqual({
      door: 'fork',
      envelope_id: 'envelope_abc',
      document_id: '42',
      attempt: 'send',
    });

    const headers = init.headers as Record<string, string>;
    const timestamp = headers['X-Reeve-Timestamp'];
    const expected = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');

    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Reeve-Signature']).toBe(`sha256=${expected}`);
  });

  it('passes a resend attempt key through unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...ALLOW, consumed: true, replay: false }));
    vi.stubGlobal('fetch', fetchMock);

    await admitSignSend({ ...SEND, attempt: 'resend:7f0c' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(JSON.parse(init.body as string)).toMatchObject({ attempt: 'resend:7f0c' });
  });

  it('429 send_rate_limited: typed error with the server message, retry_after_seconds and Retry-After', async () => {
    const message =
      'Slow down: this Reeve.Sign account can send 1 document per minute. Nothing was sent; try again in 37 seconds.';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: { code: 'send_rate_limited', message, retryable: true, retry_after_seconds: 37 } },
            429,
            { 'Retry-After': '37' },
          ),
        ),
    );

    const err = await expectRefusal(admitSignSend(SEND));

    expect(err.code).toBe('SIGN_SEND_RATE_LIMITED');
    expect(err.statusCode).toBe(429);
    expect(err.message).toBe(message);
    expect(err.userMessage).toBe(message);
    expect(err.retryAfterSeconds).toBe(37);
    expect(err.headers).toEqual({ 'Retry-After': '37' });
  });

  it('429 without a body value falls back to the Retry-After header', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { code: 'send_rate_limited', message: 'slow' } }, 429, { 'Retry-After': '12' }),
        ),
    );

    const err = await expectRefusal(admitSignSend(SEND));

    expect(err.retryAfterSeconds).toBe(12);
    expect(err.headers).toEqual({ 'Retry-After': '12' });
  });

  it.each([
    'account_suspended',
    'tenant_suspended',
  ])('403 %s: SIGN_ACCOUNT_SUSPENDED with the server message', async (code) => {
    const message = 'This Reeve.Sign account is suspended pending review. Nothing was sent.';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { code, reason: 'admin', message, retryable: false } }, 403)),
    );

    const err = await expectRefusal(admitSignSend(SEND));

    expect(err.code).toBe('SIGN_ACCOUNT_SUSPENDED');
    expect(err.statusCode).toBe(403);
    expect(err.userMessage).toBe(message);
    expect(err.retryAfterSeconds).toBeUndefined();
    expect(err.headers).toBeUndefined();
  });

  it('422 account_unresolved: SIGN_ACCOUNT_UNRESOLVED (fail closed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: 'account_unresolved',
              message: 'no Reeve.Sign account resolves for this send',
              retryable: false,
            },
          },
          422,
        ),
      ),
    );

    const err = await expectRefusal(admitSignSend(SEND));

    expect(err.code).toBe('SIGN_ACCOUNT_UNRESOLVED');
    expect(err.statusCode).toBe(422);
    expect(err.userMessage).toBe('no Reeve.Sign account resolves for this send');
  });

  it.each([
    [
      '503 sign_admission_unavailable',
      () => jsonResponse({ error: { code: 'sign_admission_unavailable', retryable: true } }, 503),
    ],
    ['401 bad signature', () => jsonResponse({ detail: 'invalid signature' }, 401)],
    ['422 body validation (no error code)', () => jsonResponse({ detail: [{ loc: ['body', 'door'] }] }, 422)],
    ['500 html', () => new Response('<html>oops</html>', { status: 500 })],
    ['200 that is not an allow', () => jsonResponse({ decision: 'deny' })],
    ['200 with a non-JSON body', () => new Response('not json', { status: 200 })],
  ])('%s: SIGN_ADMISSION_UNAVAILABLE 503 with a fixed message (never echoes the body)', async (_label, make) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(make()));

    const err = await expectRefusal(admitSignSend(SEND));

    expect(err.code).toBe('SIGN_ADMISSION_UNAVAILABLE');
    expect(err.statusCode).toBe(503);
    expect(err.userMessage).toMatch(/nothing was sent/i);
    expect(err.message).not.toMatch(/oops|invalid signature|detail/);
  });

  it('network error: SIGN_ADMISSION_UNAVAILABLE 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const err = await expectRefusal(admitSignSend(SEND));

    expect(err.code).toBe('SIGN_ADMISSION_UNAVAILABLE');
    expect(err.statusCode).toBe(503);
  });

  it('timeout: aborts after REEVE_SIGN_ADMISSION_TIMEOUT_MS and fails closed', async () => {
    vi.stubEnv('REEVE_SIGN_ADMISSION_TIMEOUT_MS', '20');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          }),
      ),
    );

    const err = await expectRefusal(admitSignSend(SEND));

    expect(err.code).toBe('SIGN_ADMISSION_UNAVAILABLE');
    expect(loggerMock.error).toHaveBeenCalledWith(expect.objectContaining({ timedOut: true }));
  });
});
