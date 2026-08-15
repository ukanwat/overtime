#!/usr/bin/env bash
# Copy the harness (and only the harness) into the published repo and push.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DST="${1:-$SRC/../aaabench}"
rsync -a "$SRC/PROMPT.md" "$SRC/RESTART-NOTE.md" "$SRC/HARNESS-RULES.md" \
        "$SRC/SETUP.md" "$SRC/SETUP-VERIFIED.md" "$SRC/run-agent.sh" "$SRC/run-many.sh" \
        "$SRC/prep-project.sh" "$SRC/ue_qa.py" "$SRC/sync-harness.sh" \
        "$SRC/setup-capabilities.sh" "$SRC/gen-image.py" "$SRC/appui.py" \
        "$SRC/supervise.sh" "$SRC/health.sh" "$SRC/restart-agent.sh" "$DST/"
# EXCLUDE subagent scratch AND the agent's own output. `docs/` holds both the handbook (tech,
# sources, workflow — harness) and the agent's captured frames and films (`docs/shots` was 1.7 GB,
# `docs/film` its cuts). The published repo is the harness anyone can run, explicitly NOT the run's
# output, so the output subdirectories are excluded by name.
# EXCLUDE subagent scratch. `.claude` used to hold only skills; it now also holds
# `.claude/worktrees` — per-subagent git worktrees, 17 GB of them at the time of writing. Copying
# those in committed 1.6 GB of loose objects to the published repo and the push could never
# complete. Anything that is scratch, cache or per-run state is excluded here by name.
rsync -a --delete \
  --exclude 'worktrees/' --exclude 'shell-snapshots/' --exclude 'todos/' \
  --exclude 'projects/' --exclude 'statsig/' --exclude '__pycache__/' \
  --exclude 'shots/' --exclude 'film/' \
  "$SRC/docs" "$SRC/.claude" "$DST/"
mkdir -p "$DST/project/Config"
cp "$SRC/AgentCity/AgentCity.uproject" "$DST/project/"
cp "$SRC/AgentCity/Config/"*.ini "$DST/project/Config/"
cd "$DST" && git add -A && git diff --cached --quiet || git commit -q -m "${2:-Sync harness from run repo}"
git push -q origin main && echo "harness synced and pushed"
