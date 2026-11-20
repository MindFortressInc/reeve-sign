import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { i18n } from '@lingui/core';
import { WebhookTriggerEvents } from '@prisma/client';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

// DEV-19567: developer- and admin-facing white-label leaks. DEV-18381 fixed the
// signer-facing ones; these are what API users, webhook integrators and org
// admins see: OpenAPI titles, the v1 docs redirect, vendor docs/support links,
// download filenames and webhook test payloads.

// Same mock as server/trpc/openapi-route-shadowing.test.ts: the appRouter import
// graph eagerly loads compiled lingui catalogs, which CI's test job does not build.
vi.mock('@documenso/lib/client-only/providers/i18n-server', () => ({
  loadCatalog: vi.fn(async (lang: string) => ({ [lang]: {} })),
  allI18nInstances: Promise.resolve({}),
  getI18nInstance: vi.fn(async () => ({ _: (message: unknown) => message })),
}));

const VENDOR = /documenso\.com|documen\.so/i;

describe('OpenAPI documents', () => {
  it('v2 is titled Reeve.Sign and names no vendor host', async () => {
    const { openApiDocument } = await import('@documenso/trpc/server/open-api');

    expect(openApiDocument.info.title).toBe('Reeve.Sign v2 API');
    expect(openApiDocument.info.description).not.toMatch(/documenso/i);
    expect(JSON.stringify(openApiDocument)).not.toMatch(VENDOR);
  }, 60_000);

  it('v1 is titled Reeve.Sign and names no vendor', async () => {
    const { OpenAPIV1 } = await import('@documenso/api/v1/openapi');

    expect(OpenAPIV1.info.title).toBe('Reeve.Sign API');
    expect(OpenAPIV1.info.description).not.toMatch(/documenso/i);
    expect(JSON.stringify(OpenAPIV1)).not.toMatch(VENDOR);
  });

  it('/api/v1/openapi redirects to the same-origin JSON spec', async () => {
    const { tsRestHonoApp } = await import('@documenso/api/hono');

    const res = await tsRestHonoApp.request('/openapi');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/api/v1/openapi.json');
  });
});

describe('webhook test payloads', () => {
  it.each(Object.values(WebhookTriggerEvents))('%s sample names no vendor', async (event) => {
    const { generateSampleWebhookPayload } = await import(
      '@documenso/lib/server-only/webhooks/trigger/generate-sample-data'
    );

    expect(JSON.stringify(generateSampleWebhookPayload(event, 'https://example.com/hook'))).not.toMatch(/documenso/i);
  });
});

describe('reset-password email', () => {
  it('sends help requests to SUPPORT_EMAIL, not the vendor', async () => {
    const { renderWithI18N } = await import('@documenso/email/render');
    const { ResetPasswordTemplate } = await import('@documenso/email/templates/reset-password');
    const { SUPPORT_EMAIL } = await import('@documenso/lib/constants/app');

    i18n.load('en', {});
    i18n.activate('en');

    const html = await renderWithI18N(
      createElement(ResetPasswordTemplate, { userName: 'Ada', userEmail: 'ada@example.com' }),
      { i18n },
    );

    expect(html).toContain(`mailto:${SUPPORT_EMAIL}`);
    expect(html).not.toMatch(VENDOR);
  });

  it('a blank NEXT_PUBLIC_SUPPORT_EMAIL falls back instead of rendering a bare mailto:', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', '  ');

    const { SUPPORT_EMAIL } = await import('@documenso/lib/constants/app');

    expect(SUPPORT_EMAIL).toBe('support@meetreeve.com');

    vi.unstubAllEnvs();
  });
});

// Source ratchet: vendor hosts and `documenso-` download prefixes must not come
// back. Keep-list (internal, DEV-2905): license server, telemetry, service-account
// and synthetic-recipient emails, job/queue ids, the `documenso-branded` CSS scope.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const SCANNED_DIRS = [
  'apps/remix/app',
  'apps/remix/server',
  'packages/api',
  'packages/auth',
  'packages/ee',
  'packages/email',
  'packages/lib',
  'packages/trpc',
  'packages/ui',
];

const BANNED = [
  /docs\.documenso\.com/,
  /documen\.so\b/,
  /openapi-v1\.documenso\.com/,
  /stg-app\.documenso\.com/,
  /mailto:[^'"`\s]*@documenso\.com/,
  /filename:\s*['"`]documenso-/,
  // A rendered JSX label such as the default email sender `<SelectItem>Documenso</SelectItem>`.
  />\s*Documenso\s*</,
];

const listSources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (name === 'node_modules' || name === 'translations' || name.startsWith('.')) {
      return [];
    }

    if (statSync(path).isDirectory()) {
      return listSources(path);
    }

    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

describe('vendor link and filename ratchet', () => {
  const sources = SCANNED_DIRS.flatMap((dir) => listSources(resolve(REPO_ROOT, dir)));

  it('scans the app and packages', () => {
    expect(sources.length).toBeGreaterThan(500);
  });

  it('no source links a vendor host or downloads a documenso- file', () => {
    const hits = sources.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          BANNED.some((re) => re.test(line)) ? [`${relative(REPO_ROOT, path)}:${i + 1}: ${line.trim()}`] : [],
        ),
    );

    expect(hits).toEqual([]);
  });

  it('the remix app has no vendor email addresses', () => {
    const hits = sources
      .filter((path) => relative(REPO_ROOT, path).startsWith('apps/remix/app/'))
      .filter((path) => /@documenso\.com/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO_ROOT, path));

    expect(hits).toEqual([]);
  });
});
