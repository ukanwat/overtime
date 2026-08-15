#!/usr/bin/env bash
# Boot the UE editor with the project, wait for Epic's MCP server, then hand the
# project to a headless claude -p session.
#
#   ./run-agent.sh [/abs/path/to/Project.uproject]
#
# Prereqs (one-time, human): UE 5.8 installed; project created; plugins
# "Unreal MCP" + "AllToolsets" + "Python Scripting" enabled; MCP auto-start ON;
# `ModelContextProtocol.GenerateClientConfig ClaudeCode` run once in the editor.
set -uo pipefail
cd "$(dirname "$0")"

# One runner at a time. Two runners means two agents driving one editor through one MCP port,
# and the symptom is not an error — it is two conversations interleaving edits to the same
# files, which looks like the agent contradicting itself. Observed.
# Deliberately a different lock file from run-many.sh's, which holds its own while calling
# this script sequentially; sharing one would deadlock that loop on its first iteration.
LOCK=/tmp/aaabench-agent.lock
if [ -e "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "An agent session is already running (pid $(cat "$LOCK")). Refusing to start a second."
  echo "Two agents on one editor interleave their edits. Stop that session first."
  exit 1
fi
echo $$ > "$LOCK"
# Remove only the lock. Never kill the editor here: it is shared, the agent restarts it
# itself when it dies, and a nudge resumes into the same one.
trap 'rm -f "$LOCK"' EXIT

UE_APP="/Users/Shared/Epic Games/UE_5.8/Engine/Binaries/Mac/UnrealEditor.app"
# Port 8000 is a popular default and was already taken on this machine by an unrelated uvicorn
# service, which the editor cannot detect: it simply comes up with no bridge, and every boot
# looks like a failure. Observed once, costing many hours of dead cycling. Keep MCP off the common
# port and make it overridable.
MCP_PORT="${MCP_PORT:-8123}"
MCP_URL="http://127.0.0.1:$MCP_PORT/mcp"
PROJECT="${1:-$(ls -1 "$PWD"/*/*.uproject 2>/dev/null | head -1)}"

[ -d "$UE_APP" ] || { echo "UE 5.8 not found at: $UE_APP"; echo "Install it via Epic Games Launcher first (see README)."; exit 1; }
[ -n "${PROJECT:-}" ] && [ -f "$PROJECT" ] || { echo "No .uproject found. Create the project first (see README), or pass its path."; exit 1; }
PROJDIR="$(dirname "$PROJECT")"
echo "project: $PROJECT"

# 1. Editor already up? Otherwise launch it (it must RENDER — no -nullrhi).
mcp_alive() {
  # 405 == an MCP endpoint refusing GET (correct). A crash dialog or other squatter
  # on the port answers differently — and pkill any stale CrashReportClient first,
  # because it inherits the port and silently blocks the editor from binding it.
  pkill -f CrashReportClient 2>/dev/null
  [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$MCP_URL")" = "405" ] &&
    pgrep -f "MacOS/UnrealEditor" >/dev/null
}
boot_editor() {
  if mcp_alive; then echo "MCP already live at $MCP_URL"; return 0; fi
  echo "launching editor…"
  # NB: `open -a APP file` hands UE a relative path and it looks inside the engine dir.
  # Always exec the binary inside the bundle with an absolute project path.
  # -unattended suppresses modal dialogs; a modal FREEZES the game thread and kills the
  # MCP transport, so never run the editor interactively for an agent session.
  # A crashed editor sits in StaticShutdownAfterError and IGNORES SIGTERM, so a plain pkill
  # leaves it holding port 8000 and a new editor can never bind — you get two editors and no
  # MCP. Escalate to SIGKILL, then verify nothing survived before launching.
  pkill -f CrashReportClient 2>/dev/null
  pkill -f "MacOS/UnrealEditor" 2>/dev/null; sleep 3
  pkill -9 -f "MacOS/UnrealEditor" 2>/dev/null; sleep 2
  for _ in 1 2 3 4 5; do
    pgrep -f "MacOS/UnrealEditor" >/dev/null || break
    echo "  a previous editor is still alive - forcing it down"
    pkill -9 -f "MacOS/UnrealEditor" 2>/dev/null; sleep 2
  done
  nohup "$UE_APP/Contents/MacOS/UnrealEditor" "$(cd "$(dirname "$PROJECT")" && pwd)/$(basename "$PROJECT")" \
    -unattended -nosplash -NoPause >/tmp/ue-editor.log 2>&1 &
  # The level has grown from 68 MB to 366 MB over this run, and cold-boot load time with it.
  # 5 minutes was enough once and is not any more: at 366 MB the editor was still loading when the
  # wait expired, which made a healthy boot look like a failure and triggered the fallback below.
  printf "waiting for MCP"
  for _ in $(seq 1 ${MCP_WAIT_TRIES:-240}); do    # 240 x 5s = 20 min
    sleep 5; printf "."
    mcp_alive && { echo " up"; break; }
  done
  echo
  mcp_alive
}
boot_editor
# Enabling engine plugins can stop the editor booting. If it doesn't come up, fall back to the
# last known-good .uproject rather than losing the session.
# This fallback exists for ONE failure: a plugin named in the .uproject that the engine cannot load,
# which aborts the editor AT STARTUP. That looks like a dead process. A slow boot looks completely
# different — the process is alive and working — and reverting then is destructive.
# Observed: a 366 MB level outran the old 5-minute wait, the fallback fired on a healthy
# editor, and a stale .bak with 5 plugins overwrote a good file with 50. Recovered from git.
# So: only revert if the editor process is GONE, and refuse a .bak that has fewer plugins.
if ! mcp_alive && [ -f "$PROJECT.bak" ] && ! pgrep -f "MacOS/UnrealEditor" >/dev/null; then
  plugins_in() { python3 -c "
import json,sys
raw=open(sys.argv[1],'rb').read()
for enc in ('utf-8-sig','utf-16','utf-8'):
    try:
        print(len(json.loads(raw.decode(enc)).get('Plugins',[]))); break
    except Exception: continue
else: print(-1)
" "$1" 2>/dev/null || echo -1; }
  now_n=$(plugins_in "$PROJECT"); bak_n=$(plugins_in "$PROJECT.bak")
  if [ "$bak_n" -ge "$now_n" ] 2>/dev/null; then
    echo "editor died at startup — restoring last known-good .uproject ($bak_n plugins) and retrying"
    cp "$PROJECT" "$PROJECT.failed"; cp "$PROJECT.bak" "$PROJECT"
    boot_editor
  else
    echo "editor died, but the .bak has $bak_n plugins against the current $now_n — refusing to revert"
    echo "  (a stale backup once cost this project 45 enabled plugins; fix the .uproject by hand)"
  fi
fi
mcp_alive || {
  echo
  echo "MCP endpoint never came up. Check in-editor: Plugins → Unreal MCP + AllToolsets enabled,"
  echo "Editor Preferences → Model Context Protocol → auto-start ON, then rerun."
  exit 1
}

# 2. MCP config for Claude Code (prefer the editor-generated one in the project).
CFG="$PROJDIR/.mcp.json"
if [ ! -f "$CFG" ]; then
  CFG="$PWD/.mcp.json"
  cat > "$CFG" <<JSON
{ "mcpServers": { "unreal": { "type": "http", "url": "$MCP_URL" } } }
JSON
  echo "wrote fallback MCP config: $CFG"
fi

# Keys, if present, become part of the session environment — the agent discovers them as
# capabilities rather than being told they exist. keys.env is gitignored; never commit it.
for kf in "$PWD/keys.env" "$HOME/.aaabench-keys.env"; do
  [ -f "$kf" ] && { set -a; . "$kf"; set +a; echo "loaded $(basename "$kf")"; break; }
done

# 3. Run the agent inside the project directory.
mkdir -p /tmp/ue_qa
LOG="$PWD/session-$(date +%H%M%S).log"
echo "agent starting — log: $LOG"

MAX_NUDGES=${MAX_NUDGES:-4}      # resumes after a CLEAN stop; each is a full session.
                                 # Raise it for long unattended runs (MAX_NUDGES=20 ~= a day).

# Run from the REPO ROOT, not the project dir: docs/, .claude/skills/ and ue_qa.py all
# live here, and every path in PROMPT.md is written relative to it.
# AGENT selects the CLI under test. Each preset takes a prompt on argv and must be able to
# reach the MCP endpoint in $CFG. Add your own; the harness only needs the process to run
# headless, to have file+shell access, and to exit when it is done.
AGENT="${AGENT:-claude}"
MODEL="${MODEL:-claude-opus-5}"
# The agent legitimately runs long background jobs — generator passes, Blender bakes, asset
# fetches. The default 600s ceiling on waiting for them kills a session mid-work (observed:
# "Background tasks still running after 600s; terminating"). Wait indefinitely instead.
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0

# Keep the context bounded so a long-lived resumed session stays affordable. Measured on this
# run: per-turn context grew from 83k tokens to 650k across ~10 resumes, and a single session
# then spent $14.78 on three turns because almost all of it went on re-reading conversation
# rather than working. Capping forces auto-compaction well before the 1M ceiling.
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-600000}

# Compact at 500k, under the 600k ceiling above, so compaction happens by plan rather than as
# an emergency at the wall. This run is resumed indefinitely and never cold-started, so without
# a trigger the context only ever grows. 500k is a deliberately large working window — it holds
# a whole session's investigation — while leaving 100k of headroom for the compaction itself.
# The env var overrides the `autoCompactWindow` setting in ~/.claude/settings.json ("is set and
# takes precedence"), which is why it lives here: the harness carries its own behaviour and
# does not depend on, or modify, whatever the person running it has configured globally.
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-500000}

