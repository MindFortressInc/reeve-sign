import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors/app-error';
import { commitReservation, reserveCredits, voidReservation } from './client';
import { meterDocumentSend } from './meter-send';

/**
 * DEV-2838 outcome eval: this is NOT a mocked-client test — it spins up a
 * real local HTTP server that mimics reeve-services' actual
 * `/api/v1/credits` wire contract (api/routers/credits_host_app.py) and
 * drives the REAL, unmocked `reserveCredits` / `commitReservation` /
 * `voidReservation` / `meterDocumentSend` against it over real `fetch`. It
 * exists to catch what the mocked unit tests (client.test.ts,
 * meter-send.test.ts) structurally cannot: wire-format drift (header
 * casing, URL construction, JSON body shape) and the EXACT text a caller
 * receives on the two send-blocking outcomes a user can hit — insufficient
 * balance and an unreachable credits service.
 */

const HOST_KEY = 'sign_hostkey_live_test';

type Reservation = {
  id: string;
  ownerId: string;
  amount: number;
  referenceId: string;
  reason: string;
  status: 'open' | 'committed' | 'voided';
};

function startFakeCreditsServer(opts: { balances: Record<string, number> }) {
  const reservations = new Map<string, Reservation>();
  let nextId = 1;

  const server = http.createServer((req, res) => {
    if (req.headers['x-reeve-host-key'] !== HOST_KEY) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const parsed = body ? JSON.parse(body) : {};

      if (req.method === 'POST' && url.pathname === '/api/v1/credits/reserve') {
        const { owner_id: ownerId, amount, reference_id: referenceId, reason } = parsed;
        const balance = opts.balances[ownerId] ?? 0;

        // Idempotent replay, mirroring packages/credits/service.py reserve().
        const existing = [...reservations.values()].find(
          (r) => r.ownerId === ownerId && r.reason === reason && r.referenceId === referenceId && r.status !== 'voided',
        );
        if (existing) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ reserved: existing.amount, reservation_id: existing.id }));
          return;
        }

        if (balance < amount) {
          res.writeHead(402, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'insufficient_credits', needed: amount, balance }));
          return;
        }

        const id = `res_${nextId++}`;
        reservations.set(id, { id, ownerId, amount, referenceId, reason, status: 'open' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ reserved: amount, reservation_id: id }));
        return;
      }

      const commitMatch = url.pathname.match(/^\/api\/v1\/credits\/reserve\/([^/]+)\/commit$/);
      if (req.method === 'POST' && commitMatch) {
        const r = reservations.get(commitMatch[1]);
        if (!r) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'reservation_not_found' }));
          return;
        }
        if (r.status !== 'open') {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'reservation_conflict', status: r.status }));
          return;
        }
        r.status = 'committed';
        opts.balances[r.ownerId] = (opts.balances[r.ownerId] ?? 0) - r.amount;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ committed: r.amount, entry_id: `entry_${r.id}`, reservation_id: r.id }));
        return;
      }

      const voidMatch = url.pathname.match(/^\/api\/v1\/credits\/reserve\/([^/]+)\/void$/);
      if (req.method === 'POST' && voidMatch) {
        const r = reservations.get(voidMatch[1]);
        if (!r) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'reservation_not_found' }));
          return;
        }
        if (r.status !== 'open') {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'reservation_conflict', status: r.status }));
          return;
        }
        r.status = 'voided';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ voided: true, reservation_id: r.id }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });

  return { server, reservations, balances: opts.balances };
}

// Real numeric userIds (as sendDocument() passes), mapped through
// String(userId) to the balance-store keys below — exercises the exact
// ownerId derivation meterDocumentSend() does in production.
const RICH_USER_ID = 42;
const POOR_USER_ID = 7;

