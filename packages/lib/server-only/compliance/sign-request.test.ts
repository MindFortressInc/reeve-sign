import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildSignedHeaders,
  REEVE_SIGNATURE_HEADER,
  REEVE_TIMESTAMP_HEADER,
  signReeveRequestBody,
} from './sign-request';

/**
 * The known-answer digests below were computed independently in Python
 * (NOT via this file's own code, and NOT re-derived from node:crypto) to
 * verify against reeve-services' actual runtime — mirroring
 * `hmac.new(secret, f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()`
 * from `api/services/channels/hmac_middleware.py` (pin `31b880bc5526`):
 *
 *   python3 -c "import hmac,hashlib; print(hmac.new(b'k', b'1700000000.hello', hashlib.sha256).hexdigest())"
 */
describe('signReeveRequestBody', () => {
  it('matches an independently-computed (Python) fixture for a simple body', () => {
    const { signature, timestamp } = signReeveRequestBody('k', 'hello', 1_700_000_000);

    expect(timestamp).toBe('1700000000');
    expect(signature).toBe('sha256=0c511384dbc4c6b6cbe53e5da961410697e51518b6128a9f4b1c0920a2ba5ff5');
  });

  it('matches an independently-computed (Python) fixture for a JSON body', () => {
    const body = '{"host_app":"reeve","subject_id":"user@example.com"}';

    const { signature } = signReeveRequestBody('test-shared-secret', body, 1_700_000_000);

    expect(signature).toBe('sha256=feafe4ae4c058560a0b9b782bcdd47d323b948a01a3c9c9a7481af07ea8e1972');
  });

  it('matches an independently-computed (Python) fixture for an empty body (GET requests)', () => {
    const { signature } = signReeveRequestBody('k', '', 1_700_000_000);

    expect(signature).toBe('sha256=5c2999a43333a6877f49c8003f235c4f6de40f85b1b7414b70bd470a8db53d97');
  });

  it('always produces a 64-char lowercase hex digest prefixed with sha256=', () => {
    const { signature } = signReeveRequestBody('some-secret', JSON.stringify({ a: 1 }));

    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('signs the "timestamp.body" message — matches the construction independently via node:crypto', () => {
    const secret = 'another-secret';
    const body = JSON.stringify({ subject_id: 'abc', doc_type: 'tos' });
    const timestamp = 1_800_000_000;

    const { signature } = signReeveRequestBody(secret, body, timestamp);

    const expectedDigest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    expect(signature).toBe(`sha256=${expectedDigest}`);
  });

  it('produces a different signature when the timestamp changes (replay protection)', () => {
    const { signature: sig1 } = signReeveRequestBody('k', 'body', 1_700_000_000);
    const { signature: sig2 } = signReeveRequestBody('k', 'body', 1_700_000_001);

    expect(sig1).not.toBe(sig2);
  });

  it('produces a different signature when the body changes', () => {
    const { signature: sig1 } = signReeveRequestBody('k', 'body-a', 1_700_000_000);
    const { signature: sig2 } = signReeveRequestBody('k', 'body-b', 1_700_000_000);

    expect(sig1).not.toBe(sig2);
  });

  it('defaults the timestamp to the current time when not provided', () => {
    const before = Math.floor(Date.now() / 1000);
    const { timestamp } = signReeveRequestBody('k', 'body');
    const after = Math.floor(Date.now() / 1000);

    expect(Number(timestamp)).toBeGreaterThanOrEqual(before);
    expect(Number(timestamp)).toBeLessThanOrEqual(after);
  });
});

describe('buildSignedHeaders', () => {
  it('returns the exact header names reeve-services expects', () => {
    const headers = buildSignedHeaders('secret', 'body');

    expect(REEVE_SIGNATURE_HEADER).toBe('X-Reeve-Signature');
    expect(REEVE_TIMESTAMP_HEADER).toBe('X-Reeve-Timestamp');
    expect(headers['X-Reeve-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers['X-Reeve-Timestamp']).toMatch(/^\d+$/);
  });

  it('is consistent with signReeveRequestBody for the same inputs', () => {
    const secret = 'shared';
    const body = '{"x":1}';

    const direct = signReeveRequestBody(secret, body, 1_700_000_000);
    const headers = buildSignedHeaders(secret, body);

    // Timestamps will differ (buildSignedHeaders uses "now"), so only
    // compare after re-signing with the header's own timestamp.
    const resigned = signReeveRequestBody(secret, body, Number(headers[REEVE_TIMESTAMP_HEADER]));

    expect(headers[REEVE_SIGNATURE_HEADER]).toBe(resigned.signature);
    expect(direct.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
