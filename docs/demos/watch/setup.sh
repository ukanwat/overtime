#!/usr/bin/env bash
# Watch: an agent that's already been briefed to keep an eye on a log. It set a watch (a small script
# Overtime runs without the model) and is asleep; the tape breaks the checkout and it wakes.
source "$(dirname "$0")/../lib.sh"
demo_home watch 3
fixture shop "shop: checkout and pricing"
# A quiet morning so far (written here: the repo ignores *.log, so it can't live in the fixture).
mkdir -p "$DIR/shop/logs"
cat > "$DIR/shop/logs/app.log" <<'LOG'
2026-10-17T08:58:02.114Z INFO server started on :8080
2026-10-17T09:01:47.530Z INFO checkout ok: order for lee, 2 items, $41.20
2026-10-17T09:03:12.901Z INFO checkout ok: order for priya, 1 items, $18.00
2026-10-17T09:07:55.266Z INFO checkout ok: order for jon, 4 items, $96.75
LOG
ot new on-call "workspace=$DIR/shop" >/dev/null
ot send on-call "You're on call for the shop in this repo. Watch logs/app.log: when an ERROR line shows up, find the cause in the code, fix it with a test, commit, and tell me what happened. Stay quiet while it's healthy." >/dev/null
wait_idle on-call
if ! grep -q '"run"' "$OVERTIME_HOME/agents/on-call/.overtime/monitors.json" 2>/dev/null; then
  echo "  ! on-call didn't set a watch; the recording won't show it waking. Its reply:" >&2
  ot messages on-call | tail -n 8 >&2
fi
