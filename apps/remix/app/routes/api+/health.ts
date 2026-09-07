import { getCertificateStatus } from '@documenso/lib/server-only/cert/cert-status';
import { prisma } from '@documenso/prisma';

type CheckStatus = 'ok' | 'warning' | 'error';

/**
 * Resolves the git sha of the commit this process is serving (DEV-7600,
 * T5b of epic DEV-4419 "the box holds nothing"). Read by
 * `reeve-deploy-verify served-sha`/`served-sha-external` to confirm the
 * process ACTUALLY serving traffic matches the sha just deployed -- the
 * same class of bug DEV-3571 named in reeve-services (a stale orphan
 * process silently serving old code).
 *
 * `GIT_SHA` is the platform-wide env convention already read by
 * reeve-services' api/routers/health.py::_resolve_git_sha and
 * packages/monitor/reeve_monitor for the Sentry release -- reused here
 * rather than inventing a second name. For reeve-sign it is the SHORT sha
 * (docker/Dockerfile's `GIT_SHA` build ARG, baked in at image build time by
 * .github/workflows/publish.yml from the SAME `git rev-parse --short HEAD`
 * value already used to tag the image `sha-<shortsha>` -- one source of
 * truth, not two), not a full 40-char sha.
 *
 * Returns `null`, never a placeholder string, when unset: a placeholder
 * (e.g. "unknown") could make a served-sha comparison pass or fail for the
 * wrong reason depending on what `--want` happens to be; `null` can never
 * equal a real sha, so an unset GIT_SHA always reads as "verification
 * cannot run here" rather than silently comparing against junk.
 *
 * Takes an explicit `env` parameter (default `process.env`) rather than
 * reading `process.env.GIT_SHA` directly -- same reasoning as
 * `initServerSentry(dsn)` in ./sentry.ts: an injectable parameter is
 * trivially testable without mocking global process state.
 */
export const resolveGitSha = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const sha = env.GIT_SHA?.trim();

  return sha ? sha : null;
};

export const loader = async () => {
  const checks: {
    database: { status: CheckStatus };
    certificate: { status: CheckStatus };
  } = {
    database: { status: 'ok' },
    certificate: { status: 'ok' },
  };

  let overallStatus: CheckStatus = 'ok';

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    checks.database = { status: 'error' };
    overallStatus = 'error';
  }

  try {
    const certStatus = getCertificateStatus();

    if (certStatus.isAvailable) {
      checks.certificate = { status: 'ok' };
    } else {
      checks.certificate = { status: 'warning' };

      if (overallStatus === 'ok') {
        overallStatus = 'warning';
      }
    }
  } catch {
    checks.certificate = { status: 'error' };
    overallStatus = 'error';
  }

  return Response.json(
    {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      git_sha: resolveGitSha(),
      checks,
    },
    { status: overallStatus === 'error' ? 500 : 200 },
  );
};
