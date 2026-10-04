#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
CLEAN_START=0

# Arg parsing — currently only --clean. Pass via:
#   npm run dev:restart -- --clean
# Wipes data/dev.db + WAL + SHM before exec; operator re-runs onboarding.
for arg in "$@"; do
  if [ "$arg" = "--clean" ]; then
    CLEAN_START=1
  fi
done

get_pids() {
  fuser "${PORT}/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true
}

PIDS="$(get_pids)"

if [ -n "$PIDS" ]; then
  echo "[dev.sh] Port $PORT belegt von PID(s): $(echo $PIDS | tr '\n' ' ') — sende SIGTERM"
  kill -TERM $PIDS 2>/dev/null || true

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    [ -z "$(get_pids)" ] && break
  done

  REMAINING="$(get_pids)"
  if [ -n "$REMAINING" ]; then
    echo "[dev.sh] Port $PORT noch belegt — sende SIGKILL an $(echo $REMAINING | tr '\n' ' ')"
    kill -KILL $REMAINING 2>/dev/null || true
    sleep 1
  fi

  echo "[dev.sh] Port $PORT frei — restart"
else
  echo "[dev.sh] Port $PORT frei — start"
fi

if [ "$CLEAN_START" -eq 1 ]; then
  REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
  echo "[dev.sh] --clean: wipe ${REPO_ROOT}/data/dev.db + WAL + SHM"
  rm -f "${REPO_ROOT}/data/dev.db" "${REPO_ROOT}/data/dev.db-shm" "${REPO_ROOT}/data/dev.db-wal"
fi

exec npm run dev -- --port "$PORT"
