# It builds its own team: one brief, three helpers in parallel, one merged review.
Output helpers.gif
Output helpers.mp4
Source config.tape

Hide
Type "source /tmp/ot-demo-helpers/env.sh && cd notes-api && clear" Enter
Sleep 500ms
Show

Sleep 800ms
Type "overtime" Sleep 500ms Enter
Wait+Screen /What should I be looking after/
Sleep 2s

Set TypingSpeed 28ms
Type "Review this repo before I open-source it. Give auth.js, storage.js and search.js each to a helper, in parallel, then merge what they find into REVIEW.md in the repo, worst first, and tell me the top three."
Sleep 1s Enter

# It splits the job; each helper is its own session with its own transcript.
Wait+Screen /[0-9] helpers/
Sleep 10s

# Helpers finish, it checks and merges their work (a few minutes, cut here).
Hide
Wait+Screen@12m /○ asleep/
Sleep 4s
# Not a gap between two turns: still asleep a moment later.
Wait+Screen@12m /○ asleep/
Sleep 1s
Show
Sleep 12s

Ctrl+C
Sleep 1s
# The app leaves its last screen behind; start the shell part on a clean one.
Hide
Type "clear" Enter
Sleep 300ms
Show
Type "head -n 24 REVIEW.md" Sleep 400ms Enter
Sleep 8s
