#!/usr/bin/env bash
# Starts any collector that isn't running. Idempotent — safe to run every few
# minutes from cron, which is how it's meant to be used:
#
#   */5 * * * * /home/prabal/workspace/1inchFilledComparision/scripts/ensure-collectors.sh
#
# run-collector.sh already respawns a collector that crashes. This covers what
# that can't: a reboot, or the whole process group being killed at once. Both
# have happened — a host-level stop took the collectors down for 19 hours with
# no crash trace and no supervisor restart line, because the supervisor died too.
set -u

cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$PATH"
mkdir -p logs

# The read-only dashboard API. Vercel fetches this over HTTPS rather than
# talking to Postgres directly: the public hostname is proxied by Cloudflare,
# which carries HTTP but not raw TCP, and serving JSON keeps the database off
# the internet entirely.
if ! pgrep -f "tsx src/dash/mai[n].ts" > /dev/null 2>&1; then
  echo "$(date -Is) ensure: dashboard not running, starting" >> logs/ensure.log
  setsid nohup env DASH_HOST=0.0.0.0 DASH_PORT=8787 npx tsx src/dash/main.ts \
    >> logs/dash.log 2>&1 < /dev/null &
  sleep 2
fi

for chain in ethereum; do
  # The chain is an argument to run-collector.sh, so it appears in the command
  # line. The bracket keeps this pattern from matching the script's own cmdline.
  if pgrep -f "run-collecto[r].sh $chain" > /dev/null 2>&1; then
    continue
  fi
  log="logs/collect-${chain}.log"
  [ "$chain" = "ethereum" ] && log="logs/collect-eth.log"
  echo "$(date -Is) ensure: $chain not running, starting" >> logs/ensure.log
  setsid nohup bash scripts/run-collector.sh "$chain" >> "$log" 2>&1 < /dev/null &
  sleep 2
done
