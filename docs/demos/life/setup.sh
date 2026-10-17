#!/usr/bin/env bash
# The life demo is scripted (life.ts): no agents, no background process and no model, so all it needs is
# an empty scratch folder for OVERTIME_HOME to point at, so the app never looks at ~/overtime.
set -euo pipefail
rm -rf /tmp/ot-demo-life
mkdir -p /tmp/ot-demo-life