describe('DEV-2838 live outcome eval — real HTTP server, real (unmocked) client', () => {
  let server: http.Server;
  let baseUrl: string;
  let balances: Record<string, number>;

  beforeEach(async () => {
    balances = { [String(RICH_USER_ID)]: 10_000, [String(POOR_USER_ID)]: 100 };
    const fake = startFakeCreditsServer({ balances });
    server = fake.server;
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    vi.stubEnv('REEVE_CREDITS_API_URL', baseUrl);
    vi.stubEnv('REEVE_SIGN_HOST_KEY', HOST_KEY);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('SCENARIO: user with plenty of balance sends a document — reserve then commit against the real server, sendFn actually runs', async () => {
    const sendFn = vi.fn().mockResolvedValue({ id: 'envelope_1', status: 'PENDING' });

    const result = await meterDocumentSend({ userId: RICH_USER_ID, envelopeId: 'envelope_1' }, sendFn);

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: 'envelope_1', status: 'PENDING' });
    // Real server-side effect: the balance was actually debited by commit.
    expect(balances[String(RICH_USER_ID)]).toBe(10_000 - 500);
  });

  it('SCENARIO: user with insufficient balance tries to send — sees the real "not enough credits" message, sendFn never runs, nothing is billed', async () => {
    const sendFn = vi.fn().mockResolvedValue({ id: 'envelope_2', status: 'PENDING' });

    let caught: unknown;
    try {
      await meterDocumentSend({ userId: POOR_USER_ID, envelopeId: 'envelope_2' }, sendFn);
      expect.unreachable('should have blocked the send');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    const appError = caught as AppError;
    // This is the ACTUAL string a human would read, produced by the real
    // client + real server round-trip — not asserted against a mock.
    console.log(`[outcome-eval] insufficient-credits userMessage: "${appError.userMessage}"`);
    expect(appError.userMessage).toBe(
      "You don't have enough credits to send this document. Please top up your balance and try again.",
    );
    expect(appError.statusCode).toBe(402);
    expect(sendFn).not.toHaveBeenCalled();
    expect(balances[String(POOR_USER_ID)]).toBe(100); // untouched — no partial charge
  });

  it('SCENARIO: reeve-services is unreachable at send time — FAILS CLOSED with the real "try again shortly" message, sendFn never runs (no free-send hole)', async () => {
    // Point at a real closed port on localhost instead of the running fake
    // server, so this is a genuine connection failure, not a mock.
    vi.stubEnv('REEVE_CREDITS_API_URL', 'http://127.0.0.1:1');

    const sendFn = vi.fn().mockResolvedValue({ id: 'envelope_3', status: 'PENDING' });

    let caught: unknown;
    try {
      await meterDocumentSend({ userId: RICH_USER_ID, envelopeId: 'envelope_3' }, sendFn);
      expect.unreachable('should have failed closed');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    const appError = caught as AppError;
    console.log(`[outcome-eval] fail-closed userMessage: "${appError.userMessage}"`);
    expect(appError.userMessage).toBe(
      "We couldn't verify your credit balance right now. Please try sending again shortly.",
    );
    expect(appError.statusCode).toBe(503);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('SCENARIO: a retried send of the SAME envelope does not double-charge — reserve replays the same reservation', async () => {
    const first = await reserveCredits({
      ownerId: String(RICH_USER_ID),
      amount: 500,
      referenceId: 'sign.send.envelope_retry',
      reason: 'sign.envelope.send',
    });
    const second = await reserveCredits({
      ownerId: String(RICH_USER_ID),
      amount: 500,
      referenceId: 'sign.send.envelope_retry',
      reason: 'sign.envelope.send',
    });

    expect(second.reservationId).toBe(first.reservationId);

    await commitReservation(first.reservationId);
    // Balance debited exactly once, not twice, despite two reserve() calls.
    expect(balances[String(RICH_USER_ID)]).toBe(10_000 - 500);
  });

  it('SCENARIO: send fails after reserving — the hold is voided against the real server, balance is untouched', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('recipient email bounced'));

    await expect(meterDocumentSend({ userId: RICH_USER_ID, envelopeId: 'envelope_4' }, sendFn)).rejects.toThrow(
      'recipient email bounced',
    );

    // The reservation was voided server-side, not committed — balance intact.
    expect(balances[String(RICH_USER_ID)]).toBe(10_000);
  });
});

describe('DEV-2838 live outcome eval — voidReservation against the real server', () => {
  let server: http.Server;
  let balances: Record<string, number>;

  beforeAll(async () => {
    balances = { user_a: 1000 };
    const fake = startFakeCreditsServer({ balances });
    server = fake.server;
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    vi.stubEnv('REEVE_CREDITS_API_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('REEVE_SIGN_HOST_KEY', HOST_KEY);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('voids an open reservation and a second void on the same id 503s (fail closed, not silently ignored)', async () => {
    const r = await reserveCredits({ ownerId: 'user_a', amount: 100, referenceId: 'ref_void', reason: 'test' });
    const result = await voidReservation(r.reservationId);
    expect(result).toEqual({ voided: true, reservationId: r.reservationId });

    await expect(voidReservation(r.reservationId)).rejects.toMatchObject({ code: 'CREDITS_RESERVATION_CONFLICT' });
  });
});