agent_run() {   # $1 = prompt, $2 = session id to resume (optional, claude only)
  case "$AGENT" in
    claude)
      if [ -n "${2:-}" ]; then
        claude -p "$1" --resume "$2" --mcp-config "$CFG" --output-format json \
          --dangerously-skip-permissions --model "$MODEL"
      else
        claude -p "$1" --mcp-config "$CFG" --output-format json \
          --dangerously-skip-permissions --model "$MODEL"
      fi ;;
    codex)   codex exec --dangerously-bypass-approvals-and-sandbox "$1" ;;
    gemini)  gemini --yolo --prompt "$1" ;;
    custom)  [ -n "${AGENT_CMD:-}" ] || { echo "AGENT=custom needs AGENT_CMD set" >&2; exit 2; }
             eval "$AGENT_CMD" ;;      # AGENT_CMD may reference "$1"
    *) echo "unknown AGENT=$AGENT (claude|codex|gemini|custom)" >&2; exit 2 ;;
  esac
}
claude_run() { agent_run "$@"; }       # back-compat
field() { python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$1" "$2" 2>/dev/null; }

# NOTE=<file> prepends a restart preamble (e.g. "keep what you built, here is what changed").
PROMPT="$(cat PROMPT.md)"
[ -n "${NOTE:-}" ] && [ -f "$NOTE" ] && PROMPT="$(cat "$NOTE")

---

$PROMPT" && echo "prepended restart note: $NOTE"
# CONTINUE BY DEFAULT. A cold start re-reads the whole brief and handover (~2,500 lines)
# before doing any work; resuming keeps the context it already has, so it costs almost nothing
# to pick up. Set FRESH=1 to force a genuine cold start (e.g. to test cold-start continuity,
# or after a big change to the demand that it needs to read in full).
LAST_ID="$PWD/.last-session-id"
if [ -z "${FRESH:-}" ] && [ -s "$LAST_ID" ]; then
  PREV="$(cat "$LAST_ID")"
  echo "continuing session $PREV (FRESH=1 forces a cold start)"
  # RESUME_NOTE prepends a one-off instruction to a continuation — e.g. "re-read the demand,
  # it changed" — so the demand can be updated without paying for a full cold start.
  claude_run "${RESUME_NOTE:+$RESUME_NOTE

}Continue. Same world, same plan — pick up exactly where you left off, starting with \
whatever you had queued. If anything about the demand or your environment has changed since you \
last looked, you will find it in PROMPT.md and docs/; check only if something surprises you. \
Append to PROGRESS.md as you go. Do not stop to ask or wait — nobody is coming." "$PREV" | tee "$LOG"
else
  claude_run "$PROMPT" | tee "$LOG"
