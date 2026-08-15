#!/usr/bin/env bash
# One-shot health check for the AAABench run. Prints OK lines and PROBLEM lines; exits non-zero
# if anything is wrong, so a supervisor loop or an operator can branch on it.
#
#   ./health.sh
#
# Every check uses `ps -eo` with an anchored pattern rather than `pgrep -f` / `grep -c`, because
# those also match the shell wrapper running this script — which produced three separate false
# alarms (two editors, three supervisors, a phantom crash reporter).
set -uo pipefail
cd "$(dirname "$0")"
bad=0
say_ok()  { echo "  OK       $*"; }
say_bad() { echo "  PROBLEM  $*"; bad=1; }

# --- counts, precisely ------------------------------------------------------
# Count TREES, not ppid==1. A runner launched from a shell is not reparented to init until that
# shell exits, and a supervisor started with nohup from an interactive shell may never be — the
# ppid==1 test reported "0 supervisors" at 02:57 while one was demonstrably running and logging.
# A tree root is a process whose parent is not itself running the same script.
count_tree() {  # $1 = script basename as it appears in the command line
  ps -eo pid,ppid,command | awk -v pat="$1" '
    $0 ~ pat { cmd[$1]=1; par[$1]=$2 }
    END { n=0; for (p in cmd) if (!(par[p] in cmd)) n++; print n+0 }'
}
runners=$(count_tree "bash \./run-agent\.sh")
agents=$(ps -eo command  | awk '/^claude -p/ {n++} END{print n+0}')
editors=$(ps -eo command | awk '/MacOS\/UnrealEditor$|MacOS\/UnrealEditor / {n++} END{print n+0}')
supers=$(count_tree "bash \./supervise\.sh")
# Match the bare name too: the process is launched as `CrashReportClient /Users/...` with no path
# prefix, so a path-anchored pattern misses it — which it did at 23:03 while the reporter was
# actually holding port 8000 and blocking a fresh editor from binding MCP.
crashrep=$(ps -eo command | awk '/(^|\/)CrashReportClient( |$)/ {n++} END{print n+0}')

[ "${runners:-0}" = 1 ] && say_ok "one runner"        || say_bad "${runners:-0} top-level runners (want 1)"
[ "${editors:-0}" = 1 ] && say_ok "one editor"        || say_bad "${editors:-0} editors (want 1)"
[ "${supers:-0}"  = 1 ] && say_ok "supervisor up"     || say_bad "${supers:-0} supervisors (want 1)"
[ "${agents:-0}" -le 1 ] && say_ok "agents: ${agents:-0}"  || say_bad "${agents:-0} agents (want 0 or 1)"

# A crashed editor's reporter INHERITS the MCP port and silently stops the next editor binding it.
if [ "${crashrep:-0}" -gt 0 ]; then say_bad "CrashReportClient running — it squats on the MCP port"
else say_ok "no crash reporter"; fi

# --- the MCP bridge ---------------------------------------------------------
# Retry before judging. An editor busy in PIE or mid-load can miss a single short probe while the
# bridge is perfectly fine — that produced a false PROBLEM on the 08:15 sweep while the agent was
# driving it successfully in the same second.
code=""
for _ in 1 2 3 4; do
  code=$(curl -s -m 6 -o /dev/null -w '%{http_code}' http://127.0.0.1:${MCP_PORT:-8123}/mcp 2>/dev/null)
  [ "$code" = 405 ] && break
  sleep 4
done
[ "$code" = 405 ] && say_ok "MCP answering (405)" || say_bad "MCP not answering after 4 tries (got '${code:-none}')"

# Whoever holds the port should be the editor, not a leftover.
holder=$(lsof -nP -iTCP:${MCP_PORT:-8123} 2>/dev/null | awk '/LISTEN/ {print $1; exit}')
if [ -n "${holder:-}" ]; then
  case "$holder" in UnrealEdi*) say_ok "MCP port held by the editor" ;;
                    *) say_bad "the MCP port held by '$holder', not the editor" ;; esac
fi

# --- is it actually making progress? ---------------------------------------
last=$(git log -1 --format=%ct 2>/dev/null || echo 0)
mins=$(( ( $(date +%s) - last ) / 60 ))
# Only meaningful if an agent has actually been running long enough to commit something. After a
# reboot or a restart the last commit can be hours old with nothing wrong.
agent_age=$(ps -eo etime,command | awk '/^ *[0-9:.-]+ +claude -p/ {print $1; exit}')
# 45 minutes was too tight. A render lane holds the editor and writes frames for hours before it
# hands back and the parent commits — that reported "may be stalled" twice while MRQ was demonstrably
# producing numbered frames. So treat recent file writes in the project as progress too.
recent_writes=$(find AgentCity/Saved AgentCity/Content AgentCity/tools -newermt "-25 minutes" -type f 2>/dev/null | head -1)
if [ -n "${recent_writes:-}" ] && [ "$mins" -gt 45 ]; then
  say_ok "no commit for ${mins} min, but files written in the last 25 (a lane is working)"
elif [ "$mins" -le 45 ]; then say_ok "last commit ${mins} min ago"
elif [ -z "${agent_age:-}" ] || [ "${#agent_age}" -le 5 ]; then
  say_ok "last commit ${mins} min ago (agent only just started — not a stall)"
else say_bad "no commit for ${mins} min — may be stalled"; fi

# --- is the AGENT itself alive, not merely present? -------------------------
# One long dead period had a runner and an editor up the whole time and did no work:
# an unrelated service held the MCP port, so every boot produced an editor with no bridge and the
# runner cycled forever. Processes existing is NOT progress. The agent's transcript only grows when
# it is actually taking turns, so its mtime is the honest liveness signal.
tdir="$HOME/.claude/projects/$(echo "$PWD" | tr "/." "--")"
newest=$(ls -t "$tdir"/*.jsonl 2>/dev/null | head -1)
if [ -n "${newest:-}" ]; then
  age=$(( ( $(date +%s) - $(stat -f %m "$newest") ) / 60 ))
  if [ "$age" -le 20 ]; then say_ok "agent taking turns (transcript ${age} min old)"
  elif [ "${agents:-0}" -eq 0 ]; then say_bad "no agent, and none has taken a turn for ${age} min"
  else say_bad "agent process exists but has not taken a turn for ${age} min — check the MCP bridge"; fi
fi

# --- the lock should belong to the live runner -----------------------------
lp=$(cat /tmp/aaabench-agent.lock 2>/dev/null || echo "")
if [ -n "$lp" ] && kill -0 "$lp" 2>/dev/null; then say_ok "lock held by live runner $lp"
else say_bad "lock stale or missing (value: '${lp:-none}')"; fi

exit $bad
