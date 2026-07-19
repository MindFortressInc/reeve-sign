import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getConsentStatus, getCurrentLegalDocuments, recordConsent } from './client';

const ENABLED_ENV = {
  REEVE_COMPLIANCE_API_URL: 'https://compliance.example.test',
  REEVE_SHARED_HMAC_SECRET: 'test-shared-secret',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('compliance client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe('disabled when unconfigured', () => {
    beforeEach(() => {
      // Explicitly unset — vitest env may already be clean, but be certain.
      vi.stubEnv('REEVE_COMPLIANCE_API_URL', '');
      vi.stubEnv('REEVE_SHARED_HMAC_SECRET', '');
    });

    it('getConsentStatus no-ops (returns null, never calls fetch)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await getConsentStatus({ subjectId: 'user@example.com', docTypes: ['tos', 'privacy'] });

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getCurrentLegalDocuments no-ops (returns null, never calls fetch)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await getCurrentLegalDocuments({ docTypes: ['tos', 'privacy'] });

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('recordConsent no-ops (returns false, never calls fetch)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await recordConsent({ subjectId: 'user@example.com', docType: 'tos', version: '2026-02-02' });

      expect(result).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('only calling recordConsent still no-ops when just the secret is missing', async () => {
      vi.stubEnv('REEVE_COMPLIANCE_API_URL', 'https://compliance.example.test');
      vi.stubEnv('REEVE_SHARED_HMAC_SECRET', '');

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await recordConsent({ subjectId: 'user@example.com', docType: 'tos', version: '2026-02-02' });

      expect(result).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('when configured', () => {
    beforeEach(() => {
      vi.stubEnv('REEVE_COMPLIANCE_API_URL', ENABLED_ENV.REEVE_COMPLIANCE_API_URL);
      vi.stubEnv('REEVE_SHARED_HMAC_SECRET', ENABLED_ENV.REEVE_SHARED_HMAC_SECRET);
    });

    it('getConsentStatus parses the wire response into camelCase and signals needsAcceptance', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
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
              accepted_version: '2025-01-01',
              accepted_at: '2025-01-01T00:00:00Z',
              current_version: '2025-01-01',
              needs_acceptance: false,
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await getConsentStatus({
        subjectId: 'user@example.com',
        docTypes: ['tos', 'privacy'],
      });

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
          acceptedVersion: '2025-01-01',
          acceptedAt: '2025-01-01T00:00:00Z',
          currentVersion: '2025-01-01',
          needsAcceptance: false,
        },
      ]);

      // Request shape: correct path/query, GET, HMAC headers present.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsedUrl = new URL(url);

      expect(parsedUrl.pathname).toBe('/api/compliance/v1/consent/status');
      expect(parsedUrl.searchParams.get('host_app')).toBe('reeve');
      expect(parsedUrl.searchParams.get('subject_id')).toBe('user@example.com');
      expect(parsedUrl.searchParams.get('doc_types')).toBe('tos,privacy');
      expect(parsedUrl.searchParams.get('subject_type')).toBe('user');
      expect(init.method).toBe('GET');

      const headers = init.headers as Record<string, string>;
      expect(headers['X-Reeve-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(headers['X-Reeve-Timestamp']).toMatch(/^\d+$/);
    });

    it('getConsentStatus fails open (returns null) on a non-2xx response', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: 'boom' }, 500));
      vi.stubGlobal('fetch', fetchMock);

      const result = await getConsentStatus({ subjectId: 'user@example.com', docTypes: ['tos'] });

      expect(result).toBeNull();
    });

    it('getConsentStatus fails open (returns null) on a network error', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      vi.stubGlobal('fetch', fetchMock);

      const result = await getConsentStatus({ subjectId: 'user@example.com', docTypes: ['tos'] });

      expect(result).toBeNull();
    });

    it('getCurrentLegalDocuments parses the wire response into camelCase', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          documents: [
            {
              doc_type: 'tos',
              version: '2026-02-02',
              locale: 'en',
              effective_at: '2026-02-02T00:00:00Z',
              content_url: 'https://meetreeve.com/legal/tos',
              content_sha256: 'abc123',
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await getCurrentLegalDocuments({ docTypes: ['tos', 'privacy'] });

      expect(result).toEqual([
        {
          docType: 'tos',
          version: '2026-02-02',
          locale: 'en',
          effectiveAt: '2026-02-02T00:00:00Z',
          contentUrl: 'https://meetreeve.com/legal/tos',
          contentSha256: 'abc123',
        },
      ]);

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(new URL(url).pathname).toBe('/api/compliance/v1/legal/current');
    });

    it('recordConsent posts the exact wire field names expected by RecordConsentRequest', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'rec_1',
          host_app: 'reeve',
          subject_type: 'user',
          subject_id: 'user@example.com',
          doc_type: 'tos',
          version: '2026-02-02',
          document_id: 'doc_1',
          action: 'accepted',
          accepted_at: '2026-07-18T00:00:00Z',
          source: 'reeve-sign',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await recordConsent({
        subjectId: 'user@example.com',
        docType: 'tos',
        version: '2026-02-02',
        ip: '1.2.3.4',
        userAgent: 'test-agent',
      });

      expect(result).toBe(true);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(new URL(url).pathname).toBe('/api/compliance/v1/consent');
      expect(init.method).toBe('POST');

      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        host_app: 'reeve',
        subject_id: 'user@example.com',
        doc_type: 'tos',
        version: '2026-02-02',
        subject_type: 'user',
        action: 'accepted',
        locale: 'en',
        ip: '1.2.3.4',
        user_agent: 'test-agent',
        source: 'reeve-sign',
      });

      const headers = init.headers as Record<string, string>;
      expect(headers['X-Reeve-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('recordConsent returns false (never throws) when the API errors', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: 'nope' }, 401));
      vi.stubGlobal('fetch', fetchMock);

      const result = await recordConsent({ subjectId: 'user@example.com', docType: 'tos', version: '2026-02-02' });

      expect(result).toBe(false);
    });

    it('recordConsent returns false (never throws) on a network error', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        recordConsent({ subjectId: 'user@example.com', docType: 'tos', version: '2026-02-02' }),
      ).resolves.toBe(false);
    });
  });
});
