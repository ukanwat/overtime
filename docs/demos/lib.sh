# Shared by every demo's setup.sh. Source it; don't run it.
#
# Each demo gets its own scratch Overtime home under /tmp/ot-demo-<name>, with its own background
# process, so nothing here touches ~/overtime, your real agents or the daemon they run in.

set -euo pipefail

DEMOS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DEMOS/../.." && pwd)"
# The model every demo's agents run on; record-all.sh sets it from --model.
MODEL="${DEMO_MODEL:-haiku}"

# Start a demo: a fresh /tmp/ot-demo-<name> with settings, an `overtime` that runs this checkout's build,
# and env.sh, which the tape sources (hidden) before it shows anything.
#   demo_home <name> <daily budget in dollars>
demo_home() {
  NAME="$1"
  DIR="/tmp/ot-demo-$NAME"
  export OVERTIME_HOME="$DIR/overtime"
  # A previous take's background process must go before its folder does.
  [ -d "$OVERTIME_HOME" ] && ot daemon stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
  mkdir -p "$OVERTIME_HOME" "$DIR/bin"
  cat > "$OVERTIME_HOME/settings.json" <<EOF
{
  "backend": "claude",
  "model": "$MODEL",
  "dailyBudgetUsd": $2,
  "autostartAsked": true
}
EOF
  printf '#!/bin/sh\nexec node "%s/dist/bin.js" "$@"\n' "$REPO" > "$DIR/bin/overtime"
  chmod +x "$DIR/bin/overtime"
  cat > "$DIR/env.sh" <<EOF
unset OVERTIME_AGENT
export OVERTIME_HOME="$OVERTIME_HOME" OVERTIME_NO_NOTIFY=1
export PATH="$DIR/bin:\$PATH"
export PS1='\[\e[38;2;122;162;247m\]❯\[\e[0m\] '
cd "$DIR"
EOF
}

# The CLI as the demo's own home sees it. OVERTIME_AGENT is unset so this works from inside an agent too.
ot() {
  env -u OVERTIME_AGENT OVERTIME_NO_NOTIFY=1 node "$REPO/dist/bin.js" "$@"
}

# Copy a fixture folder into the demo and make it a git repo with a believable history.
#   fixture <folder in this demo's fixture/> [commit message…]
fixture() {
  local src="$DEMOS/$NAME/fixture/$1"
  cp -R "$src" "$DIR/$1"
  shift
  (
    cd "$DIR/$(basename "$src")"
    git init -q -b main
    git -c user.name=Demo -c user.email=demo@example.com add -A
    git -c user.name=Demo -c user.email=demo@example.com commit -q -m "${1:-Initial commit}"
  )
}

busy() { ot ls 2>/dev/null | grep -E "^$1 " | grep -q "working"; }

# Wait for an agent you just messaged to start, then to finish its turn (and its helpers), up to $2
# seconds (default 300).
wait_idle() {
  local agent="$1" limit="${2:-300}" t=0
  while ! busy "$agent" && [ "$t" -lt 30 ]; do
    sleep 1
    t=$((t + 1))
  done
  while busy "$agent"; do
    sleep 3
    t=$((t + 3))
    if [ "$t" -ge "$limit" ]; then
      echo "  $agent is still working after ${limit}s; recording anyway" >&2
      return 0
    fi
  done
}
