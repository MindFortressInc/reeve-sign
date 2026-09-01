#!/usr/bin/env python3
"""Guard: no `pull_request`-triggered job that checks out code may run on a
self-hosted/fleet runner.

DEV-9724: reeve-sign is a PUBLIC repo that accepts external fork PRs. A
`pull_request`-triggered job that runs `actions/checkout` executes the PR
HEAD's own code (fork-authored, untrusted). Pointing such a job's `runs-on:`
at a self-hosted/fleet label would run that untrusted code on our own
infrastructure — this is a hard rule (see DEV-9722/DEV-9724), not a style
preference, so it is enforced here rather than left to review discipline.

This is deliberately narrow and literal-only, matching how this repo actually
sets `runs-on:` today: every `pull_request`-triggered job that checks out
code (ci.yml, codeql-analysis.yml, e2e-tests.yml, pr-review-reminder.yml) is
a single literal string, `ubuntu-latest`. A list of literal strings is also
accepted (GitHub allows `runs-on:` to be a label list), since that shape is
just as statically resolvable. Anything this script cannot resolve to a
known-safe literal (an expression like `${{ matrix.os }}`, a variable
reference, an unrecognized string) is treated as a FINDING, not silently
passed: a job on the `pull_request` + `actions/checkout` path fails closed
here. A job that delegates to a local reusable workflow (`uses:
./.github/workflows/x.yml`) is similarly unresolved rather than trusted --
this script does not follow that reference, so it flags the delegation for
manual verification instead of silently passing it (CR CLI review, DEV-9724).

Known scope limit: a LOCAL COMPOSITE ACTION (`uses: ./.github/actions/x`)
is not recursively inspected for a checkout of its own -- as of this
writing none of reeve-sign's composite actions do (verified: no
`actions/checkout` under `.github/actions/**`), matching the same
non-recursive scope `lint_composite_actions.py` already accepts for that
directory.

Usage: check_fork_pr_runner_safety.py [workflows_dir]
(directory arg is for testing against a fixture dir; defaults to
`.github/workflows`, matching lint_composite_actions.py's convention.)
"""
import sys
from pathlib import Path

import yaml

# Currently-live GitHub-hosted runner image labels. Anything NOT in this set
# is treated as a self-hosted/fleet label for the purpose of this guard --
# reeve-sign has zero fleet labels today (DEV-9724 premise), so this
# allowlist only needs to cover GitHub's own hosted images, not our fleet's
# names.
#
# CR CLI (major, potential_issue): an earlier version of this list carried
# RETIRED GitHub-hosted labels (ubuntu-20.04, windows-2019, macos-13*,
# macos-latest-xl). A retired label is not reserved forever -- a self-hosted
# runner could register under that exact name, and this guard would then
# wave through a fork-PR checkout job routed to it as "GitHub-hosted". Keep
# this list to labels GitHub currently serves; when GitHub retires one, drop
# it here too rather than leaving a stale entry that quietly becomes a
# spoofable bypass.
#
# Cross-checked 2026-09-01 against actionlint 1.7.12's own `runner-label`
# rule (`actionlint <any-bad-label>.yml` prints its exact known-label list;
# same version this repo's actionlint.yml pins) -- the authority to re-check
# against when this needs updating. Excludes actionlint's generic
# self-hosted-adjacent labels (`self-hosted`, `x64`, `arm`, `arm64`, `linux`,
# `macos`, `windows`): those are automatic labels every runner (hosted OR
# self-hosted) carries, not a specific hosted image, so treating them as
# "safe" would be its own bypass.
GITHUB_HOSTED_LABELS = frozenset(
    {
        "ubuntu-latest",
        "ubuntu-latest-4-cores",
        "ubuntu-latest-8-cores",
        "ubuntu-latest-16-cores",
        "ubuntu-24.04",
        "ubuntu-24.04-arm",
        "ubuntu-22.04",
        "ubuntu-22.04-arm",
        "ubuntu-slim",
        "windows-latest",
        "windows-latest-8-cores",
        "windows-2025",
        "windows-2025-vs2026",
        "windows-2022",
        "windows-11-arm",
        "macos-latest",
        "macos-latest-xlarge",
        "macos-latest-large",
        "macos-26",
        "macos-26-intel",
        "macos-26-xlarge",
        "macos-26-large",
        "macos-15",
        "macos-15-intel",
        "macos-15-xlarge",
        "macos-15-large",
        "macos-14",
        "macos-14-xlarge",
        "macos-14-large",
    }
)


