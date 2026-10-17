# The demos

The demo GIFs are recorded from the real app and CLI by [VHS](https://github.com/charmbracelet/vhs).
The README shows one, `team`; the rest are linked from [How Overtime works](../how-it-works.md#recorded-runs).
Two are scripted: `team` ([`team/team.ts`](team/team.ts)), and `life`
([`life/life.ts`](life/life.ts)). Each feeds the real app made-up agents and a timeline of their
messages through the same fake daemon the tests use, so they run no model and cost nothing. The other
five are real recordings: real agents on Claude, nothing mocked. Each of those has a scratch
Overtime home under `/tmp/ot-demo-<name>`, with its own background process and its own small budget, so
recording never touches `~/overtime`, your agents or the daemon they run in.

| Demo | Shows | Agent | Takes |
|---|---|---|---|
| [`team`](team) | Scripted: one message to pm, and a team plans, builds, reviews, tests, handles an incident on the canary, asks you one question and ships | pm, backend, frontend, qa, reviewer, on-call, release | ~2 min |
| [`life`](life) | Scripted: one person's own agents; an evening check-in, a flight booking approved, a night of work, a morning brief | trip-planner, house-hunt, money, learning, side-project, daily-brief | ~2 min |
| [`brief`](brief) | Make an agent in the app, brief it once: it fixes a failing test, commits, reports and schedules itself | keeper | ~3 min |
| [`watch`](watch) | An agent watching a log sleeps for free; a checkout breaks and it wakes, fixes it and reports | on-call | ~4 min |
| [`helpers`](helpers) | One brief becomes three helpers reviewing a repo in parallel, merged into one review | reviewer | ~6 min |
| [`ask`](ask) | It asks the one thing that's yours to decide, with options and a recommendation, and keeps going | releaser | ~4 min |
| [`cli`](cli) | `overtime ls`, `send`, `messages`, `set`; a correction saved as a memory in a plain file | scribe, tidy | ~3 min |

## The scripted demos

What they share is in [`scripted.ts`](scripted.ts). Three things a real run has that a recording
can't show are stood in for there, and only there:

- **The clock** is set to the scene's own time and runs faster (the night in `life` passes in twenty
  seconds), so each GIF reads the same whenever it's recorded. Animations keep their real pace.
- **Opening a file** (Ctrl+L, then Enter) shows it in the terminal, where the recording can see it,
  instead of in its own app. Markdown is drawn as the app draws messages; a chart from a `.ansi` twin
  in half-blocks. Any key goes back.
- **Notifications.** Overtime notifies through `osascript` on a Mac, which a terminal recording can't
  see. The scene logs each one it would send (a question; a report) with its moment, and
  [`notify-overlay.sh`](notify-overlay.sh) draws them onto the video as macOS banners, true to life:
  Script Editor's icon, no app name, titled `<agent> has a question` or the agent's name over the
  report's title. `--app-name` and `--icon` change that if Overtime ever notifies as itself.

The agents' files (`team/files`, `life/files`: a postmortem, an itinerary, a listing comparison and two
charts) are real files. The charts are made by [`files.py`](files.py) (`python3 docs/demos/files.py`;
matplotlib and Pillow).
`record-all.sh team life` records both and runs the overlay; it needs Google Chrome for the banners.

## Recording

From a normal terminal, in the repo:

```bash
docs/demos/record-all.sh                    # every demo, on haiku, about 20 minutes
docs/demos/record-all.sh watch ask          # just these
docs/demos/record-all.sh --model sonnet     # another model: any id `overtime models claude` lists
docs/demos/record-all.sh --yes              # don't ask first
```

Before anything runs it lists each demo's agent turns and helper sessions, estimates the cost, and
asks. Then it builds this checkout and, for each demo, runs `<name>/setup.sh` (scratch home, fixtures,
any agent that should already be at work) and `vhs <name>/<name>.tape`, which writes
`docs/demos/<name>.gif` and `.mp4`. When a demo is recorded its agents are stopped and its background
process exits, so nothing wakes up later and spends. At the end it prints what each demo spent.

You need `vhs`, `ttyd` and `ffmpeg` (`brew install vhs` brings all three), Node 22, and Claude Code
signed in.

