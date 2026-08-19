#!/usr/bin/env python3
"""Validate `runs.steps` in the repo's composite actions.

DEV-8818 / CR PR #33: `actionlint` reads the referenced local-action METADATA
(so a workflow passing an input the action does not declare is caught), but it
does not lint the `runs.steps` bodies under `.github/actions/**`. The workflow
triggers on that path, so without this the filter promises coverage the linter
does not deliver.

Only the failures GitHub reports at RUN time — i.e. the silent-by-construction
class DEV-8818 exists to close — are checked here:
  * a composite step with `run:` and no `shell:` (hard runtime error)
  * a step with both `run:` and `uses:`, or with neither
  * `runs.steps` present without `using: composite`
"""
import sys
from pathlib import Path

import yaml

status = 0
metadata = sorted(Path(".github/actions").glob("**/action.y*ml"))
if not metadata:
    print("no composite actions found under .github/actions", file=sys.stderr)
    sys.exit(0)

for path in metadata:
    # A malformed file is a lint FINDING, not a crash: an unhandled YAMLError
    # or AttributeError aborts the whole run on the first bad file, so the
    # remaining actions go unchecked and the log shows a traceback instead of
    # the offending path (CR CLI #33).
    try:
        data = yaml.safe_load(path.read_text()) or {}
    except yaml.YAMLError as exc:
        print(f"{path}: not valid YAML: {exc}")
        status = 1
        continue
    if not isinstance(data, dict):
        print(f"{path}: top level must be a mapping, got {type(data).__name__}")
        status = 1
        continue
    runs = data.get("runs") or {}
    if not isinstance(runs, dict):
        print(f"{path}: `runs` must be a mapping, got {type(runs).__name__}")
        status = 1
        continue
    steps = runs.get("steps")
    if steps is None:
        continue
    if not isinstance(steps, list):
        print(f"{path}: `runs.steps` must be a list, got {type(steps).__name__}")
        status = 1
        continue
    if runs.get("using") != "composite":
        print(f"{path}: runs.steps requires `using: composite`, got {runs.get('using')!r}")
        status = 1
    for i, step in enumerate(steps, 1):
        if not isinstance(step, dict):
            print(f"{path}: step {i} must be a mapping, got {type(step).__name__}")
            status = 1
            continue
        where = f"{path}: step {i} ({step.get('name', 'unnamed')})"
        has_run, has_uses = "run" in step, "uses" in step
        if has_run and has_uses:
            print(f"{where}: has both `run` and `uses`; a step must use exactly one")
            status = 1
        elif not has_run and not has_uses:
            print(f"{where}: has neither `run` nor `uses`")
            status = 1
        if has_run and not step.get("shell"):
            print(f"{where}: `run` in a composite action requires an explicit `shell`")
            status = 1

print(f"checked {len(metadata)} composite action(s)")
sys.exit(status)
