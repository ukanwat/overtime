# It asks, and keeps going: a question with options and a recommendation, answered with one key.
Output ask.gif
Output ask.mp4
Source config.tape

Hide
Type "source /tmp/ot-demo-ask/env.sh && cd greet && clear" Enter
Sleep 500ms
Show

Sleep 800ms
Type "overtime" Sleep 500ms Enter
Wait+Screen /What should I be looking after/
Sleep 2s

Set TypingSpeed 28ms
Type "Get the next release of greet ready: bump the version, finish the changelog and draft the release notes in RELEASE.md. Don't publish or tag anything. Major or minor is my call."
Sleep 1s Enter

# It works out what changed, then asks the one thing that's yours, without stopping.
Wait+Screen /working/
Sleep 6s
Hide
Wait+Screen@8m /Press 1/
Sleep 1s
Show
Sleep 7s

# One key picks an option; Enter sends it.
Type "1"
Sleep 2s
Enter
Wait+Screen /working/
Sleep 6s
Hide
Wait+Screen@8m /○ asleep/
Sleep 4s
# Not a gap between two turns: still asleep a moment later.
Wait+Screen@8m /○ asleep/
Sleep 1s
Show
Sleep 10s

Ctrl+C
Sleep 1s
# The app leaves its last screen behind; start the shell part on a clean one.
Hide
Type "clear" Enter
Sleep 300ms
Show
Type "git diff --stat && head -n 16 RELEASE.md" Sleep 400ms Enter
Sleep 6s
