import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

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

const REPO_ROOT = resolve(__dirname, '../../..');
const COMPOSE_PATH = resolve(REPO_ROOT, 'deploy/compose.yml');
const NGINX_PATH = resolve(REPO_ROOT, 'deploy/nginx/sign.meetreeve.com.conf');

const compose = readFileSync(COMPOSE_PATH, 'utf8');
const nginx = readFileSync(NGINX_PATH, 'utf8');

describe('deploy/compose.yml (repatriated from the box, DEV-5838)', () => {
  it('contains no tab characters (YAML forbids tabs for indentation)', () => {
    expect(compose).not.toMatch(/\t/);
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
    for (const flag of [
      '--api-enable-basic-auth',
      '--libreoffice-deny-private-ips',
      '--libreoffice-auto-start',
      '--libreoffice-start-timeout=300s',
      '--api-timeout=500s',
      '--pdfengines-disable-routes',
      '--webhook-disable',
    ]) {
      expect(compose).toContain(flag);
    }
  });

  it('healthchecks gotenberg on /health', () => {
    expect(compose).toMatch(/curl.*http:\/\/localhost:3000\/health/);
  });

  it('never assigns a secret-shaped env var name to a literal value -- only ${VAR} refs', () => {
    // Automated form of the epic's hard security rule ("never commit a
    // secret VALUE"): every env line whose NAME looks like a secret must
    // use ${...} interpolation, never a literal. Catches a future
    // hand-edit that pastes a real DSN/token/password into this file.
    const secretShapedName = /(SECRET|PASSWORD|PASSPHRASE|TOKEN|API_KEY|DSN|ACCESS_KEY)/;
    const assignmentLine = /^\s*-?\s*([A-Z][A-Z0-9_]*)\s*[:=]\s*(.+)$/;

    const offenders: string[] = [];
    for (const line of compose.split('\n')) {
      const match = line.match(assignmentLine);
      if (!match) continue;
      const [, name, value] = match;
      if (secretShapedName.test(name) && !/^\$\{[A-Z0-9_]+\}$/.test(value.trim())) {
        offenders.push(line.trim());
      }
    }

    expect(offenders).toEqual([]);
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
    expect(nginx).not.toMatch(/:\/\/[^/\s]+:[^/\s@]+@/);
    expect(nginx).not.toMatch(/-----BEGIN/);
  });
});
