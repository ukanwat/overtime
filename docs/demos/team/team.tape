# A whole team at work: one brief to pm, and seven agents plan, build, review, test, handle an incident
# and ship, with one question for you. Scripted (team.ts): the real app, made-up agents.
# It records to the scratch folder; notify-overlay.sh then draws the notifications Overtime would have
# sent onto it, as team.mp4 and team.gif here.
Output "/tmp/ot-demo-team/team.gif"
Source config.tape

Hide
Type "export OVERTIME_HOME=/tmp/ot-demo-team/overtime DEMO_NOTIFY_LOG=/tmp/ot-demo-team/notifications.jsonl && clear && npx tsx team/team.ts" Enter
Wait+Screen /Lumen 4.1.3 is out/
Sleep 1s
Show
# The video starts here: notifications are timed from this key.
Ctrl+G

Sleep 2s
Set TypingSpeed 45ms
Type "Ship dark mode and the new billing export by tonight."
Sleep 800ms Enter

# pm plans and briefs the team; the others light up as it messages them.
Sleep 10s

# qa: you check in; then a failing test, pinged to frontend, fixed, rerun green.
Down@250ms 3
Sleep 1500ms
Type "How's dark mode looking?"
Sleep 500ms Enter
Sleep 14s

# on-call: woken by an error spike on the canary; rolls back, gets a hotfix, reports with its files.
Down@250ms 2
Wait+Screen /Incident handled/
Sleep 3s
# Open the postmortem it attached, then the error-rate chart.
Ctrl+L
Sleep 1200ms
Enter
Sleep 5s
Escape
Sleep 1s
Ctrl+L
Sleep 1s
Enter
Sleep 4500ms
Escape
Sleep 600ms
Escape
Sleep 1s

# release: the one thing that's yours to decide.
Down
Wait+Screen /Press 1–3/
Sleep 4s
Type "2"
Sleep 1500ms
Enter
Sleep 7s

# Back to pm for the day's report; then everyone's asleep until morning.
Up@150ms 6
Wait+Screen /Everyone's off until morning/
Sleep 9s
