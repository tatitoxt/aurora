#!/usr/bin/env bash
# Rough resource snapshot of a running noctbeat demo instance.
# Usage: NOCTBEAT_DEMO=1 ./target/debug/noctbeat & sleep 3 && bench/bench.sh
set -euo pipefail
PID="$(pgrep -f 'noctbeat' | head -1)"
[ -n "$PID" ] || { echo "no noctbeat process"; exit 1; }
for i in 1 2 3 4 5; do
  ps -o pid,%cpu,rss,vsz -p "$PID" | tail -1
  sleep 1
done
