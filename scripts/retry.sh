#!/bin/sh
# Run a command up to N times until it succeeds; exit with the last exit code.
#
# Usage: scripts/retry.sh <attempts> <command> [args...]
# Pause between attempts: RETRY_DELAY seconds (default 15).
#
# Used by the CI job `mirror-gitlab` around `crane copy`: v2.50.0 broke off after 17 min
# in one large blob upload ("http2: response body closed"). A new attempt logs in again
# and skips every blob the registry already has, so it only uploads the rest.
# POSIX sh on purpose: the job runs in plain alpine without bash.

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <attempts> <command> [args...]" >&2
  exit 2
fi

attempts=$1
shift
case "$attempts" in
  '' | *[!0-9]* | 0)
    echo "retry: attempts must be a positive integer, got '$attempts'" >&2
    exit 2
    ;;
esac
delay=${RETRY_DELAY:-15}

n=1
while :; do
  "$@"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    exit 0
  fi
  if [ "$n" -ge "$attempts" ]; then
    echo "retry: attempt $n/$attempts failed (exit $rc), giving up" >&2
    exit "$rc"
  fi
  echo "retry: attempt $n/$attempts failed (exit $rc), next in ${delay}s" >&2
  n=$((n + 1))
  sleep "$delay"
done
