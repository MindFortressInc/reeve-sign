# Reeve.Sign — fork of Documenso

`reeve-sign` is **Reeve.Sign**, MindFortress's self-hosted e-signature product. It is a
fork of [Documenso](https://github.com/documenso/documenso), reskinned and wired into the
Reeve platform (shared Reeve Auth0 SSO, credit metering, Reeve.Comms email, Reeve.Drive
storage). Deployed at `sign.meetreeve.com`.

## Fork point

| | |
| --- | --- |
| Upstream | [documenso/documenso](https://github.com/documenso/documenso) |
| Forked from | **v2.11.0** (2026-05-13) |
| Tracking | none — permanent fork, see below |

`v2.11.0` records where this tree came from. It is **not** a version we track, and it is not
a number that gets bumped on a schedule.

## License & source (AGPL-3.0)

Documenso is licensed under **AGPL-3.0** ([`LICENSE`](./LICENSE)). Per AGPL §13, the
Corresponding Source of this running instance — including Reeve's modifications — is this
repository, which is **public**: <https://github.com/MindFortressInc/reeve-sign>. A
"Credits" link in the app surfaces this to users.

Reeve's proprietary suite (catalog, billing, Auth0, CRM) integrates with this service over
its API/SSO boundary and is **not** part of this AGPL work (see Linear DEV-635 — "Path A").

## Relationship to upstream: permanent fork

**We do not rebase or merge upstream releases.** `reeve-sign` diverged from Documenso at
v2.11.0 and stays diverged. Upstream is a source we borrow from deliberately, not a branch
we follow.

This is the policy the repo has always actually followed — it is now written down.
Measured 2026-09-22: zero upstream syncs in the fork's history, upstream seven releases
ahead (v2.18.0), and **284 files / +13,873 / −1,469** changed against the v2.11.0
snapshot. An earlier version of this file described a merge procedure nobody had run and
asked readers to "keep the diff against upstream minimal" — advice that stopped matching
the tree long ago, and that was twice cited as a reason not to touch inherited code
(DEV-659, DEV-12067) as though a live merge cadence depended on it.

**What this means in practice:**

- Fix things here. A bug in inherited Documenso code is ours to fix directly — don't wait
  for upstream, and don't avoid a change because it widens the diff. (Upstream `main` still
  ships the broken `minio/minio` image that took our CI red; we fixed it in an afternoon.)
- Local divergence is expected, not debt. Inherited conventions (`AGENTS.md`,
  `CODE_STYLE.md`) are ours to keep or overrule on their own merits.
- Nothing in the release cadence obliges us. We take an upstream feature only if we
  actually want it, at a time we choose.

## Taking something from upstream (deliberate cherry-pick)

The one thing worth watching upstream for is **security fixes** — this service handles
signed legal documents and p12 signing certs. Watch
[releases](https://github.com/documenso/documenso/releases) and
[security advisories](https://github.com/documenso/documenso/security/advisories); when
something matters, port it on purpose:

```bash
git remote add upstream https://github.com/documenso/documenso.git   # one-time
git fetch upstream --tags
git checkout -b matt/dev-NNNN-<slug> main
git cherry-pick -x <upstream-sha>   # -x records the source sha in the message
# expect conflicts: our tree is far from upstream's. Port by hand when the pick is a mess —
# the goal is the FIX, not the patch.
npm install && npm run build && npm test
```

File a ticket first and reference the upstream commit or advisory in the PR, so the
provenance of anything borrowed is recorded. Do not update the fork-point version above:
the fork point does not move because we took one patch.

The cost of this model is real and accepted — the further the trees drift, the more a
cherry-pick becomes a hand-port. That is cheaper than a merge cadence nobody performs.
