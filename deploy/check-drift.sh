#!/usr/bin/env bash
# deploy/check-drift.sh
#
# DEV-5838: verifies the committed copies under deploy/ still match what is
# actually running on the box. The repo is truth; this script never writes
# to the box -- it only reads the two live files and diffs them against the
# committed copies. See deploy/README.md for the full repo -> box mapping
# and why this can't run in CI (no SSH access to the box from CI today).
#
# Usage:
#   deploy/check-drift.sh              # uses the "reeve-ec2" SSH alias
#   deploy/check-drift.sh some-alias   # overrides the SSH host alias
#
# Exit status: 0 if both files match the box, 1 if either has drifted or
# either the SSH connection or a remote read fails.

set -euo pipefail

HOST="${1:-reeve-ec2}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

status=0

echo "Checking deploy/ against ${HOST} (read-only)..."
echo

echo "== compose.yml =="
echo "   repo: ${REPO_ROOT}/deploy/compose.yml"
echo "   box:  ${HOST}:/home/ubuntu/reeve-sign/compose.yml"
if diff -u "${REPO_ROOT}/deploy/compose.yml" <(ssh "${HOST}" "cat /home/ubuntu/reeve-sign/compose.yml"); then
  echo "OK: deploy/compose.yml matches the box."
else
  echo "DRIFT: deploy/compose.yml differs from /home/ubuntu/reeve-sign/compose.yml on ${HOST}" >&2
  status=1
fi
echo

echo "== nginx sign.meetreeve.com.conf =="
echo "   repo: ${REPO_ROOT}/deploy/nginx/sign.meetreeve.com.conf"
echo "   box:  ${HOST}:/etc/nginx/sites-available/sign-meetreeve"
if diff -u "${REPO_ROOT}/deploy/nginx/sign.meetreeve.com.conf" <(ssh "${HOST}" "sudo cat /etc/nginx/sites-available/sign-meetreeve"); then
  echo "OK: deploy/nginx/sign.meetreeve.com.conf matches the box."
else
  echo "DRIFT: deploy/nginx/sign.meetreeve.com.conf differs from /etc/nginx/sites-available/sign-meetreeve on ${HOST}" >&2
  status=1
fi
echo

if [ "${status}" -eq 0 ]; then
  echo "All deploy/ files match the box."
else
  echo "Drift detected -- see above. The repo is truth: either the box needs" >&2
  echo "to be re-rendered from the repo, or the repo needs to be updated to" >&2
  echo "capture a legitimate change and re-verified. Never resolve this by" >&2
  echo "hand-editing the box and walking away." >&2
fi

exit "${status}"
