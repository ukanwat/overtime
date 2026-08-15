#!/usr/bin/env bash
# Restart the agent by hand WITHOUT racing supervise.sh.
#
#   ./restart-agent.sh [note-file]        default: RESUME-NOTE.md
#
# The supervisor treats a missing lock as a dead runner, so clearing the lock by hand is
# indistinguishable from a crash and it will launch its own runner. That produced two agents on one
# editor. This holds the supervisor off, stops the old runner, verifies it is really gone, starts the
# new one, then releases the supervisor.
set -uo pipefail
cd "$(dirname "$0")"
NOTE="${1:-RESUME-NOTE.md}"
PAUSE=/tmp/wb-supervisor.pause
LOCK=/tmp/aaabench-agent.lock
trap 'rm -f "$PAUSE"' EXIT

touch "$PAUSE"; echo "supervisor paused"
for p in $(ps -eo ppid,pid,command | awk '$1==1 && /bash \.\/run-agent\.sh/ {print $2}'); do kill "$p" 2>/dev/null; done
sleep 3
for p in $(ps aux | grep -E "[c]laude -p (You|#)" | awk '{print $2}'); do kill "$p" 2>/dev/null; done
# verify, escalating — a kill that silently fails is how duplicates happen
for _ in 1 2 3 4 5; do
  left=$(ps aux | grep -cE "[c]laude -p (You|#)|[r]un-agent\.sh")
  [ "$left" -eq 0 ] && break
  sleep 2
  for p in $(ps aux | grep -E "[c]laude -p (You|#)" | awk '{print $2}'); do kill -9 "$p" 2>/dev/null; done
  for p in $(ps -eo ppid,pid,command | awk '$1==1 && /bash \.\/run-agent\.sh/ {print $2}'); do kill -9 "$p" 2>/dev/null; done
done
rm -f "$LOCK"
MAX_NUDGES=${MAX_NUDGES:-20} nohup env RESUME_NOTE="$(cat "$NOTE")" MAX_NUDGES=${MAX_NUDGES:-20} \
  ./run-agent.sh > "/tmp/wbrunner-$(date +%H%M%S).out" 2>&1 &
for _ in $(seq 1 20); do sleep 2; [ -s "$LOCK" ] && break; done
echo "runner up: $(cat "$LOCK" 2>/dev/null)"
