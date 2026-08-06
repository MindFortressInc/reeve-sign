# deploy/

These files are **truth**. The box is a render target, not a source.

Both files here existed in **no git repository at all** before DEV-5838 —
only as hand-edited files on a single EC2 box
(`ubuntu@reeve-ec2:/home/ubuntu/reeve-sign/`). Confirmed live:

```console
$ ssh reeve-ec2 "cd /home/ubuntu/reeve-sign && git status"
fatal: not a git repository (or any of the parent directories): .git
```

If that box were lost, so was this config — along with three undocumented
hand-edits made on 2026-07-26/27 (an image-pin bump, the Sentry env
passthrough, and the entire `gotenberg` service). This directory retires
that risk for the compose file and the nginx vhost. See the epic,
[DEV-4419](https://linear.app/mindfortress/issue/DEV-4419), for the full
`deploy.toml` / `[[config]]` contract these files will eventually be
declared under — that half (5b) is a separate, deferred ticket blocked on
DEV-5836. This PR is repatriation only: `git add`, nothing more.

## Repo → box path mapping

| Repo path | Box path | Host |
| --- | --- | --- |
| `deploy/compose.yml` | `/home/ubuntu/reeve-sign/compose.yml` | `reeve-ec2` |
| `deploy/nginx/sign.meetreeve.com.conf` | `/etc/nginx/sites-available/sign-meetreeve` (symlinked from `/etc/nginx/sites-enabled/sign-meetreeve`) | `reeve-ec2` |

The nginx filename mismatch is **intentional and permanent**: the box's
live site file is named `sign-meetreeve` — no `.conf` suffix, a hyphen
instead of dots — not `sign.meetreeve.com.conf`. The repo copy here uses
the conventional `<domain>.conf` name instead of mirroring the box's
filename. A future `[[config]]` entry (DEV-4419 T3, this ticket's deferred
5b half) maps `repo` → `box` explicitly, so the names never need to match —
but the mapping has to be written down somewhere a human finds it, which is
what this table is.

## How to verify repo == box

CI has no SSH access to the box, so live parity can't be enforced
automatically today — that gap closes with the T1/T2 host-state
collector/evaluator in DEV-4419. Until then, verify by hand:

```console
./deploy/check-drift.sh          # defaults to the reeve-ec2 SSH alias
./deploy/check-drift.sh <alias>  # override the SSH host alias
```

This is a **read-only** diff: it SSHes in, `cat`s (and for the nginx file,
`sudo cat`s) the two live files, and diffs them against the committed
copies. It writes nothing to the box — no `docker`, no `nginx -s reload`,
no file writes — and exits non-zero the moment either file differs. Run it
after any box-side change, and before/after any deploy that touches these
files.

Independent of live-box access, `apps/remix/server/deploy-config.test.ts`
(run via `npm run test --workspace=@documenso/remix`, which CI already
runs) asserts the **committed** copies parse cleanly and preserve the
load-bearing invariants called out in DEV-5838 — the moving `sha-<shortsha>`
image tag shape, the AWS VPC DNS resolver, the Sentry env passthrough, the
gotenberg service's flags/healthcheck/no-host-port-mapping, and the nginx
vhost's cert paths and HTTP→HTTPS redirect — and fails if a future hand-edit
ever pastes a literal secret value into either file instead of a `${VAR}`
reference. That test runs in CI; `check-drift.sh` does not (it needs the
box).

## The failure mode this exists to kill

Hand-editing the box directly — `vim compose.yml` over SSH, `sudo vim
/etc/nginx/sites-available/sign-meetreeve` — and never bringing the change
back into this repo. That is exactly how `compose.yml` ended up with three
undocumented edits and zero git history behind them. From now on: edit
`deploy/`, review, merge, then render the change onto the box (by hand
today; through the `[[config]]` contract once DEV-4419 T3/5b lands). Never
the other way around.

## Known pre-existing gaps (not fixed in this PR — out of scope for DEV-5838's 5a half)

* The image is pinned by a moving `sha-<shortsha>` **tag**, not a
  `@sha256:` **digest**. A tag can be force-pushed to point at a different
  image; a digest can't. Flagged here per the ticket, not changed here.
* `reeve-sign-gotenberg:8` has **no tracked acquisition path**: nothing in
  this repo (or any registry reference) builds, pulls, or tags that exact
  image name — it exists only in the box's local Docker image store, so a
  fresh host cannot materialize it from this repo alone. Fixing this means
  capturing the image's real provenance from the box (`docker image
  inspect reeve-sign-gotenberg:8` — is it a re-tag of upstream
  `gotenberg/gotenberg:8`, or a local build with modifications?) and
  committing either a `build:` config or a registry reference under the
  DEV-4419 `[[config]]` contract. Inventing a Dockerfile here without that
  inspection could silently diverge from what production actually runs, so
  it is flagged, not fixed, in this repatriation-only PR.
* `deploy.toml`, `[[config]]`, and `[[runtime_env]]` (including the
  `NODE_ENV` `fail_boot` gap that caused prod Sentry to report
  `environment: development`) are DEV-5838's 5b half, deferred pending
  DEV-5836.
