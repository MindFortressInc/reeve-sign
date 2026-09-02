import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

// DEV-5838: `deploy/compose.yml` and `deploy/nginx/sign.meetreeve.com.conf`
// are byte-faithful copies of the two production runtime-config files that,
// before this PR, existed in NO git repository at all -- only on the box,
// at /home/ubuntu/reeve-sign/compose.yml and
// /etc/nginx/sites-available/sign-meetreeve. See deploy/README.md for the
// full repo -> box mapping and how a human re-verifies live parity
// (deploy/check-drift.sh) -- that script needs SSH access to the box, which
// CI does not have, so this test asserts the shape of the *committed*
// copies instead: that they preserve the load-bearing invariants called
// out in the ticket, and that no future hand-edit slips a literal secret
// value into either file.
//
// Do not "fix" anything this test flags as a pre-existing gap (e.g. the
// tag-not-digest image pin) -- that is deliberate scope, documented in
// deploy/README.md's "Known pre-existing gaps" section.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPOSE_PATH = resolve(REPO_ROOT, 'deploy/compose.yml');
const NGINX_PATH = resolve(REPO_ROOT, 'deploy/nginx/sign.meetreeve.com.conf');

const compose = readFileSync(COMPOSE_PATH, 'utf8');
const nginx = readFileSync(NGINX_PATH, 'utf8');

// Compose-style `${VAR}` references resolved with non-secret placeholders,
// so the *resulting* document (what compose would actually materialize)
// can be parsed and structurally validated in CI -- not just the raw text.
//
// DEV-7617/DEV-9828: compose's interpolation grammar is wider than the bare
// `${VAR}` form -- it also supports `${VAR:?err}` / `${VAR?err}` (required,
// error if unset/empty) and `${VAR:-default}` / `${VAR-default}` (default if
// unset/empty). `deploy/compose.yml` started using the `:?` form (DEV-8976)
// and a resolver that only matched bare `${VAR}` left those refs unresolved,
// which both broke the YAML-parse assertion below (`${` still present) and
// made the secret-literal check flag the interpolation ref itself as a
// "literal" value. `INTERPOLATION_REF` is the single source of truth for
// this grammar -- reused below by the secret-literal allowlist and by the
// dedicated per-form fixture tests, so a future regression to any one form
// fails loudly in one place.
const INTERPOLATION_REF = /\$\{([A-Z0-9_]+)(?:(?::?[-?])[^}]*)?\}/;
const resolvedCompose = compose.replace(new RegExp(INTERPOLATION_REF.source, 'g'), 'placeholder-$1');

type ComposeDocument = {
  name?: string;
  services?: Record<
    string,
    {
      image?: string;
      ports?: string[];
      environment?: unknown;
      command?: string[];
      healthcheck?: { test?: string[] };
    }
  >;
};

const parseCompose = () => parseYaml(resolvedCompose) as ComposeDocument;

