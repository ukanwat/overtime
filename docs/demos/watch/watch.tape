# Wakes on events: an agent watching a log sleeps for free, and wakes the moment something breaks.
Output watch.gif
Output watch.mp4
Source config.tape

Hide
Type "source /tmp/ot-demo-watch/env.sh && cd shop && clear" Enter
Sleep 500ms
Show

# Briefed earlier, it set a watch on the log and went to sleep.
Sleep 800ms
Type "overtime" Sleep 500ms Enter
Wait+Screen /on-call/
Sleep 7s

# Close the app: the agent keeps running without it.
Ctrl+C
Sleep 1s
# The app leaves its last screen behind; start the shell part on a clean one.
Hide
Type "clear" Enter
Sleep 300ms
Show
Sleep 500ms
Type "overtime ls" Sleep 400ms Enter
Sleep 3s

# A customer checks out with a coupon that doesn't exist.
Type "node shop.js checkout carts/sam.json" Sleep 400ms Enter
Sleep 2s
Type "node shop.js checkout carts/maya.json" Sleep 400ms Enter
Sleep 2.5s
Type "tail -n 1 logs/app.log | cut -c 1-110" Sleep 400ms Enter
Sleep 4s

# The watch saw the ERROR line and woke it.
Type "overtime" Sleep 500ms Enter
Wait+Screen /working/
Sleep 10s
Hide
Wait+Screen@8m /○ asleep/
Sleep 4s
# Not a gap between two turns: still asleep a moment later.
Wait+Screen@8m /○ asleep/
Sleep 1s
Show
Sleep 12s
