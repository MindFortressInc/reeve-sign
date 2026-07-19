import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors/app-error';
import { commitReservation, getCreditsBalance, reserveCredits, voidReservation } from './client';

const API_URL = 'https://api.meetreeve.com';
const HOST_KEY = 'sign_hostkey_test123';

const jsonResponse = (status: number, body: unknown): Response =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

beforeEach(() => {
  vi.stubEnv('REEVE_CREDITS_API_URL', API_URL);
  vi.stubEnv('REEVE_SIGN_HOST_KEY', HOST_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reserveCredits', () => {
  it('sends the X-Reeve-Host-Key header and snake_case body to POST /api/v1/credits/reserve', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { reserved: 500, reservation_id: 'res_1' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await reserveCredits({
      ownerId: '42',
      amount: 500,
      referenceId: 'sign.send.envelope_abc',
      reason: 'sign.envelope.send',
    });

    expect(result).toEqual({ reservationId: 'res_1', reserved: 500 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/credits/reserve`);
    expect(init.method).toBe('POST');
    expect(init.headers['X-Reeve-Host-Key']).toBe(HOST_KEY);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      owner_id: '42',
      amount: 500,
      reference_id: 'sign.send.envelope_abc',
      reason: 'sign.envelope.send',
      owner_type: 'user',
    });
  });

  it('is idempotent: calling twice with the same referenceId sends the same reference_id both times', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { reserved: 500, reservation_id: 'res_1' }));
    vi.stubGlobal('fetch', fetchMock);

    const opts = {
      ownerId: '42',
      amount: 500,
      referenceId: 'sign.send.envelope_abc',
      reason: 'sign.envelope.send',
    };

    const first = await reserveCredits(opts);
    const second = await reserveCredits(opts);

    // The client doesn't dedupe locally — idempotency is enforced server-side
    // on (host_app, owner, reason, reference_id) — but both calls must carry
    // the identical reference_id so the server CAN dedupe them.
    expect(first.reservationId).toBe(second.reservationId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.reference_id).toBe(secondBody.reference_id);
  });

  it('throws INSUFFICIENT_CREDITS (402) when the balance is too low', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(402, { error: 'insufficient_credits', needed: 500, balance: 100 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      reserveCredits({ ownerId: '42', amount: 500, referenceId: 'ref_1', reason: 'sign.envelope.send' }),
    ).rejects.toThrow(AppError);

    try {
      await reserveCredits({ ownerId: '42', amount: 500, referenceId: 'ref_1', reason: 'sign.envelope.send' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INSUFFICIENT_CREDITS');
      expect((err as AppError).statusCode).toBe(402);
      expect((err as AppError).userMessage).toMatch(/enough credits/i);
    }
  });

  it('fails closed with CREDITS_SERVICE_UNAVAILABLE when fetch rejects (network error)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await reserveCredits({ ownerId: '42', amount: 500, referenceId: 'ref_1', reason: 'sign.envelope.send' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('CREDITS_SERVICE_UNAVAILABLE');
      expect((err as AppError).statusCode).toBe(503);
    }
  });

  it('fails closed with CREDITS_SERVICE_UNAVAILABLE on a non-2xx/402 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { error: 'internal' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      reserveCredits({ ownerId: '42', amount: 500, referenceId: 'ref_1', reason: 'sign.envelope.send' }),
    ).rejects.toMatchObject({ code: 'CREDITS_SERVICE_UNAVAILABLE' });
  });

  it('throws CREDITS_SERVICE_NOT_CONFIGURED (fail closed, not a silent no-op) when called directly without env vars', async () => {
    vi.stubEnv('REEVE_CREDITS_API_URL', '');
    vi.stubEnv('REEVE_SIGN_HOST_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      reserveCredits({ ownerId: '42', amount: 500, referenceId: 'ref_1', reason: 'sign.envelope.send' }),
    ).rejects.toMatchObject({ code: 'CREDITS_SERVICE_NOT_CONFIGURED' });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('commitReservation', () => {
  it('POSTs to /api/v1/credits/reserve/:id/commit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { committed: 500, entry_id: 'entry_1', reservation_id: 'res_1' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await commitReservation('res_1');

    expect(result).toEqual({ entryId: 'entry_1', committed: 500, reservationId: 'res_1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/credits/reserve/res_1/commit`);
    expect(init.method).toBe('POST');
    expect(init.headers['X-Reeve-Host-Key']).toBe(HOST_KEY);
  });
});

describe('voidReservation', () => {
  it('POSTs to /api/v1/credits/reserve/:id/void', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { voided: true, reservation_id: 'res_1' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await voidReservation('res_1');

    expect(result).toEqual({ voided: true, reservationId: 'res_1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/credits/reserve/res_1/void`);
    expect(init.method).toBe('POST');
  });
});

describe('getCreditsBalance', () => {
  it('GETs /api/v1/credits/balance/:ownerId and maps the response to camelCase', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        balance: 1500,
        base: 1000,
        top_up: 500,
        expiring_soon: 0,
        owner_type: 'user',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getCreditsBalance('42');

    expect(result).toEqual({
      balance: 1500,
      base: 1000,
      topUp: 500,
      expiringSoon: 0,
      ownerType: 'user',
      reason: undefined,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/credits/balance/42?owner_type=user`);
    expect(init.method).toBe('GET');
  });
});
