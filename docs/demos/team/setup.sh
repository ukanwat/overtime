#!/usr/bin/env bash
# The team demo is scripted (team.ts): no agents, no background process and no model, so all it needs is
# an empty scratch folder for OVERTIME_HOME to point at, so the app never looks at ~/overtime.
set -euo pipefail
rm -rf /tmp/ot-demo-team
mkdir -p /tmp/ot-demo-team
