import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCachedConsent, serializeConsentCache } from '~/storage/consent-check-cookie.server';

import { CONSENT_GATE_ROUTE_PATH, checkConsentGate } from './consent-gate.server';

/**
 * Loader-level coverage for the consent gate (DEV-2837 / DEV-4781). The
 * authenticated layout loader delegates entirely to `checkConsentGate`, so
 * these exercise the enforcement decisions that keep a not-yet-accepted user
 * out of protected routes and re-prompt when a cached acceptance goes stale.
 */

const ENABLED_ENV = {
  REEVE_COMPLIANCE_API_URL: 'https://compliance.example.test',
  REEVE_SHARED_HMAC_SECRET: 'test-shared-secret',
};

const SUBJECT_ID = 'user@example.com';

const USER = { email: SUBJECT_ID };

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const statusItem = (docType: string, needsAcceptance: boolean, version = '2026-01-01') => ({
  doc_type: docType,
  accepted_version: needsAcceptance ? null : version,
  accepted_at: needsAcceptance ? null : '2026-01-01T00:00:00.000Z',
  current_version: version,
  needs_acceptance: needsAcceptance,
});

const enableCompliance = () => {
  vi.stubEnv('REEVE_COMPLIANCE_API_URL', ENABLED_ENV.REEVE_COMPLIANCE_API_URL);
  vi.stubEnv('REEVE_SHARED_HMAC_SECRET', ENABLED_ENV.REEVE_SHARED_HMAC_SECRET);
};

const requestFor = (pathname: string, cookie?: string): Request =>
  new Request(`https://app.example.test${pathname}`, {
    headers: cookie ? { cookie } : {},
  });

// A `Set-Cookie` value → the corresponding request `Cookie` header (just the
// `name=value` pair, dropping the attributes browsers strip on the way back).
const asRequestCookie = (setCookie: string): string => setCookie.split(';')[0];

describe('checkConsentGate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('no-ops without calling the API when compliance is unconfigured', async () => {
    vi.stubEnv('REEVE_COMPLIANCE_API_URL', '');
    vi.stubEnv('REEVE_SHARED_HMAC_SECRET', '');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkConsentGate({ request: requestFor('/documents'), user: USER });

    expect(result).toEqual({ type: 'noop' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('when compliance is enabled', () => {
    beforeEach(() => {
      enableCompliance();
    });

    it('never gates the consent page itself (avoids a redirect loop)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await checkConsentGate({
        request: requestFor(CONSENT_GATE_ROUTE_PATH),
        user: USER,
      });

      expect(result).toEqual({ type: 'noop' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('redirects an un-accepted user to the consent page, preserving returnTo', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse({ status: [statusItem('tos', true), statusItem('privacy', false)] })),
      );

      const result = await checkConsentGate({
        request: requestFor('/documents?page=2'),
        user: USER,
      });

      expect(result).toEqual({
        type: 'redirect',
        to: `${CONSENT_GATE_ROUTE_PATH}?returnTo=${encodeURIComponent('/documents?page=2')}`,
      });
    });

    it('caches a positive result keyed to the subject AND accepted versions', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse({ status: [statusItem('tos', false), statusItem('privacy', false)] })),
      );

      const result = await checkConsentGate({ request: requestFor('/documents'), user: USER });

      expect(result.type).toBe('cache');

      if (result.type !== 'cache') {
        throw new Error('expected a cache result');
      }

      // The cached token carries the versions, not just the subject — this is
      // the DEV-4781 fix (a subject-only key never re-prompted on a bump).
      const cached = await getCachedConsent(requestFor('/documents', asRequestCookie(result.setCookieHeader)));

      expect(cached).toEqual({
        subjectId: SUBJECT_ID,
        versions: { tos: '2026-01-01', privacy: '2026-01-01' },
      });

      // Session cookie, but time-bounded so a version bump re-prompts.
      expect(result.setCookieHeader).toMatch(/Max-Age=\d+/i);
    });

    it('trusts a fresh cache for the same subject without calling the API', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const cookie = asRequestCookie(
        await serializeConsentCache({ subjectId: SUBJECT_ID, versions: { tos: '2026-01-01', privacy: '2026-01-01' } }),
      );

      const result = await checkConsentGate({ request: requestFor('/documents', cookie), user: USER });

      expect(result).toEqual({ type: 'noop' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ignores a cache belonging to a different subject and re-checks', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ status: [statusItem('tos', false), statusItem('privacy', false)] }));
      vi.stubGlobal('fetch', fetchMock);

      const cookie = asRequestCookie(
        await serializeConsentCache({
          subjectId: 'someone-else@example.com',
          versions: { tos: '2026-01-01', privacy: '2026-01-01' },
        }),
      );

      const result = await checkConsentGate({ request: requestFor('/documents', cookie), user: USER });

      expect(result.type).toBe('cache');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('re-checks when a cached acceptance is missing a now-required doc_type', async () => {
      // Cookie only covers `tos`; `privacy` is required too, so the stale
      // cache must not short-circuit the gate (DEV-4781 version-keying).
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ status: [statusItem('tos', false), statusItem('privacy', true)] }));
      vi.stubGlobal('fetch', fetchMock);

      const cookie = asRequestCookie(
        await serializeConsentCache({ subjectId: SUBJECT_ID, versions: { tos: '2026-01-01' } }),
      );

      const result = await checkConsentGate({ request: requestFor('/documents', cookie), user: USER });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.type).toBe('redirect');
    });

    it('fails open (no-op, no cache) when the status check errors', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500)));

      const result = await checkConsentGate({ request: requestFor('/documents'), user: USER });

      expect(result).toEqual({ type: 'noop' });
    });
  });
});