From inside an Overtime agent's sandbox, Chrome needs `VHS_NO_SANDBOX=1` to start, and the helpers demo
can't work there at all (helpers start in a sandbox of their own, which can't nest), so record from a
normal terminal.

**Cost.** All five demos are 10 agent turns and 3 helper sessions. On haiku that's about $2–4 (in
rehearsal brief spent $0.10, watch $0.09, ask $0.09 and cli $0.16); on sonnet about $6–12. Each demo's
home caps every agent's daily budget (brief, watch and ask $3, helpers $4, cli $1.50 and $0.50), so a full run can't pass $15 even
if something loops. On a Claude subscription the turns count toward its usage window instead, which
your other agents share: record when they can spare it.

## How the tapes are written

- `config.tape` is the shared look: TokyoNight, Menlo 16, 1280×760 (about 124×31 cells), a window bar.
- Setup that shouldn't be seen (sourcing the demo's `env.sh`) is typed between `Hide` and `Show`.
- Model turns take as long as they take, so tapes wait on screen text (`Wait+Screen /working/`,
  `/○ asleep/`, `/Press 1/`) rather than fixed sleeps. Each turn shows a few seconds of the agent
  working, then cuts (`Hide` … `Show`) to the moment it's done. The wait for "asleep" is done twice,
  a few seconds apart, so a gap between two turns isn't taken for the end.
- `Set WaitTimeout 5m`, and up to 12 minutes on the long waits. A tape that times out fails with the
  line it was waiting on; its home is left in `/tmp/ot-demo-<name>` to look at
  (`OVERTIME_HOME=/tmp/ot-demo-<name>/overtime overtime messages <agent>`).

## What to check in each GIF

Real runs differ every time. Before committing a GIF, watch it once for:

- **Nothing personal.** The claude backend knows your account and an agent may mention your name or
  email in a message. If it shows, record that demo again.
- **team:** scripted, so it plays the same every time. pm's opening shows your message and its plan;
  qa shows `working · 2 helpers`, your question and its answer, the failing `theme-toggle.spec.ts` and
  its report; on-call's incident report with the postmortem and the chart opened; release's question
  with `2` chosen; it ends on pm's report with every agent asleep. Banners for qa's, on-call's and pm's
  reports and release's question, each sliding in at the moment it arrives.
- **life:** scripted too. Alex's question to trip-planner; money confirming the fare fits the budget;
  the itinerary opened; `1` chosen; good night; house-hunt checking the weekend with trip-planner and
  its listing comparison opened; money's chart opened; daily-brief's morning brief at 7. Five banners.
- **brief:** the card shows the workspace as `/tmp/ot-demo-brief/weather`; the agent says it fixed the
  Fahrenheit conversion (+23 → +32) and the tests pass; the header ends on `asleep · wakes …` with its
  next check; settings (Tab) show claude, the model, the $3 budget and the workspace.
- **watch:** the opening conversation has its reply saying it's watching `logs/app.log`; `overtime ls`
  shows it asleep after the app is closed; the second checkout prints `✗ Something went wrong` and the
  log line says `ERROR … reading 'pct'`; reopening the app shows it working within seconds, and its
  report names the unknown coupon (`WELCOME5`), the fix and the test.
- **helpers:** the header says `working · 3 helpers`; the final report lists the top findings (md5
  passwords and a forgeable token in auth, path traversal in storage, user input compiled as a regex
  in search); `head REVIEW.md` shows the merged review.
- **ask:** a question card with options and a recommendation (either way is fair: `--shout` was removed, but deprecated since 1.2);
  after `1` and Enter it carries on; `git diff --stat` shows package.json, CHANGELOG.md and RELEASE.md changed, and the notes follow.
- **cli:** `overtime ls` lists scribe and tidy with their next wakes; the reply uses `2026-10-17`-style
  dates; `MEMORY.md` has a line for the date rule; `overtime settings` shows the $5 budget.

Known quirks of recording, so they don't surprise you: under VHS, → doesn't open settings and moving
far down the settings list can close it, so the tapes use Tab and stay at the top of the list. The app
doesn't use the terminal's alternate screen, so after quitting it, tapes clear the screen (hidden)
before the shell part.

If a take is off, rerun just that one: `docs/demos/record-all.sh <name>`.