fi
SID=$(field "$LOG" session_id)
[ -n "$SID" ] && echo "$SID" > "$LAST_ID"
MINS=$(python3 -c "import json;print(round(json.load(open('$LOG')).get('duration_ms',0)/60000))" 2>/dev/null || echo 999)

# The brief says "work until you are cut off", so ANY clean exit is the agent stopping by
# choice — it wrote a handover and put its tools down. There are only two honest reasons a
# session should end: a usage limit, or an error. So resume on every clean stop.
#
# This used to test session duration against a floor, on the theory that a short session had
# stopped early and a long one had run out of work. That was wrong twice over: the work never
# runs out (the brief is explicit that there is no finish line), and the test silently failed
# whenever a session ran past the floor — observed: a 103.5 min session against a
# 100 min floor, which spent none of its four nudges and left the machine idle for five hours.
#
# RESUME the same session (not a fresh one): its plan, its file knowledge and its half-finished
# thought are all still in that conversation, so it carries on instead of re-deriving the world.
# A usage limit is not a failure and must not burn the nudge budget. Rather than parsing a reset
# time out of the message (fragile, timezone-dependent), just retry every few minutes until it
# clears. Detection is a fixed-string match on the exact phrase Claude Code prints.
hit_limit() {
  grep -qiF "hit your session limit" "$1" 2>/dev/null ||
  grep -qiF "hit your usage limit"   "$1" 2>/dev/null
}

