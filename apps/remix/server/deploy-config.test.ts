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
// error if unset/empty), `${VAR:-default}` / `${VAR-default}` (default if
// unset/empty), and `${VAR:+alt}` / `${VAR+alt}` (alternative value,
// substituted only when VAR IS set -- see docs.docker.com's Compose file
// interpolation reference). `deploy/compose.yml` started using the `:?` form
// (DEV-8976) and a resolver that only matched bare `${VAR}` left those refs
// unresolved, which both broke the YAML-parse assertion below (`${` still
// present) and made the secret-literal check flag the interpolation ref
// itself as a "literal" value. `resolveInterpolationRefs`/`isInterpolationRef`
// below are the single source of truth for this grammar -- reused by the
// secret-literal allowlist and by the dedicated per-form fixture tests, so a
// future regression to any one form (or an omitted one, e.g. `+`/`:+`) fails
// loudly in one place.
//
// CR PR #50 (minor, x2): variable names are case-sensitive in Compose and
// are not restricted to uppercase (docs.docker.com's interpolation reference
// gives `[_a-zA-Z][_a-zA-Z0-9]*`), so `VAR_NAME` accepts lower/mixed case and
// requires a letter/underscore first character -- `${9VAR}` is not a valid
// Compose reference and must be left untouched, not rewritten to
// `placeholder-9VAR`. Compose interpolation also nests to arbitrary depth
// (e.g. `${VAR:-${OTHER:-${THIRD}}}`, per the same reference); a single
// non-recursive regex can only special-case a fixed number of nesting
// levels (the prior version handled exactly one, so a second level of
// nesting -- e.g. VAR/OTHER/THIRD -- still left a dangling `${` behind), so
// resolution below walks the string tracking brace depth instead, which
// resolves any depth of nesting correctly.
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

// Finds the `${...}` starting at `text[start]` (which must be `$`) via
// brace-depth counting and returns the index just past its matching `}`,
// or -1 if `text[start]` isn't `${` or the braces never balance.
function matchInterpolationEnd(text: string, start: number): number {
  if (text[start] !== '$' || text[start + 1] !== '{') {
    return -1;
  }
  let depth = 1;
  let i = start + 2;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') {
      depth += 1;
    } else if (text[i] === '}') {
      depth -= 1;
    }
    i += 1;
  }
  return depth === 0 ? i : -1;
}

// Replaces every top-level `${...}` reference in `text` with
// `placeholder-<name>`, resolving nested references (of any depth) along
// the way since they fall inside the outer reference's span. A `${...}`
// whose name doesn't match Compose's grammar (e.g. digit-leading `${9VAR}`)
// is left untouched, matching real Compose's literal-string fallback.
function resolveInterpolationRefs(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const end = matchInterpolationEnd(text, i);
    const nameMatch = end === -1 ? null : text.slice(i + 2, end - 1).match(VAR_NAME);
    if (nameMatch) {
      result += `placeholder-${nameMatch[0]}`;
      i = end;
    } else {
      result += text[i];
      i += 1;
    }
  }
  return result;
}

// True iff `value` (already trimmed) is, in its entirety, exactly one
// `${...}` reference (which may itself nest to any depth) with a
// Compose-valid variable name -- not a literal, and not a ref with trailing
// text after its closing `}`.
//
// CR PR #50 (major): a naive `VAR_NAME.test(inner)` only checks that `inner`
// *starts with* a valid variable name -- since `VAR_NAME` isn't end-anchored,
// `${DATABASE_PASSWORD:-hard-coded-secret}` matched too, because
// "DATABASE_PASSWORD" is a valid prefix of "DATABASE_PASSWORD:-hard-coded-secret".
// That let the secret-literal check below treat the whole thing as a "pure
// ref" and skip it, even though the `:-`/`-` (default) and `:+`/`+`
// (alternative) modifiers each carry a VALUE that compose substitutes in
// place of the variable -- so a secret-shaped name with a hard-coded
// literal there is exactly the leak the check exists to catch. The `:?`/`?`
// (required) modifiers only carry an error MESSAGE, never a substituted
// value, so they can't leak a secret and are still treated as a pure ref.
function isInterpolationRef(value: string): boolean {
  const end = matchInterpolationEnd(value, 0);
  if (end !== value.length) {
    return false;
  }
  const inner = value.slice(2, end - 1);
  const nameMatch = inner.match(VAR_NAME);
  if (!nameMatch) {
    return false;
  }
  const rest = inner.slice(nameMatch[0].length);
  if (rest === '') {
    // Bare `${VAR}`.
    return true;
  }
  if (/^:?\?/.test(rest)) {
    // `${VAR:?err}` / `${VAR?err}` -- error message only, no substituted value.
    return true;
  }
  const modifierMatch = rest.match(/^(:-|-|:\+|\+)/);
  if (!modifierMatch) {
    // Unrecognized trailing content -- not a pure ref.
    return false;
  }
  const branch = rest.slice(modifierMatch[0].length);
  // The default/alternative branch is only safe if it is itself nothing but
  // a nested interpolation ref -- any literal text in it means this
  // assignment can resolve to a hard-coded value.
  return branch !== '' && isInterpolationRef(branch);
}

// Shared by the real `deploy/compose.yml` secret-literal check below and by
// its regression test, so the detection logic (what counts as a
// "secret-shaped name" and how a compose env-assignment line is parsed) is
// defined exactly once.
const SECRET_SHAPED_NAME =
  /(SECRET|PASSWORD|PASSPHRASE|TOKEN|API_KEY|DSN|ACCESS_KEY|ENCRYPTION|CREDENTIAL|(?:DATABASE|REDIS|SMTP)_URL$|_KEY$)/;
