#!/usr/bin/env bash
# Sets up and records the README's demos for real: real agents on Claude, in scratch homes under
# /tmp/ot-demo-<name>, driven through the real app and CLI by VHS. The exceptions are team and life:
# scripted scenarios in the real app (team/team.ts, life/life.ts) that run no model and cost nothing; their
# notifications are drawn on afterwards by notify-overlay.sh.
#
#   docs/demos/record-all.sh                     every demo, on haiku
#   docs/demos/record-all.sh watch ask           just these
#   docs/demos/record-all.sh --model sonnet      on another model (any id `overtime models claude` lists)
#   docs/demos/record-all.sh --yes               don't ask before starting
#
# Before anything runs it says how many agent turns the demos take and roughly what they cost, and
# asks. Those turns use your Claude login, so on a subscription they count toward its usage window.
#
# Run it from a normal terminal. Inside an Overtime agent's sandbox, helpers can't start (sandboxes don't
# nest) and Chrome needs VHS_NO_SANDBOX=1.
# Needs vhs, ttyd and ffmpeg (brew install vhs), and Claude Code signed in. Never touches ~/overtime,
# your agents or their background process: each demo has its own, stopped when it's recorded.

set -euo pipefail
DEMOS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DEMOS/../.." && pwd)"
ALL=(team life brief watch helpers ask cli)
MODEL=haiku
YES=""
NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="${2:?--model needs a model, e.g. --model sonnet}"; shift 2 ;;
    --model=*) MODEL="${1#--model=}"; shift ;;
    --yes | -y) YES=1; shift ;;
    -h | --help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) NAMES+=("$1"); shift ;;
  esac
done
[ ${#NAMES[@]} -gt 0 ] || NAMES=("${ALL[@]}")
export DEMO_MODEL="$MODEL"

for tool in vhs ttyd ffmpeg node git; do
  command -v "$tool" >/dev/null || { echo "✗ $tool isn't installed (brew install vhs installs vhs, ttyd and ffmpeg)." >&2; exit 1; }
done
for n in "${NAMES[@]}"; do
  [ -f "$DEMOS/$n/$n.tape" ] || { echo "✗ No demo called $n. Demos: ${ALL[*]}" >&2; exit 1; }
done
# From inside an agent the CLI only reads; the demos need the person's side of it.
unset OVERTIME_AGENT

# What each demo runs, from its setup and tape: agent turns, helper sessions, and the daily budget its
# home caps every agent at (so the most it could ever spend).
turns() { case "$1" in team | life) echo 0 ;; brief) echo 1 ;; watch) echo 2 ;; helpers) echo 2 ;; ask) echo 2 ;; cli) echo 3 ;; esac; }
helpers() { case "$1" in helpers) echo 3 ;; *) echo 0 ;; esac; }
cap() { case "$1" in team | life) echo 0 ;; brief | watch | ask) echo 3 ;; helpers) echo 4 ;; cli) echo 2 ;; esac; }
# The scripted ones run no model.
scripted() { case "$1" in team | life) return 0 ;; *) return 1 ;; esac; }
T=0 H=0 C=0
all_scripted=1
for n in "${NAMES[@]}"; do scripted "$n" || all_scripted=""; done
if [ -n "$all_scripted" ]; then echo "◆ About to record ${#NAMES[@]} scripted demo(s):"; else echo "◆ About to record ${#NAMES[@]} demo(s) for real, on claude · $MODEL:"; fi
for n in "${NAMES[@]}"; do
  scripted "$n" && { printf "    %-8s scripted, no model: free\n" "$n"; continue; }
  printf "    %-8s %s agent turn(s)%s, capped at \$%s\n" "$n" "$(turns "$n")" "$( [ "$(helpers "$n")" -gt 0 ] && echo " + $(helpers "$n") helper sessions" || true)" "$(cap "$n")"
  T=$((T + $(turns "$n"))) H=$((H + $(helpers "$n"))) C=$((C + $(cap "$n")))