# A 529/5xx from the API is not the agent stopping and must not cost a nudge. Observed
# Observed: two nudges spent on "API Error: 529 Overloaded", 1 turn and $0 each, which the
# loop read as a clean stop. Checked from the parsed JSON rather than by matching text, so a
# session that merely *discusses* an API error is not mistaken for one that hit it.
# TRUE only when the session ended for a reason that is NOT the agent deciding to stop.
# Everything here is transient and must be retried without spending a nudge. Shapes actually
# observed on this run, all of which the loop used to read as a clean stop:
#   subtype=error_during_execution  terminal_reason=aborted_streaming   (mid-response drop)
#   subtype=error_during_execution  terminal_reason=aborted_tools       (mid-tool drop)
#   subtype=success  is_error=true  result="API Error: 529 Overloaded"  (upstream 5xx)
# A clean stop is the ONLY case that costs a nudge: subtype=success and is_error false.
api_error() {
  python3 - "$1" <<'PYEOF' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)          # unreadable log == something went wrong, so retry rather than count it
bad = bool(d.get("is_error")) or d.get("subtype") != "success"
sys.exit(0 if bad else 1)
PYEOF
}

LIMIT_RETRY_S=${LIMIT_RETRY_S:-240}      # how often to check again
LIMIT_MAX_TRIES=${LIMIT_MAX_TRIES:-360}  # give up after roughly a day of waiting

# CUR is always the log of the most recent run. Everything below reads it rather than $LOG,
# because after the first nudge $LOG is stale and a limit hit in a *resumed* session would
# otherwise go unnoticed.
CUR="$LOG"
read_state() {
  MINS=$(python3 -c "import json;print(round(json.load(open('$CUR')).get('duration_ms',0)/60000))" 2>/dev/null || echo 999)
  S2=$(field "$CUR" session_id); [ -n "$S2" ] && { SID="$S2"; echo "$SID" > "$LAST_ID"; }
}

# Sit out a usage limit however long it lasts. Not a failure, and it must not burn a nudge.
API_RETRY_S=${API_RETRY_S:-90}    # a 5xx usually clears in a minute or two

# Sit out anything that is not the agent choosing to stop: a usage limit, or a transient API
# failure. Neither costs a nudge.
wait_out_transient() {
  local tries=0 why
  while [ "$tries" -lt "$LIMIT_MAX_TRIES" ]; do
    if   hit_limit "$CUR"; then why=limit
    elif api_error "$CUR"; then why=api
    else break
    fi
    tries=$((tries + 1))
    if [ "$why" = limit ]; then
      echo "  usage limit still in force - waiting ${LIMIT_RETRY_S}s then trying again (attempt $tries)"
      sleep "$LIMIT_RETRY_S"
    else
      echo "  session did not end cleanly (transient) - waiting ${API_RETRY_S}s then retrying (attempt $tries, no nudge spent)"
      sleep "$API_RETRY_S"
    fi
    boot_editor >/dev/null 2>&1 || true
    claude_run "Continue where you left off. Nothing is waiting on a reply and nobody is coming." "$SID" | tee "$CUR"
    read_state
  done
  if [ "$tries" -gt 0 ] && ! hit_limit "$CUR" && ! api_error "$CUR"; then
    echo "  cleared after $tries attempt(s) - running again"
  fi
}
wait_out_limit() { wait_out_transient; }   # back-compat

wait_out_transient
# n has to be initialised HERE, under `set -u`. It never was, in any version of this script:
# the old condition tested `$MINS -lt $FLOOR_MIN` first, that test failed, `&&` short-circuited,
# and `$n` was never expanded — so the bug sat latent behind a guard that happened to hide it.
# Removing the floor made it reachable and the runner died with "n: unbound variable" AFTER a
# clean 61-minute session, losing every nudge. `bash -n` cannot catch this: an unbound variable
# is a runtime fault, not a syntax error. Observed.
n=0
while [ -n "$SID" ] && [ "$n" -lt "$MAX_NUDGES" ]; do
  n=$((n+1))
  echo "  session ended cleanly at ${MINS}m → resuming $SID, nudge $n/$MAX_NUDGES"
  CUR="${LOG%.log}-resume$n.log"
  boot_editor || echo "  (editor still down — the agent will work offline, as instructed)"
  claude_run "You stopped, and nothing was asking you to. Nothing is waiting on a reply and \
nobody is coming — continue exactly where you left off, starting with whatever you had \
queued or listed as next. There is no finish line for this work and no session in which it \
is correct to hand over and stop; a handover note is for being cut off mid-thought, not for \
ending a session that could have kept going. If the editor or MCP is down, retry it \
periodically but keep working meanwhile on everything that doesn't need it: design documents, \
reference photographs, asset preparation, Python scripts to run when it returns. Append to \
PROGRESS.md as you go. Do not stop to ask, confirm, or wait — work until you are cut off." \
    "$SID" | tee "$CUR"
  read_state
  wait_out_transient
done

echo "done. screenshots: /tmp/ue_qa/  notes: $PWD/PROGRESS.md"
