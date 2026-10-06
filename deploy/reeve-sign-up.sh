#!/usr/bin/env bash
# deploy/reeve-sign-up.sh -> /home/ubuntu/reeve-sign/reeve-sign-up.sh on reeve-ec2
#
# DEV-14025 (Reeve.Secrets 4/6): the one way this box runs `docker compose up -d`
# for reeve-sign. compose.yml reads every secret by ${VAR} interpolation, so the
# Secrets Manager bundle has to arrive as a second `--env-file`, after .env:
# the later file wins. `env_file:` would not work, because
# `environment: - X=${X}` overrides it.
#
# Inert until REEVE_SECRETS_ENABLED=1 (exactly) is in /home/ubuntu/reeve-sign/.env.
# Without it this runs compose on .env alone and removes any stale render.
# With it, it FAILS CLOSED: a failed render exits non-zero BEFORE `up -d`, so
# the containers keep running on their current env and never restart on a
# stale or missing one. Rollback: delete the flag line from .env, rerun this.
#
# The flag-off path deliberately does not call the renderer. With
# manifest/reeve-sign.json missing (before reeve-services#5987 reaches the box),
# render-env.py's disabled path falls back to service "reeve-services" and
# unlinks that service's live /run/reeve-secrets/reeve-services.env.
#
# /run/reeve-secrets is created at boot by deploy/tmpfiles.d/reeve-sign-secrets.conf:
# the renderer runs as ubuntu, which cannot mkdir in /run.
#
# Always `up -d`, never `restart`: restart keeps the container's old env.
# Extra args pass through to `up -d`, e.g. `reeve-sign-up.sh documenso`.
set -euo pipefail

SIGN_DIR="${REEVE_SIGN_DIR:-/home/ubuntu/reeve-sign}"
SERVICES_DIR="${REEVE_SERVICES_DIR:-/home/ubuntu/reeve-services}"
RENDER_DIR="${REEVE_SECRETS_DIR:-/run/reeve-secrets}"
ENV_FILE="$SIGN_DIR/.env"
RENDER="$RENDER_DIR/reeve-sign.env"

log() { printf 'reeve-sign-up: %s\n' "$*" >&2; }
die() { log "ABORT: $*; not running up -d, containers keep their current env"; exit 1; }

[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE"
flag="$(sed -n 's/^REEVE_SECRETS_ENABLED=//p' "$ENV_FILE" | tail -n1)"
args=(--env-file "$ENV_FILE")

if [ "$flag" = 1 ]; then
  [ -d "$RENDER_DIR" ] || die "$RENDER_DIR is missing (sudo systemd-tmpfiles --create /etc/tmpfiles.d/reeve-sign-secrets.conf)"
  REEVE_SECRETS_ENABLED=1 timeout 20 "$SERVICES_DIR/.venv/bin/python" \
    "$SERVICES_DIR/deploy/secrets/render-env.py" \
    --manifest "$SERVICES_DIR/deploy/secrets/manifest/reeve-sign.json" \
    --out-dir "$RENDER_DIR" --env-file "$ENV_FILE" --format compose \
    || die "secrets render failed (exit $?)"
  [ -s "$RENDER" ] || die "renderer exited 0 but $RENDER is missing or empty"
  args+=(--env-file "$RENDER")
  log "secrets enabled; .env + $RENDER (render wins)"
else
  rm -f "$RENDER" || log "could not remove stale $RENDER (not passed to compose)"
  log "REEVE_SECRETS_ENABLED is not 1; .env only"
fi

exec docker compose --project-directory "$SIGN_DIR" "${args[@]}" up -d "$@"
