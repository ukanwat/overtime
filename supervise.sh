#!/usr/bin/env bash
# Keep exactly one agent runner alive, indefinitely, with nobody watching.
#
#   nohup ./supervise.sh >/dev/null 2>&1 &
#
# WHY THIS EXISTS. run-agent.sh survives a lot on its own: it waits out usage limits, retries
# transient API failures without spending a nudge, and resumes after every clean stop until its
# nudge budget runs out. But when that budget IS spent, or the script itself dies, the machine goes
# idle until a human notices. Observed: a five-hour idle stretch overnight because four nudges were
# burned on an API outage. This closes that hole — nothing here needs an interactive session, a
# terminal, or an assistant to be listening.
#
# It deliberately does NOT pass RESUME_NOTE. The note carries one-off direction ("do these two
# first"); re-issuing it on every relaunch for hours would keep pointing the agent at work it has
# already finished. A plain resume tells it to continue where it left off, which is what is wanted.
set -uo pipefail
cd "$(dirname "$0")"

LOCK=/tmp/aaabench-agent.lock
LOG=/tmp/wb-supervisor.log
OUT=/tmp/wb-supervised-runner.out
CHECK_S=${CHECK_S:-120}          # how often to look
FAST_DEATH_S=${FAST_DEATH_S:-180}  # a run shorter than this is a failure, not work
BACKOFF_MIN=60
BACKOFF_MAX=1800
backoff=$BACKOFF_MIN

say() { echo "$(date '+%F %T')  $*" >> "$LOG"; }

runner_alive() {
  [ -e "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null
}

# An operator restarting by hand has to clear the lock, which looks exactly like a dead runner —
# so this loop would race them and start a SECOND runner on the same editor. Observed:
# two sessions six seconds apart, two agents interleaving in one editor until the agent noticed.
# A pause file makes the hand-off explicit: touch it, restart by hand, remove it.
PAUSE=/tmp/wb-supervisor.pause
paused() { [ -e "$PAUSE" ]; }

say "supervisor started (pid $$)"
trap 'say "supervisor stopping (pid $$)"' EXIT

while true; do
  if paused; then
    sleep 15
    continue
  fi
  if runner_alive; then
    backoff=$BACKOFF_MIN
    sleep "$CHECK_S"
    continue
  fi

  say "no runner alive - launching"
  start=$(date +%s)
  # Foreground on purpose: this loop is the single-instance guarantee.
  MAX_NUDGES=${MAX_NUDGES:-20} ./run-agent.sh >> "$OUT" 2>&1
  dur=$(( $(date +%s) - start ))
  say "runner exited after ${dur}s"

  if [ "$dur" -lt "$FAST_DEATH_S" ]; then
    # Something is wrong rather than finished — do not spin. Back off, and keep backing off, so a
    # broken editor or a dead credential cannot turn into a relaunch loop that burns money all night.
    say "  died in under ${FAST_DEATH_S}s - backing off ${backoff}s"
    sleep "$backoff"
    backoff=$(( backoff * 2 ))
    [ "$backoff" -gt "$BACKOFF_MAX" ] && backoff=$BACKOFF_MAX
  else
    backoff=$BACKOFF_MIN
    sleep 30
  fi
done
