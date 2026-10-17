# Brief an agent once: make it in the app, say what it's for, and it gets on with it.
Output brief.gif
Output brief.mp4
Source config.tape

Hide
Type "source /tmp/ot-demo-brief/env.sh && clear" Enter
Sleep 500ms
Show

Sleep 800ms
Type "overtime" Sleep 500ms Enter
Wait+Screen /Name the new agent/
Sleep 2s

# A name, then the card with what it runs on: point its workspace at the repo and create it.
Type "keeper" Sleep 700ms Enter
Wait+Screen /Create keeper/
Sleep 2.5s
Up Sleep 700ms Enter Sleep 600ms
Type "/tmp/ot-demo-brief/weather" Sleep 700ms Enter
Sleep 1.5s
Down Sleep 700ms Enter
Wait+Screen /What should I be looking after/
Sleep 2s

# The whole brief.
Set TypingSpeed 28ms
Type "Look after this repo. Keep its tests green: fix what breaks, commit it, and tell me what you changed. Check it again every weekday at 9am."
Sleep 1s Enter

# It works on its own; you see what it's doing, not every tool call.
Wait+Screen /working/
Sleep 10s
Hide
Wait+Screen@8m /○ asleep/
Sleep 4s
# Not a gap between two turns: still asleep a moment later.
Wait+Screen@8m /○ asleep/
Sleep 1s
Show

# Its report and its next wake, which it chose itself; then its settings (Tab), which are yours.
Sleep 9s
Tab
Sleep 5s
Tab
Sleep 2s
