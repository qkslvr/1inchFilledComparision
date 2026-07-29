#!/usr/bin/env bash
# Respawning wrapper for one chain's collector.
#
# systemd would do this properly, but it needs root on the box this runs on.
# Without supervision a single crash means silence until someone notices — a
# database disk-full killed both collectors once and went unnoticed for 22 hours.
#
#   CHAIN=base bash scripts/run-collector.sh
#
# Stop it by killing this wrapper (pkill -f run-collector.sh), not the child:
# a clean SIGINT to the collector exits 0 and the loop would just restart it.
set -u

CHAIN="${CHAIN:?set CHAIN=base or CHAIN=ethereum}"
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
