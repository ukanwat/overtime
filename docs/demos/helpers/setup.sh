#!/usr/bin/env bash
# Helpers: an agent splits a code review across parallel helpers and merges what they find.
# The fixture is a small API with real problems in each file, so every helper has something to report.
source "$(dirname "$0")/../lib.sh"
demo_home helpers 4
fixture notes-api "notes-api: notes, search and sign-in"
ot new reviewer "workspace=$DIR/notes-api" >/dev/null
