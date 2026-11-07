import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { fetchWithTimeout } from './timeout';

// DEV-18278: the deadline covers the whole exchange. A server that sends its
// headers and then stalls the body used to hang the caller with no deadline,
// because the timer was cleared as soon as the headers arrived.

let server: Server | undefined;

const listen = async (handler: Parameters<typeof createServer>[1]) => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

describe('fetchWithTimeout', () => {
  it('aborts a body read that stalls after the headers arrive', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"decision":');
    });

    const response = await fetchWithTimeout(url, { method: 'POST', timeoutMs: 100 });
    const started = Date.now();

    await expect(response.text()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_500);
  }, 5_000);

  it('rejects a server that never sends headers with the timed-out message', async () => {
    const url = await listen(() => {
      // Never respond.
    });

    await expect(fetchWithTimeout(url, { method: 'POST', timeoutMs: 100 })).rejects.toThrow(
      'Request timed out after 100ms',
    );
  }, 5_000);

  it('returns a complete body unchanged', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });

    const response = await fetchWithTimeout(url, { method: 'GET', timeoutMs: 1_000 });

    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