describe('deploy/compose.yml (repatriated from the box, DEV-5838)', () => {
  it('contains no tab characters (YAML forbids tabs for indentation)', () => {
    expect(compose).not.toMatch(/\t/);
  });

  it('parses as valid YAML once ${...} references are resolved with placeholders', () => {
    // CI has no docker binary, so `docker compose config` is out of reach;
    // a strict YAML parse of the placeholder-resolved document is the
    // CI-available validation, plus structural assertions on the result.
    const parsed = parseCompose();

    expect(parsed.name).toBe('reeve-sign');
    expect(parsed.services).toBeDefined();
    expect(Object.keys(parsed.services ?? {}).sort()).toEqual(['documenso', 'gotenberg']);

    const documenso = parsed.services?.documenso;
    expect(documenso?.image).toMatch(/^ghcr\.io\/mindfortressinc\/reeve-sign:sha-[0-9a-f]{6,}$/);
    expect(documenso?.ports).toEqual(['127.0.0.1:3000:3000']);

    // No unresolved `${...}` may survive placeholder resolution -- an
    // unresolved reference means a malformed interpolation the raw-text
    // checks below would silently skip.
    expect(resolvedCompose).not.toContain('${');
  });

  it('pins the reeve-sign image to a moving sha-<shortsha> tag', () => {
    // Tag, not @sha256 digest -- a known, documented gap (see
    // deploy/README.md), not something to silently "improve" here.
    expect(compose).toMatch(/image:\s*ghcr\.io\/mindfortressinc\/reeve-sign:sha-[0-9a-f]{6,}\s*$/m);
  });

  it('sets the AWS VPC DNS resolver so the RDS hostname resolves inside the VPC', () => {
    expect(compose).toMatch(/dns:\s*\n\s*-\s*169\.254\.169\.253/);
  });

  it('passes SENTRY_DSN and NEXT_PUBLIC_SENTRY_DSN through the explicit environment: block', () => {
    // DEV-2900 gotcha: Compose does not forward host env into a container
    // unless the var is named in an explicit `environment:` block.
    expect(compose).toMatch(/-\s*SENTRY_DSN=\$\{SENTRY_DSN\}/);
    expect(compose).toMatch(/-\s*NEXT_PUBLIC_SENTRY_DSN=\$\{NEXT_PUBLIC_SENTRY_DSN\}/);
  });

  it('mounts cert.p12 read-only for document signing', () => {
    expect(compose).toContain('/home/ubuntu/reeve-sign/cert.p12:/opt/documenso/cert.p12:ro');
  });

  it('defines the gotenberg service with no host port mapping (compose-internal only)', () => {
    const gotenbergBlock = compose.slice(compose.indexOf('\n  gotenberg:'));
    expect(gotenbergBlock).not.toBe('');
    expect(gotenbergBlock).toContain('image: reeve-sign-gotenberg:8');
    expect(gotenbergBlock).not.toMatch(/^\s{2,4}ports:/m);
  });

  it('configures gotenberg with the required conversion flags', () => {
    // Assert against the parsed gotenberg service's own `command` list, not
    // the whole compose text, so a flag on some other service (or in a
    // comment) can never satisfy this test.
    const command = parseCompose().services?.gotenberg?.command;
    expect(command?.[0]).toBe('gotenberg');
    for (const flag of [
      '--api-enable-basic-auth',
      '--libreoffice-deny-private-ips',
      '--libreoffice-auto-start',
      '--libreoffice-start-timeout=300s',
      '--api-timeout=500s',
      '--pdfengines-disable-routes',
      '--webhook-disable',
    ]) {
      expect(command).toContain(flag);
    }
  });

  it('healthchecks gotenberg on /health', () => {
    const healthcheckTest = parseCompose().services?.gotenberg?.healthcheck?.test ?? [];
    expect(healthcheckTest).toContain('curl');
    expect(healthcheckTest).toContain('http://localhost:3000/health');
  });

  it('never assigns a secret-shaped env var name to a literal value -- only variable-interpolation refs', () => {
    // Automated form of the epic's hard security rule ("never commit a
    // secret VALUE"): every env line whose NAME looks like a secret must
    // use ${...} interpolation, never a literal. Catches a future
    // hand-edit that pastes a real DSN/token/password into this file.
    // `ENCRYPTION` and the standalone `_KEY` suffix catch encryption keys
    // (NEXT_PRIVATE_ENCRYPTION_KEY, NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY)
    // that the named-credential words alone would miss. The `_URL` suffixes
    // catch connection strings (DATABASE_URL/REDIS_URL/SMTP_URL) whose
    // literal values typically embed user:password credentials.
    const secretShapedName =
      /(SECRET|PASSWORD|PASSPHRASE|TOKEN|API_KEY|DSN|ACCESS_KEY|ENCRYPTION|CREDENTIAL|(?:DATABASE|REDIS|SMTP)_URL$|_KEY$)/;
    const assignmentLine = /^\s*-?\s*([A-Z][A-Z0-9_]*)\s*[:=]\s*(.+)$/;
    // Anchored, non-global sibling of INTERPOLATION_REF -- deliberately not
    // `g`-flagged since it is reused across `.test()` calls below and a
    // global regex's `.test()` mutates `lastIndex`, silently alternating
    // matched/unmatched on repeat calls.
    const isInterpolationRef = new RegExp(`^${INTERPOLATION_REF.source}$`);

    const offenders: string[] = [];
    for (const line of compose.split('\n')) {
      const match = line.match(assignmentLine);
      if (!match) {
        continue;
      }
      const [, name, value] = match;
      if (secretShapedName.test(name) && !isInterpolationRef.test(value.trim())) {
        offenders.push(line.trim());
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('compose ${...} interpolation grammar (DEV-9828, folded into DEV-7617)', () => {
  // One fixture line per form the resolver above must handle, independent of
  // whatever forms `deploy/compose.yml` happens to use today -- so a future
  // narrowing of INTERPOLATION_REF (e.g. back to bare `${VAR}` only) fails
  // here immediately, rather than silently, the next time someone adds a new
  // form to the real compose file.
  const resolve = (line: string) => line.replace(new RegExp(INTERPOLATION_REF.source, 'g'), 'placeholder-$1');

  it.each([
    ['bare reference', '${VAR}'],
    ['required, error on unset/empty (:?)', '${VAR:?VAR is required}'],
    ['required, error on unset only (?)', '${VAR?VAR is required}'],
    ['default if unset or empty (:-)', '${VAR:-default}'],
    ['default if unset only (-)', '${VAR-default}'],
  ])('resolves the %s form to a placeholder with no ${...} left behind', (_label, fixture) => {
    const resolved = resolve(fixture);
    expect(resolved).toBe('placeholder-VAR');
    expect(resolved).not.toContain('${');
  });
});

describe('deploy/nginx/sign.meetreeve.com.conf (repatriated from the box, DEV-5838)', () => {
  it('serves the sign.meetreeve.com vhost on 443 with the Certbot-managed cert paths', () => {
    expect(nginx).toContain('server_name sign.meetreeve.com;');
    expect(nginx).toContain('listen 443 ssl;');
    expect(nginx).toContain('ssl_certificate /etc/letsencrypt/live/sign.meetreeve.com/fullchain.pem;');
    expect(nginx).toContain('ssl_certificate_key /etc/letsencrypt/live/sign.meetreeve.com/privkey.pem;');
  });

  it('proxies to the app container on 127.0.0.1:3000', () => {
    expect(nginx).toContain('proxy_pass http://127.0.0.1:3000;');
  });

  it('redirects plain HTTP to HTTPS', () => {
    expect(nginx).toMatch(/return 301 https:\/\/\$host\$request_uri;/);
  });

  it('never embeds a literal credential (no inline user:pass@, Authorization/Bearer header, or key block)', () => {
    expect(nginx).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/);
    // A literal (non-variable) value on a proxy_set_header Authorization
    // line -- e.g. `proxy_set_header Authorization "Basic <creds>";` --
    // would be a credential baked into the vhost. `$`-prefixed values
    // (nginx variables) are fine and excluded via the negative lookahead.
    expect(nginx).not.toMatch(/^\s*proxy_set_header\s+Authorization\s+(?![^;]*\$)[^;]*\S[^;]*;/im);
    expect(nginx).not.toMatch(/:\/\/[^/\s]+:[^/\s@]+@/);
    expect(nginx).not.toMatch(/-----BEGIN/);
  });
});
