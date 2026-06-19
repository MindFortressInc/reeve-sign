# Reeve.Sign — fork of Documenso

`reeve-sign` is **Reeve.Sign**, MindFortress's self-hosted e-signature product. It is a
fork of [Documenso](https://github.com/documenso/documenso), reskinned and wired into the
Reeve platform (shared Reeve Auth0 SSO, credit metering, Reeve.Comms email, Reeve.Drive
storage). Deployed at `sign.meetreeve.com`.

## Upstream pin

| | |
| --- | --- |
| Upstream | [documenso/documenso](https://github.com/documenso/documenso) |
| Pinned version | **v2.11.0** |
| Fork tracking | `main` |

## License & source (AGPL-3.0)

Documenso is licensed under **AGPL-3.0** ([`LICENSE`](./LICENSE)). Per AGPL §13, the
Corresponding Source of this running instance — including Reeve's modifications — is this
repository, which is **public**: <https://github.com/MindFortressInc/reeve-sign>. A
"Credits" link in the app surfaces this to users.

Reeve's proprietary suite (catalog, billing, Auth0, CRM) integrates with this service over
its API/SSO boundary and is **not** part of this AGPL work (see Linear DEV-635 — "Path A").

## Updating from upstream (rebase procedure)

This fork stays close to stock Documenso; our modifications live in contained seams
(OIDC/auth config, brand theming, metering hook, consent gate). To pull a new Documenso
release:

```bash
git remote add upstream https://github.com/documenso/documenso.git   # one-time
git fetch upstream --tags
git checkout -b chore/bump-documenso-vX.Y.Z main
git merge vX.Y.Z          # resolve conflicts in our seams (auth config, theme, footer)
npm install && npm run build && npm test
# update the "Pinned version" in this file, open a PR
```

Keep the diff against upstream minimal so future merges stay cheap.
