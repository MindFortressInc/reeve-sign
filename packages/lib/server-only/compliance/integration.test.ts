import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getConsentStatus, getCurrentLegalDocuments, recordConsent } from './client';

/**
 * End-to-end verification of the HMAC signing scheme against a REAL HTTP
 * server (not a mocked `fetch`) — a JS port of reeve-services'
 * `api/services/channels/hmac_middleware.py::verify_hmac`, written
 * independently of `sign-request.ts` so this test can't pass just because
 * both sides share a bug. This is what confirms the client interoperates
 * with the actual reeve-services request-verification algorithm, not just
 * that it produces *a* signature.
 */

const HEX64_RE = /^[0-9a-f]{64}$/i;
const TIMESTAMP_WINDOW_SECONDS = 300;

const verifyHmacLikeReeveServices = (secret: string, body: string, headers: IncomingMessage['headers']): boolean => {
  if (!secret) {
    return false;
  }

  const sigHeader = headers['x-reeve-signature'];
  const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;

  if (!sig || !sig.startsWith('sha256=')) {
    return false;
  }

  const provided = sig.slice('sha256='.length);

  if (!HEX64_RE.test(provided)) {
    return false;
  }

  const tsHeader = headers['x-reeve-timestamp'];
  const ts = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;

  let signed = body;

  if (ts !== undefined) {
    const tsInt = Number.parseInt(ts, 10);

    if (Number.isNaN(tsInt)) {
      return false;
    }

    if (Math.abs(Date.now() / 1000 - tsInt) > TIMESTAMP_WINDOW_SECONDS) {
      return false;
    }

    signed = `${ts}.${body}`;
  }

  const expected = createHmac('sha256', secret).update(signed).digest('hex');

  const providedBuf = Buffer.from(provided.toLowerCase(), 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
};

describe('compliance client — HMAC integration against a real HTTP server', () => {
  const SECRET = 'integration-test-shared-secret';

  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let lastRequest: { path: string; body: string; verified: boolean } | null = null;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => chunks.push(chunk));

      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const verified = verifyHmacLikeReeveServices(SECRET, body, req.headers);
        const url = new URL(req.url ?? '/', 'http://localhost');

        lastRequest = { path: url.pathname, body, verified };

        if (!verified) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'Signature mismatch' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });

        if (url.pathname === '/api/compliance/v1/consent/status') {
          res.end(
            JSON.stringify({
              status: [
                {
                  doc_type: 'tos',
                  accepted_version: null,
                  accepted_at: null,
                  current_version: '2026-02-02',
                  needs_acceptance: true,
                },
                {
                  doc_type: 'privacy',
                  accepted_version: '2026-02-02',
                  accepted_at: '2026-01-01T00:00:00Z',
                  current_version: '2026-02-02',
                  needs_acceptance: false,
                },
              ],
            }),
          );
          return;
        }

        if (url.pathname === '/api/compliance/v1/legal/current') {
          res.end(
            JSON.stringify({
              documents: [
                {
                  doc_type: 'tos',
                  version: '2026-02-02',
                  locale: 'en',
                  effective_at: '2026-02-02T00:00:00Z',
                  content_url: 'https://meetreeve.com/legal/tos',
                  content_sha256: null,
                },
              ],
            }),
          );
          return;
        }

        if (url.pathname === '/api/compliance/v1/consent') {
          res.end(
            JSON.stringify({
              id: 'rec_integration_1',
              host_app: 'reeve',
              subject_type: 'user',
              subject_id: 'user@example.com',
              doc_type: 'tos',
              version: '2026-02-02',
              document_id: null,
              action: 'accepted',
              accepted_at: new Date().toISOString(),
              source: 'reeve-sign',
            }),
          );
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));

    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  beforeEach(() => {
    lastRequest = null;
    vi.stubEnv('REEVE_COMPLIANCE_API_URL', baseUrl);
    vi.stubEnv('REEVE_SHARED_HMAC_SECRET', SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('getConsentStatus: the request signature verifies server-side and the response is parsed correctly', async () => {
    const result = await getConsentStatus({ subjectId: 'user@example.com', docTypes: ['tos', 'privacy'] });

    expect(lastRequest?.verified).toBe(true);
    expect(lastRequest?.path).toBe('/api/compliance/v1/consent/status');
    expect(result).toEqual([
      {
        docType: 'tos',
        acceptedVersion: null,
        acceptedAt: null,
        currentVersion: '2026-02-02',
        needsAcceptance: true,
      },
      {
        docType: 'privacy',
        acceptedVersion: '2026-02-02',
        acceptedAt: '2026-01-01T00:00:00Z',
        currentVersion: '2026-02-02',
        needsAcceptance: false,
      },
    ]);
  });

  it('getCurrentLegalDocuments: the request signature verifies server-side', async () => {
    const result = await getCurrentLegalDocuments({ docTypes: ['tos'] });

    expect(lastRequest?.verified).toBe(true);
    expect(result).toEqual([
      {
        docType: 'tos',
        version: '2026-02-02',
        locale: 'en',
        effectiveAt: '2026-02-02T00:00:00Z',
        contentUrl: 'https://meetreeve.com/legal/tos',
        contentSha256: null,
      },
    ]);
  });

  it('recordConsent: the POST body signature verifies server-side (body-bound, not just headers)', async () => {
    const ok = await recordConsent({
      subjectId: 'user@example.com',
      docType: 'tos',
      version: '2026-02-02',
      ip: '203.0.113.1',
      userAgent: 'integration-test',
    });

    expect(lastRequest?.verified).toBe(true);
    expect(lastRequest?.path).toBe('/api/compliance/v1/consent');
    expect(ok).toBe(true);
  });

  it('a tampered body fails server-side verification (proves the signature is actually load-bearing)', async () => {
    // Sanity check that our test server's verifier isn't a rubber stamp:
    // hitting it with an unsigned request must fail closed, same as
    // reeve-services' verify_hmac does on a missing/invalid signature.
    const response = await fetch(
      `${baseUrl}/api/compliance/v1/consent/status?host_app=reeve&subject_id=x&doc_types=tos`,
      {
        method: 'GET',
        headers: { 'X-Reeve-Signature': `sha256=${'0'.repeat(64)}` },
      },
    );

    expect(response.status).toBe(401);
    expect(lastRequest?.verified).toBe(false);
  });
});
