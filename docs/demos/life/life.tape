# One person's own agents: Alex checks in one evening, approves a flight booking, says good night; the
# agents work through the night and Alex wakes to a morning brief. Scripted (life.ts): the real app,
# made-up data. It records to the scratch folder; notify-overlay.sh then draws the notifications Overtime
# would have sent onto it, as life.mp4 and life.gif here.
Output "/tmp/ot-demo-life/life.gif"
Source config.tape

Hide
Type "export OVERTIME_HOME=/tmp/ot-demo-life/overtime DEMO_NOTIFY_LOG=/tmp/ot-demo-life/notifications.jsonl && clear && npx tsx life/life.ts" Enter
Wait+Screen /Watching fares to Lisbon/
Sleep 1s
Show
# The video starts here: notifications are timed from this key.
Ctrl+G

Sleep 2s
Set TypingSpeed 45ms
Type "Anything new on Lisbon?"
Sleep 600ms Enter

# trip-planner checks the budget with money, drafts the week and asks.
Wait+Screen /Press 1–3/
Sleep 3s
# Open the itinerary it made.
Ctrl+L
Sleep 1200ms
Enter
Sleep 5s
Escape
Sleep 600ms
Escape
Sleep 1s
Type "1"
Sleep 1200ms
Enter
Sleep 4500ms

Type "Perfect. Going to sleep, night!"
Sleep 500ms Enter
Sleep 3s

# The night: house-hunt finds three places, checks the weekend with trip-planner and books a viewing.
Down
Wait+Screen /viewing booked/
Sleep 2s
Ctrl+L
Sleep 1s
Enter
Sleep 5s
Escape
Sleep 600ms
Escape
Sleep 1s

# Morning: money's October report, with its chart.
Down
Wait+Screen /412 under budget/
Sleep 2500ms
Ctrl+L
Sleep 1s
Enter
Sleep 4500ms
Escape
Sleep 600ms
Escape
Sleep 800ms

# daily-brief has the morning.
Down@200ms 3
Wait+Screen /Good morning, Alex/
Sleep 9s
