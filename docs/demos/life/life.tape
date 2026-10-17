# One person's own crew: Sam checks in one evening, approves an application, says good night; the agents
# work through the night and Sam wakes to a morning report. Scripted (life.ts): the real app, made-up data.
# It records to the scratch folder; notify-overlay.sh then draws the notifications Overtime would have
# sent onto it, as life.mp4 and life.gif here.
Output "/tmp/ot-demo-life/life.gif"
Source config.tape

Hide
Type "export OVERTIME_HOME=/tmp/ot-demo-life/overtime DEMO_NOTIFY_LOG=/tmp/ot-demo-life/notifications.jsonl && clear && npx tsx life/life.ts" Enter
Wait+Screen /3 new roles match/
Sleep 1s
Show
# The video starts here: notifications are timed from this key.
Ctrl+G

Sleep 2s
Set TypingSpeed 45ms
Type "Anything worth applying to before I sleep?"
Sleep 600ms Enter

# job-scout checks the start date with visa-planner, tailors the CV and asks.
Wait+Screen /Press 1–3/
Sleep 3s
# Open the CV it made.
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

# The night: interview-coach builds the onsite prep while the others wake, work and sleep.
Down
Wait+Screen /Onsite prep plan ready/
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
Down@250ms 3
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

# Back to job-scout for the morning summary.
Up@200ms 4
Wait+Screen /Good morning, Sam/
Sleep 9s
