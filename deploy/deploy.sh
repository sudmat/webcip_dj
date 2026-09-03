#!/usr/bin/env bash
# Redeploy WebCIP: pull both trees, rebuild, restart, prove it came back.
#
#   ssh <host> sudo -u webcip /opt/webcip/deploy/deploy.sh
#   ssh <host> sudo -u webcip /opt/webcip/deploy/deploy.sh --force   # restart mid-pipeline-run
#
# Run it AS THE SERVICE ACCOUNT, not as your login user: the git deploy keys are in its
# ~/.ssh, the sudoers rule that lets it restart the service names it, and files it writes into
# the checkout have to stay owned by the account the service runs as.
#
# Idempotent: a no-change run is a no-op apart from the restart. First-time setup (accounts,
# venv, docker images, Apache) is in SERVER_SETUP.md — this script assumes it has been done.
set -euo pipefail

APP=${WEBCIP_APP:-/opt/webcip}
SRC=${WEBCIP_SRC:-/opt/pypv}
VENV=$APP/.venv
PORT=${WEBCIP_PORT:-8011}
FORCE=${1:-}

log() { printf '\n== %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

# --- 0. Never restart on top of a live run ------------------------------------------------
# A restart discards workflow._SESSION, jobs._JOBS and store._STORE, so an in-flight pipeline
# step dies silently with its docker container orphaned. Every tool run is a container named
# pv-<hex> (pv_core/tools/docker_runner.py), which makes this cheap to detect.
if [ "$FORCE" != "--force" ] && [ -n "$(docker ps -q -f 'name=^pv-' 2>/dev/null)" ]; then
  die "a tool container is running — a restart would discard the run. Wait, or pass --force."
fi

# --- 1. Code --------------------------------------------------------------------------------
log "pulling"
git -C "$APP" pull --ff-only
git -C "$SRC" pull --ff-only

# --- 2. Python ------------------------------------------------------------------------------
# Pinned; a no-op when nothing changed.
log "python deps"
"$VENV/bin/pip" install --quiet --disable-pip-version-check -r "$APP/backend/requirements.lock.txt"

# --- 3. Frontend ----------------------------------------------------------------------------
# MUST precede the restart: backend/app.py checks isdir(frontend/dist) at IMPORT time and only
# mounts the SPA when it exists.
log "frontend build"
cd "$APP/frontend"
npm ci --no-audit --no-fund
npm run build
[ -s dist/index.html ] || die "the build produced no dist/index.html"
# The one mistake that is invisible until a browser hits the subpath: a build without
# `base: './'` emits /assets/... , which resolves against the PHP site at the root.
grep -q 'src="\./assets/' dist/index.html \
  || die "dist/index.html is not relative-based — is vite.config.ts base:'./' still set?"

# --- 4. Restart -----------------------------------------------------------------------------
log "restart"
sudo -n systemctl restart webcip

# --- 5. Prove it came back ------------------------------------------------------------------
log "health"
for i in $(seq 1 60); do
  curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { journalctl -u webcip -n 50 --no-pager; die "backend did not come up"; }
  sleep 2
done
curl -fsS "http://127.0.0.1:$PORT/api/health"; echo
curl -fsS -o /dev/null -w 'spa: %{http_code}\n' "http://127.0.0.1:$PORT/"

log "deployed: webcip $(git -C "$APP" rev-parse --short HEAD) / pypv $(git -C "$SRC" rev-parse --short HEAD)"
