#!/usr/bin/env bash
# Ask: the agent gets a release ready and asks the one thing that's the person's call, with its
# recommendation, while it carries on with the rest.
source "$(dirname "$0")/../lib.sh"
demo_home ask 3
fixture greet "greet 1.4.2 and what's landed since"
ot new releaser "workspace=$DIR/greet" >/dev/null
