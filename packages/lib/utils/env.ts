/// <reference types="@documenso/tsconfig/process-env.d.ts" />

import { AppError, AppErrorCode } from '../errors/app-error';

declare global {
  interface Window {
    __ENV__?: Record<string, string | undefined>;
  }
}

// eslint-disable-next-line @typescript-eslint/ban-types
type EnvKey = keyof NodeJS.ProcessEnv | (string & {});
type EnvValue<K extends EnvKey> = K extends keyof NodeJS.ProcessEnv ? NodeJS.ProcessEnv[K] : string | undefined;

export const env = <K extends EnvKey>(variable: K): EnvValue<K> => {
  if (typeof window !== 'undefined' && typeof window.__ENV__ === 'object') {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return window.__ENV__[variable as string] as EnvValue<K>;
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return (typeof process !== 'undefined' ? process?.env?.[variable] : undefined) as EnvValue<K>;
};

/**
 * Guards a localhost fallback so it can never silently apply in production.
 *
 * These fallbacks exist so local dev runs with zero configuration, but in
 * production a missing variable is a misconfiguration that fails *invisibly*:
 * mail is dialled into a non-existent local relay and disappears, or every
 * email link is minted against localhost:3000. Both look like success at the
 * call site, so fail loudly here instead.
 *
 * Deliberately a no-op in the browser. NODE_ENV is not part of the public env
 * payload (see `createPublicEnv`), so the client cannot tell production from
 * dev and would throw on every render.
 *
 * @param variable The environment variable that should have been set.
 * @param fallback The localhost value that would otherwise be used.
 */
export const assertLocalhostFallbackAllowed = (variable: string, fallback: string): void => {
  if (typeof window !== 'undefined') {
    return;
  }

  if (env('NODE_ENV') === 'production') {
    throw new AppError(AppErrorCode.NOT_SETUP, {
      message: `${variable} is not set. Refusing to fall back to "${fallback}" in production, which would fail silently.`,
    });
  }
};

export const createPublicEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('NEXT_PUBLIC_'))),
  // Derived from the private URL so the public flag cannot drift from the
  // real server-side configuration. Placed last so it wins over any literal
  // env var with the same name.
  // The `? 'true' : 'false'` might seem dumb but it's because we're expecting env var strings.
  NEXT_PUBLIC_DOCUMENT_CONVERSION_ENABLED: process.env.NEXT_PRIVATE_DOCUMENT_CONVERSION_URL ? 'true' : 'false',
});
