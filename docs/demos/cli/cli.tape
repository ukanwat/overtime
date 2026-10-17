# The command line, and memory: steer agents from the shell; a correction is kept in a plain file.
Output cli.gif
Output cli.mp4
Source config.tape

Hide
Type "source /tmp/ot-demo-cli/env.sh && clear" Enter
Sleep 500ms
Show

Sleep 800ms
Type "overtime ls" Sleep 500ms Enter
Sleep 4s

# Message an agent without opening the app; it wakes at once.
Set TypingSpeed 30ms
Type `overtime send scribe "Write dates like 2026-10-17 from now on, never 'Oct 17'. What's in today's digest so far?"`
Sleep 800ms Enter
Sleep 2s
Type "overtime ls" Sleep 400ms Enter
Sleep 4s

Hide
Type "sleep 5; until ! overtime ls | grep -q working; do sleep 2; done; clear" Enter
Wait+Screen@8m /(?m)^❯ *$/
Show

# Its reply, and the rule it saved: one line in memory/MEMORY.md, read by every session it starts.
Type "overtime messages scribe | tail -n 9" Sleep 400ms Enter
Sleep 7s
Type "cat overtime/agents/scribe/memory/MEMORY.md" Sleep 400ms Enter
Sleep 7s

# Settings are yours: budgets, model, workspace, from the app or the shell.
Type "overtime set scribe budget=5" Sleep 400ms Enter
Sleep 2.5s
Type "overtime settings scribe" Sleep 400ms Enter
Sleep 7s