def event_names(on_value):
    """Normalize a workflow's top-level `on:` into a set of event names.

    `on:` can be a bare string (`on: pull_request`), a list of strings
    (`on: [push, pull_request]`), or a mapping of event -> config/null.
    """
    if isinstance(on_value, str):
        return {on_value}
    if isinstance(on_value, list):
        return {v for v in on_value if isinstance(v, str)}
    if isinstance(on_value, dict):
        return set(on_value.keys())
    return set()


def uses_checkout(steps):
    if not isinstance(steps, list):
        return False
    for step in steps:
        if not isinstance(step, dict):
            continue
        uses = step.get("uses")
        if isinstance(uses, str) and uses.split("@", 1)[0].strip() == "actions/checkout":
            return True
    return False


def local_reusable_workflow_call(job):
    """A job-level `uses: ./.github/workflows/x.yml` (reusable workflow call).

    Such a job has no `steps:`/`runs-on:` of its own -- the CALLED file's own
    jobs set those. This script does not follow the reference (that file may
    itself be scanned separately, but only if it independently declares
    `pull_request` -- a `workflow_call`-only file otherwise falls outside the
    per-file `pull_request` filter above even when it is reachable FROM a
    pull_request-triggered caller). Rather than silently trust an unfollowed
    reference, treat it as unresolved and fail closed (CR CLI review, DEV-9724).
    """
    uses = job.get("uses")
    return isinstance(uses, str) and uses.startswith("./")


def runs_on_findings(where, runs_on):
    """Return a list of finding strings for a `runs-on:` value, or [] if safe.

    Fails closed: only a literal string (or list of literal strings) that is
    entirely within GITHUB_HOSTED_LABELS is accepted. An expression
    (`${{ ... }}`), a bare `self-hosted`, or an unrecognized literal is
    flagged — a `pull_request` + `actions/checkout` job has no business
    resolving to anything this script cannot vouch for.
    """
    if runs_on is None:
        # No `runs-on:` on a job usually means it's a reusable-workflow call
        # (`uses: ./.github/workflows/x.yml`), which has no runner of its own
        # here. Nothing to flag.
        return []
    labels = runs_on if isinstance(runs_on, list) else [runs_on]
    findings = []
    for label in labels:
        if not isinstance(label, str):
            findings.append(f"{where}: runs-on entry {label!r} is not a string")
            continue
        if label not in GITHUB_HOSTED_LABELS:
            findings.append(
                f"{where}: runs-on {label!r} is not a recognized GitHub-hosted "
                "label — a pull_request job that checks out code must not run "
                "on a self-hosted/fleet runner (fork PRs execute untrusted code)"
            )
    return findings


def main(workflows_dir):
    root = Path(workflows_dir)
    paths = sorted(list(root.glob("*.yml")) + list(root.glob("*.yaml")))
    if not paths:
        print(f"no workflow files found under {root}", file=sys.stderr)
        return 0

    status = 0
    checked_jobs = 0
    for path in paths:
        try:
            data = yaml.safe_load(path.read_text()) or {}
        except yaml.YAMLError as exc:
            print(f"{path}: not valid YAML: {exc}")
            status = 1
            continue
        if not isinstance(data, dict):
            continue

        # PyYAML parses the unquoted top-level `on:` key as boolean True
        # (YAML 1.1 truthy scalar) rather than the string "on" — handle both.
        on_value = data.get("on", data.get(True))
        events = event_names(on_value)
        if "pull_request" not in events:
            continue

        jobs = data.get("jobs")
        if not isinstance(jobs, dict):
            continue
        for job_name, job in jobs.items():
            if not isinstance(job, dict):
                continue
            checked_jobs += 1
            where = f"{path}: job `{job_name}`"
            if local_reusable_workflow_call(job):
                print(
                    f"{where}: delegates to local reusable workflow "
                    f"{job['uses']!r}, which this script does not follow -- "
                    "manually verify that file never combines "
                    "actions/checkout with a self-hosted/fleet runs-on"
                )
                status = 1
                continue
            if not uses_checkout(job.get("steps")):
                continue
            for finding in runs_on_findings(where, job.get("runs-on")):
                print(finding)
                status = 1

    print(f"checked {len(paths)} workflow(s), {checked_jobs} pull_request job(s) considered")
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else ".github/workflows"))