done
# Per session (an agent turn or a helper), measured in rehearsal on haiku: $0.10-0.15 for a turn like
# these, so $0.15-0.30 leaves room. Sonnet is taken as about three times that.
case "$MODEL" in
  haiku*) lo=0.15 hi=0.30 ;;
  sonnet*) lo=0.45 hi=0.90 ;;
  *) lo="" ;;
esac
S=$((T + H))
if [ -n "$lo" ]; then
  est=$(awk -v s="$S" -v lo="$lo" -v hi="$hi" -v c="$C" 'BEGIN { h = s * hi; if (h > c) h = c; printf "about $%.0f-%.0f", s * lo, h + 0.5 }')
else
  est="more than on sonnet (not measured)"
fi
if [ "$S" -gt 0 ]; then
  echo "  $T agent turns and $H helper sessions in all: $est at API prices, never more than \$$C (the budgets)."
  echo "  On a Claude subscription they count toward its usage window instead, shared with your other agents."
fi
# Nothing to spend (just the scripted demos): nothing to ask.
if [ -z "$YES" ] && [ "$S" -gt 0 ]; then
  if [ ! -t 0 ]; then echo "✗ Not a terminal to ask in; rerun with --yes to go ahead." >&2; exit 1; fi
  read -r -p "  Go ahead? (y/N) " ok
  case "$ok" in y* | Y*) ;; *) echo "  Nothing recorded."; exit 0 ;; esac
fi

echo "◆ Building this checkout ($REPO)"
(cd "$REPO" && npm run build >/dev/null)

spend() {
  node -e '
    const fs = require("fs"), path = require("path");
    let total = 0;
    for (const dir of process.argv.slice(1)) {
      const agents = path.join(dir, "overtime", "agents");
      if (!fs.existsSync(agents)) continue;
      for (const a of fs.readdirSync(agents)) {
        const f = path.join(agents, a, ".overtime", "usage.jsonl");
        if (!fs.existsSync(f)) continue;
        for (const l of fs.readFileSync(f, "utf8").split("\n")) if (l.trim()) total += JSON.parse(l).turnCostUsd || 0;
      }
    }
    console.log(total.toFixed(2));
  ' "$@"
}

# When a demo is done (or the script stops), its agents stop and its background process exits, so
# nothing wakes up later and spends.
finish() {
  local dir="/tmp/ot-demo-$1"
  [ -d "$dir/overtime" ] || return 0
  export OVERTIME_HOME="$dir/overtime"
  for a in $(ls "$OVERTIME_HOME/agents" 2>/dev/null); do node "$REPO/dist/bin.js" stop "$a" >/dev/null 2>&1 || true; done
  node "$REPO/dist/bin.js" daemon stop >/dev/null 2>&1 || true
  unset OVERTIME_HOME
}
CURRENT=""
trap '[ -n "$CURRENT" ] && finish "$CURRENT"' EXIT

cd "$DEMOS"
for n in "${NAMES[@]}"; do
  CURRENT="$n"
  echo
  echo "◆ $n: setting up /tmp/ot-demo-$n"
  bash "$DEMOS/$n/setup.sh"
  if scripted "$n"; then
    echo "◆ $n: recording (scripted, about a minute and a half)"
    vhs "$n/$n.tape"
    bash "$DEMOS/notify-overlay.sh" "$n"
  else
    echo "◆ $n: recording (real model turns, a few minutes)"
    vhs "$n/$n.tape"
  fi
  finish "$n"
  CURRENT=""
  echo "✓ $n: $(du -h "$n.gif" | cut -f1) gif, \$$(spend "/tmp/ot-demo-$n") spent"
done

dirs=()
for n in "${NAMES[@]}"; do dirs+=("/tmp/ot-demo-$n"); done
echo
echo "✓ Recorded ${NAMES[*]} into docs/demos/. Total spend: \$$(spend "${dirs[@]}")"
echo "  Look at each GIF before committing it (docs/demos/README.md says what to check)."
