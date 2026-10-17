#!/usr/bin/env bash
# CLI and memory: two agents already at work, driven from the shell. A correction becomes a memory
# in a plain file, which every later session starts with.
source "$(dirname "$0")/../lib.sh"
demo_home cli 1.5
fixture journal "Notes so far"
# Today's changes, so the digest has something to say.
(
  cd "$DIR/journal"
  printf -- '- Beta date moved to Wednesday: the invite emails need one more pass.\n' >> launch.md
  git -c user.name=Demo -c user.email=demo@example.com commit -qam "Launch: beta moves to Wednesday"
  printf -- '- Offer out to one of them; answer due Friday.\n' >> hiring.md
  git -c user.name=Demo -c user.email=demo@example.com commit -qam "Hiring: offer out"
)
cp -R "$DEMOS/cli/fixture/downloads" "$DIR/downloads"
touch -t 202608010900 "$DIR/downloads/invoice-0912.pdf" "$DIR/downloads/IMG_2041.jpg"

ot new scribe "workspace=$DIR/journal" >/dev/null
ot send scribe "Every evening at 6pm, write a short digest of what changed in this repo that day into DIGEST.md, and send me the gist in two lines." >/dev/null
ot new tidy model=haiku budget=0.5 "workspace=$DIR/downloads" >/dev/null
ot send tidy "Every Sunday morning, move files in this folder that are older than 30 days into old/, and tell me what you moved. Never delete anything." >/dev/null
wait_idle scribe
wait_idle tidy