const ASSIGNMENT_LINE = /^\s*-?\s*([A-Z][A-Z0-9_]*)\s*[:=]\s*(.+)$/;

function findSecretLiteralOffenders(lines: string[]): string[] {
  const offenders: string[] = [];
  for (const line of lines) {
    const match = line.match(ASSIGNMENT_LINE);
    if (!match) {
      continue;
    }
    const [, name, value] = match;
    if (SECRET_SHAPED_NAME.test(name) && !isInterpolationRef(value.trim())) {
      offenders.push(line.trim());
    }
  }
  return offenders;
}

const resolvedCompose = resolveInterpolationRefs(compose);

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
    const offenders = findSecretLiteralOffenders(compose.split('\n'));

    expect(offenders).toEqual([]);
  });

  it('flags a secret-shaped var whose value is a hard-coded default behind a compose modifier (CR PR #50 major)', () => {
    // Regression for the bug fixed in `isInterpolationRef` above: before the
    // fix, `isInterpolationRef('${DATABASE_PASSWORD:-hard-coded-secret}')`
    // returned `true` (a non-end-anchored `VAR_NAME.test()` only checked
    // that the ref's body *started with* a valid variable name), so the
    // real-compose check just above would have silently accepted a
    // secret-shaped var whose `:-`/`-`/`:+`/`+` modifier smuggled in a
    // literal default/alternative value instead of only ever referencing
    // another variable.
    expect(isInterpolationRef('${DATABASE_PASSWORD:-hard-coded-secret}')).toBe(false);
    expect(isInterpolationRef('${DATABASE_PASSWORD-hard-coded-secret}')).toBe(false);
    expect(isInterpolationRef('${DATABASE_PASSWORD:+hard-coded-secret}')).toBe(false);
    expect(isInterpolationRef('${DATABASE_PASSWORD+hard-coded-secret}')).toBe(false);
    // A default/alternative branch that is itself only a nested ref (no
    // literal text) is still a pure interpolation ref, and required (`:?`/
    // `?`) modifiers only ever carry an error message, not a value.
    expect(isInterpolationRef('${DATABASE_PASSWORD:-${OTHER_VAR}}')).toBe(true);
    expect(isInterpolationRef('${DATABASE_PASSWORD:?DATABASE_PASSWORD is required}')).toBe(true);

    const offenders = findSecretLiteralOffenders([
      '      - DATABASE_PASSWORD=${DATABASE_PASSWORD:-hard-coded-secret}',
    ]);
    expect(offenders).toEqual(['- DATABASE_PASSWORD=${DATABASE_PASSWORD:-hard-coded-secret}']);
  });
});

describe('compose ${...} interpolation grammar (DEV-9828, folded into DEV-7617)', () => {
  // One fixture line per form the resolver above must handle, independent of
  // whatever forms `deploy/compose.yml` happens to use today -- so a future
  // narrowing of the interpolation grammar (e.g. back to bare `${VAR}` only,
  // or back to a fixed nesting depth) fails here immediately, rather than
  // silently, the next time someone adds a new form to the real compose
  // file.
  const resolve = (line: string) => resolveInterpolationRefs(line);

  it.each([
    ['bare reference', '${VAR}', 'VAR'],
    ['required, error on unset/empty (:?)', '${VAR:?VAR is required}', 'VAR'],
    ['required, error on unset only (?)', '${VAR?VAR is required}', 'VAR'],
    ['default if unset or empty (:-)', '${VAR:-default}', 'VAR'],
    ['default if unset only (-)', '${VAR-default}', 'VAR'],
    ['alternative value if set and non-empty (:+)', '${VAR:+alt}', 'VAR'],
    ['alternative value if set (+)', '${VAR+alt}', 'VAR'],
    // CR PR #50 (minor): lowercase/mixed-case names are valid Compose
    // variable names, not just the `deploy/compose.yml` convention of
    // all-caps.
    ['lowercase variable name', '${my_var}', 'my_var'],
    ['mixed-case variable name', '${My_Var}', 'My_Var'],
    // CR PR #50 (minor): Compose interpolation nests -- the default value
    // of an outer reference may itself be a `${...}` reference, to
    // arbitrary depth. A non-recursive regex can only special-case a fixed
    // number of nesting levels; brace-depth-aware resolution handles any
    // depth, so both a single level of nesting and the deeper
    // VAR/OTHER/THIRD case below must resolve fully, with no `${...}` left
    // behind.
    ['nested default value (recursive interpolation)', '${VAR:-${OTHER}}', 'VAR'],
    ['nested default-within-default', '${VAR:-${OTHER:-default}}', 'VAR'],
    ['nested default three levels deep', '${VAR:-${OTHER:-${THIRD}}}', 'VAR'],
  ])('resolves the %s form to a placeholder with no ${...} left behind', (_label, fixture, varName) => {
    const resolved = resolve(fixture);
    expect(resolved).toBe(`placeholder-${varName}`);
    expect(resolved).not.toContain('${');
  });

  // CR PR #50 (minor): Compose variable names must start with a letter or
  // underscore (`[_a-zA-Z][_a-zA-Z0-9]*`, per docs.docker.com's
  // interpolation reference) -- a digit-leading name like `${9VAR}` is not
  // a valid reference at all, so real Compose leaves it as a literal
  // string. The resolver must do the same, not rewrite it to
  // `placeholder-9VAR` -- doing so would let a malformed reference slip
  // past the YAML-parse and secret-literal checks above as if it had been
  // resolved.
  it('leaves a digit-leading name (not a valid Compose reference) untouched', () => {
    const resolved = resolve('${9VAR}');
    expect(resolved).toBe('${9VAR}');
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
