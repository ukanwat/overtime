#!/usr/bin/env bash
# Brief: a new agent is made in the app, told its job in one message, and gets on with it.
# The fixture is a small repo with one real bug, so its first turn has something to fix.
source "$(dirname "$0")/../lib.sh"
demo_home brief 3
fixture weather "weather: one-line forecasts"
