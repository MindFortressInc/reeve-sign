#!/usr/bin/env bash
# deploy/check-image-drift.sh
#
# DEV-7600: the epic's docker-on-box drift assertion is "running container's
# image digest == the digest the compose pin resolves to". reeve-sign pins by
# tag (e.g. sha-8ff686f0), not by digest, and the image reaches the box as a
# docker-save tarball because the box has no GHCR read credential. That rules
# out both naive fixes:
#
#   - pinning compose by `image@sha256:<manifest digest>` cannot work: the box
#     would have to pull the digest from GHCR, which it cannot do;
#   - comparing manifest digests on the box cannot work either: `docker load`
#     does not preserve RepoDigests, so the running image has none.
#
# The digest that DOES survive docker save / docker load is the image ID: the
# config digest (sha256 of the image config JSON). It is byte-identical
# between the registry manifest's `config.digest` and `docker inspect`'s
# `.Image` on the box. So this assertion resolves the pinned tag to its config
# digest via the GHCR API *at check time* and compares it to the running
# container's image ID. A moving tag serving different bytes fails this check;
# a mere tag-string comparison would not.
#
# Requirements: ssh access to the box, `jq`, and a GitHub token that can read
# the private GHCR package (uses `gh auth token`, or $GH_TOKEN/$GITHUB_TOKEN).
# Like check-drift.sh, this cannot run in CI today (no SSH access to the box).
#
# Usage:
#   deploy/check-image-drift.sh              # uses the "reeve-ec2" SSH alias
#   deploy/check-image-drift.sh some-alias   # overrides the SSH host alias
#
# Exit status: 0 if the running container matches the digest its pinned tag
# resolves to, 1 on drift or on any resolution/connection failure.

set -euo pipefail

HOST="${1:-reeve-ec2}"
BOX_COMPOSE_DIR="/home/ubuntu/reeve-sign"
REGISTRY="ghcr.io"
PACKAGE="mindfortressinc/reeve-sign"
IMAGE="${REGISTRY}/${PACKAGE}"

fail() {
  echo "DRIFT/ERROR: $*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "jq is required"

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "${TOKEN}" ] && command -v gh >/dev/null 2>&1; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi
[ -n "${TOKEN}" ] || fail "no GitHub token (gh auth login, or set GH_TOKEN) to read the private GHCR package"

echo "Checking image digest drift on ${HOST} (read-only)..."
echo

# 1. The pinned image ref in the box's compose.yml (the deploy truth).
PINNED_REF="$(ssh "${HOST}" "grep -Eo 'ghcr\.io/mindfortressinc/reeve-sign:[A-Za-z0-9._-]+' ${BOX_COMPOSE_DIR}/compose.yml" | head -n1)" ||
  fail "could not read ${BOX_COMPOSE_DIR}/compose.yml over ssh to ${HOST} (transport or grep failure, NOT a no-drift result)"
[ -n "${PINNED_REF}" ] || fail "could not find a ${IMAGE}:<tag> pin in ${HOST}:${BOX_COMPOSE_DIR}/compose.yml"
TAG="${PINNED_REF##*:}"
echo "pinned ref (box compose.yml):    ${PINNED_REF}"

# 2. What is actually running: the ref the container was started from, and its
#    image ID (config digest) — the only digest that survives docker load.
CONTAINER_ID="$(ssh "${HOST}" "docker compose --project-directory ${BOX_COMPOSE_DIR} ps -q documenso")" ||
  fail "'docker compose ps' failed over ssh to ${HOST} (transport or compose failure, NOT a no-drift result)"
[ -n "${CONTAINER_ID}" ] || fail "no running 'documenso' container found via compose in ${BOX_COMPOSE_DIR}"
RUNNING_REF="$(ssh "${HOST}" "docker inspect --format '{{.Config.Image}}' ${CONTAINER_ID}")" ||
  fail "could not inspect container ${CONTAINER_ID} on ${HOST} for its started-from ref"
RUNNING_IMAGE_ID="$(ssh "${HOST}" "docker inspect --format '{{.Image}}' ${CONTAINER_ID}")" ||
  fail "could not inspect container ${CONTAINER_ID} on ${HOST} for its image ID"
[ -n "${RUNNING_REF}" ] && [ -n "${RUNNING_IMAGE_ID}" ] ||
  fail "docker inspect on ${HOST} returned an empty ref/image ID for ${CONTAINER_ID}"
echo "running ref (container):         ${RUNNING_REF}"
echo "running image ID (config digest): ${RUNNING_IMAGE_ID}"

# 3. Resolve the pinned tag to its config digest via the GHCR API at check time.
REGISTRY_TOKEN="$(curl -fsS -u "x:${TOKEN}" "https://${REGISTRY}/token?scope=repository:${PACKAGE}:pull" | jq -r '.token')" ||
  fail "GHCR token exchange failed (network error or the token cannot read ${PACKAGE})"
[ -n "${REGISTRY_TOKEN}" ] && [ "${REGISTRY_TOKEN}" != "null" ] || fail "could not obtain a GHCR registry token"
MANIFEST="$(curl -fsS \
  -H "Authorization: Bearer ${REGISTRY_TOKEN}" \
  -H "Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json" \
  "https://${REGISTRY}/v2/${PACKAGE}/manifests/${TAG}")" ||
  fail "could not fetch the GHCR manifest for ${IMAGE}:${TAG} (network error, or the tag no longer exists)"
EXPECTED_IMAGE_ID="$(jq -r '.config.digest // empty' <<<"${MANIFEST}")"
[ -n "${EXPECTED_IMAGE_ID}" ] || fail "manifest for ${IMAGE}:${TAG} has no config digest (mediaType: $(jq -r '.mediaType' <<<"${MANIFEST}"))"
echo "registry config digest for :${TAG}: ${EXPECTED_IMAGE_ID}"
echo

status=0

if [ "${RUNNING_REF}" != "${PINNED_REF}" ]; then
  echo "DRIFT: container was started from '${RUNNING_REF}' but compose pins '${PINNED_REF}' (restart pending or manual run)." >&2
  status=1
fi

if [ "${RUNNING_IMAGE_ID}" != "${EXPECTED_IMAGE_ID}" ]; then
  echo "DRIFT: running image ID ${RUNNING_IMAGE_ID} != ${EXPECTED_IMAGE_ID}, which ${IMAGE}:${TAG} resolves to in GHCR." >&2
  echo "       The pinned tag and the running bytes disagree — exactly the moving-tag failure class (DEV-7600)." >&2
  status=1
fi

if [ "${status}" -eq 0 ]; then
  echo "OK: running container matches the config digest its pinned tag resolves to."
fi

exit "${status}"
