#!/usr/bin/env bash
# Long UE run: sequential sessions, each a fresh agent reading PROGRESS.md.
cd "$(dirname "$0")/.."   # anchor at the repo root
LOCK=/tmp/aaabench-ue.lock
if [ -e "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "A UE run is already going (pid $(cat "$LOCK")). Refusing to start a second one —"
  echo "two loops means two editors fighting over port 8000. Stop that run first."
  exit 1
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"; pkill -f "MacOS/UnrealEditor"; pkill -f CrashReportClient' EXIT
# never leave a stale editor from a previous loop behind
pkill -f "MacOS/UnrealEditor" 2>/dev/null; pkill -f CrashReportClient 2>/dev/null; sleep 3
N=${1:-6}
for i in $(seq 1 $N); do
  echo "=============== UE SESSION $i/$N  $(date +%H:%M) ==============="
  # No watchdog on purpose. Long document-writing produces ZERO MCP calls for many minutes, so
  # anything that fingerprints tool activity kills a session that is merely thinking. Use
  # bin/supervise.sh to keep a run alive, and bin/health.sh to check whether it is working.
  bin/run-agent.sh 2>&1 | tail -4
  echo "--- content files: $(find AgentCity/Content -type f 2>/dev/null | wc -l | tr -d ' ') | shots: $(ls /tmp/ue_qa/*.png 2>/dev/null | wc -l | tr -d ' ') ---"
  sleep 5
done
echo "=============== UE RUN COMPLETE ==============="
