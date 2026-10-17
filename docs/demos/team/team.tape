# A whole team at work: one message to pm, and eight agents plan, build, review, test, handle an
# incident and ship, with one question for you. Scripted (team.ts): the real app, made-up agents.
Output team.gif
Output team.mp4
Source config.tape

Hide
Type "export OVERTIME_HOME=/tmp/ot-demo-team/overtime OVERTIME_NO_NOTIFY=1 && clear && npx tsx team/team.ts" Enter
Wait+Screen /Lumen 4.1.3 is out/
Sleep 1s
Show

Sleep 2s
Set TypingSpeed 45ms
Type "Ship dark mode and the new billing export by tonight."
Sleep 800ms Enter

# pm plans and briefs the team; the others light up as it messages them.
Sleep 10s

# qa: a failing test, pinged to frontend, fixed, rerun green.
Down@250ms 3
Sleep 15s

# on-call: woken by an error spike on the canary; rolls back, gets a hotfix, reports.
Down@250ms 2
Wait+Screen /Incident handled/
Sleep 5s

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
