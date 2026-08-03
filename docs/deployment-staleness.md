# Reeve.Sign deployment & image-staleness monitoring (DEV-5793)

Prod reeve-sign once drifted **18 commits / 5 weeks** behind `main` with zero
signal. This doc records why that can happen, how to deploy manually, and what
the in-repo staleness monitor does (and deliberately does not) catch.

## The GHCR-unauthorized constraint (do not rediscover this)

From `.github/workflows/publish.yml`:

> The GHCR package visibility is private (configured separately from the public repo);
> the reeve-ec2 host has no read:packages credential.
> The `export_tarball` mode pulls the already-published image inside CI (where
> GITHUB_TOKEN can read same-org packages) and uploads it as a downloadable
> artifact, so the image can be `docker load`ed onto the host without a registry
> login.

In other words: the EC2 box **cannot `docker pull` from GHCR**. Prod deploys by
a GHCR image tag pinned in a `compose.yml` that lives **only on the EC2 box**
(the in-repo `docker/production/compose.yml` still pins upstream
`documenso/documenso:latest` and is **not** the prod file). The image reaches
the box as a tarball, never via a registry pull.

## Manual deploy runbook

1. **Build & publish** the image (pushes both a moving tag and an immutable
   `sha-<shortsha>` tag):

   ```bash
   gh workflow run publish.yml --ref main -f tag=<tag>
   ```

2. **Export the tarball** (runs inside CI where `GITHUB_TOKEN` can read
   same-org packages):

   ```bash
   gh workflow run publish.yml --ref main -f export_tarball=true -f tag=<tag>
   ```

3. **Download the artifact** (`reeve-sign-image` → `reeve-sign-image.tar.gz`)
   from the completed run, e.g. `gh run download <run-id> -n reeve-sign-image`.

4. **Copy to the box**: `scp reeve-sign-image.tar.gz <reeve-ec2-host>:`.

5. **Load it on the box**: `docker load < reeve-sign-image.tar.gz`.

6. **Bump the tag** in the box-local `compose.yml` to the exact image tag you
   loaded (prefer the immutable `sha-<shortsha>` tag so the running version is
   auditable).

7. **Restart**: `docker compose up -d`.

## The staleness monitor (`.github/workflows/image-staleness.yml`)

Runs every 6 hours (and on manual dispatch). It:

1. Lists the GHCR container package versions for org `MindFortressInc`,
   package `reeve-sign`, and finds the most recent version carrying an
   immutable `sha-<shortsha>` tag (`publish.yml` always pushes one).
2. Resolves that short sha against full repo history and computes
   `git rev-list --count <image-sha>..origin/main`.
3. Raises the alarm when **any** of these holds:
   - the newest published image sha is unknown or unresolvable against repo
     history;
   - `main` is ahead of the image by more than `COMMITS_THRESHOLD`
     (default **5**) commits;
   - the newest sha-tagged version was published more than `DAYS_THRESHOLD`
     (default **7**) days before the latest `main` commit.

The alarm is a single idempotent GitHub issue titled
**"reeve-sign prod image is stale"** with label `image-staleness` (updated in
place while stale, closed with a comment when the check passes again), plus an
optional Slack post — sent only if a `SLACK_WEBHOOK_URL` repo secret is
configured, silently skipped otherwise. The workflow run itself also fails
(exit 1) while stale, so the repo shows a red scheduled run.

Thresholds are workflow `env` values (`COMMITS_THRESHOLD`, `DAYS_THRESHOLD`);
tune them in the workflow file.

## Known blind spot: merged-vs-published, not published-vs-running

The monitor watches whether the newest **published** image keeps up with
`main`. It cannot see what is actually **running** on the EC2 box: the app
exposes no version/SHA endpoint, the sha is not baked into the image, and the
prod `compose.yml` lives only on the box. **An image that was published but
never loaded on the box is invisible to this monitor.**

Closing that gap requires ops work outside this repo — DEV-5793 Option 1
(give the box a `read:packages` credential so it can pull and report) or
Option 2 (CD-over-SSH that pushes deploys and records what ran). This monitor
is Option 3, the floor: it is the thing that would have caught the original
18-commit drift.
