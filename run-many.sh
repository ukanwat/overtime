#!/usr/bin/env bash
# Long UE run: sequential sessions, each a fresh agent reading PROGRESS.md.
cd "$(dirname "$0")"
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
  ./run-agent.sh 2>&1 | tail -4 &
  RUN_PID=$!
  sleep 90                       # let the session get going before arming the watchdog
  ./watchdog.sh 2>&1 | sed 's/^/    /' &
  WD_PID=$!
  wait $RUN_PID
  kill $WD_PID 2>/dev/null
  echo "--- content files: $(find AgentCity/Content -type f 2>/dev/null | wc -l | tr -d ' ') | shots: $(ls /tmp/ue_qa/*.png 2>/dev/null | wc -l | tr -d ' ') ---"
  sleep 5
done
echo "=============== UE RUN COMPLETE ==============="
