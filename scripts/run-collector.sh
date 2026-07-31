#!/usr/bin/env bash
# Respawning wrapper for one chain's collector.
#
# systemd would do this properly, but it needs root on the box this runs on.
# Without supervision a single crash means silence until someone notices — a
# database disk-full killed both collectors once and went unnoticed for 22 hours.
#
#   bash scripts/run-collector.sh base
#
# The chain is an argument rather than only an env var so it shows up in the
# process command line, which is how ensure-collectors.sh tells the two apart.
#
# Stop it by killing this wrapper (pkill -f run-collector.sh), not the child:
# a clean SIGINT to the collector exits 0 and the loop would just restart it.
set -u

CHAIN="${1:-${CHAIN:-}}"
: "${CHAIN:?usage: run-collector.sh <base|ethereum>}"
export CHAIN
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$PATH"

backoff=5
while true; do
  echo "$(date -Is) supervisor: starting $CHAIN collector"
  start=$(date +%s)
  npm run collect
  code=$?
  ran=$(( $(date +%s) - start ))
  # A process that survived a while is a one-off; one that dies immediately is
  # broken, and hammering the APIs it talks to would make things worse.
  if [ "$ran" -gt 120 ]; then backoff=5; else backoff=$(( backoff * 2 )); fi
  [ "$backoff" -gt 300 ] && backoff=300
  echo "$(date -Is) supervisor: $CHAIN exited ($code) after ${ran}s, restarting in ${backoff}s"
  sleep "$backoff"
done
