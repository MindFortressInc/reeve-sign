import { describe, expect, it, vi } from 'vitest';

// Builds a `resolveGitSha` arg from a `ProcessEnv`-typed base (the real
// `process.env`) rather than a bare object literal cast past its type --
// Documenso's `ProcessEnv` augmentation
// (packages/tsconfig/process-env.d.ts) declares several members as
// required (NEXT_PRIVATE_DATABASE_URL, NEXT_PRIVATE_ENCRYPTION_KEY, ...)
// that `{ GIT_SHA: '...' }` alone doesn't satisfy, but the real
// process.env does. GIT_SHA is always explicitly overridden (never left
// to whatever happens to be set on the machine running the test) so every
// case here stays deterministic.
const envWithGitSha = (gitSha: string | undefined): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_SHA: gitSha,
});

// DEV-7600 (T5b): /api/health must report the deployed commit so
// `reeve-deploy-verify served-sha`/`served-sha-external` can confirm the
// process ACTUALLY serving traffic is running the sha just deployed (the
// same DEV-3571 class this ticket's NODE_ENV finding belongs to). Mirrors
// reeve-services' api/routers/health.py::_resolve_git_sha and
// packages/monitor/reeve_monitor's platform-wide `GIT_SHA` env convention.
//
// prisma is mocked (pattern: packages/lib/server-only/reeve-admin/
// provision-organisation.test.ts) so this test never opens a real DB
// connection -- $queryRaw is made to reject, which the loader already
// handles (checks.database -> 'error'), exercising the loader's real
// error path for free rather than requiring a live database.
const queryRawMock = vi.fn().mockRejectedValue(new Error('no db in unit tests'));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    $queryRaw: queryRawMock,
  },
}));

vi.mock('@documenso/lib/server-only/cert/cert-status', () => ({
  getCertificateStatus: () => ({ isAvailable: true }),
}));

describe('resolveGitSha', () => {
  it('returns the sha when GIT_SHA is set', async () => {
    const { resolveGitSha } = await import('./health');

    expect(resolveGitSha(envWithGitSha('abc1234'))).toBe('abc1234');
  });

  it('trims surrounding whitespace', async () => {
    const { resolveGitSha } = await import('./health');

    expect(resolveGitSha(envWithGitSha('  abc1234\n'))).toBe('abc1234');
  });

  it('returns null, never a placeholder string, when GIT_SHA is unset', async () => {
    const { resolveGitSha } = await import('./health');

    expect(resolveGitSha(envWithGitSha(undefined))).toBeNull();
  });

  it('returns null when GIT_SHA is empty (the Dockerfile ARG default when no build-arg is passed)', async () => {
    const { resolveGitSha } = await import('./health');

    expect(resolveGitSha(envWithGitSha(''))).toBeNull();
  });
});

describe('/api/health loader', () => {
  it('includes git_sha in the response body when GIT_SHA is set', async () => {
    vi.stubEnv('GIT_SHA', 'deadbee');
    const { loader } = await import('./health');

    const response = await loader();
    const body = await response.json();

    expect(body.git_sha).toBe('deadbee');

    vi.unstubAllEnvs();
  });

  it('reports git_sha as null (not a placeholder string) when GIT_SHA is unset', async () => {
    vi.stubEnv('GIT_SHA', '');
    const { loader } = await import('./health');

    const response = await loader();
    const body = await response.json();

    expect(body.git_sha).toBeNull();

    vi.unstubAllEnvs();
  });
});
