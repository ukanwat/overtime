<h1 align="center">Overtime</h1>

<p align="center">
  <strong>Agents that exist, not sessions.</strong><br>
  Brief a coding agent once. It works on its own, keeps its own folder and clock,<br>
  and checks in only when something is yours to decide.
</p>

<p align="center">
  <a href="https://github.com/ukanwat/overtime/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/ukanwat/overtime/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="https://www.npmjs.com/package/@ukanwat/overtime"><img alt="npm" src="https://img.shields.io/npm/v/@ukanwat/overtime?style=flat-square&color=black"></a>
  <img alt="licence: MIT" src="https://img.shields.io/badge/licence-MIT-black?style=flat-square">
  <img alt="status: early" src="https://img.shields.io/badge/status-early-black?style=flat-square">
  <img alt="protocol: ACP" src="https://img.shields.io/badge/protocol-ACP-black?style=flat-square">
</p>

<p align="center">
  <img src="docs/demos/team.gif" alt="Seven agents in the Overtime app: pm, backend, frontend, qa, reviewer, on-call and release. One message to pm asks for dark mode and a billing export by tonight. pm plans and messages the others, who start working with helpers; qa catches a failing test and frontend fixes it; the person asks qa how dark mode looks and gets an answer; on-call is woken by an error spike on the canary, rolls it back and reports with a chart and a postmortem, which are opened; release asks whether to ship to 100% or a 10% canary first, and the answer is 2; it ships, pm reports 7 PRs merged, 1 incident handled and 41 tests added, and everyone goes back to sleep. macOS notifications pop in the corner for the reports and the question." width="100%">
</p>

<p align="center">
  Built by <a href="https://utkarshkanwat.com">Utkarsh Kanwat</a> · <a href="https://x.com/ukanwat">𝕏</a>
</p>

Today's coding agents work like a junior. You sit with them and chat through every step, and the
moment you stop talking, the work stops.

Overtime agents work like a senior. You brief them once. They plan the work, do it, keep their own
notes, check their own results, and come back only when something is really yours to decide. You
can steer whenever you like, but you don't have to.

Each agent has a name, a folder, a job and a clock. It keeps going between conversations, wakes
itself up when there is something to do, splits big work across helpers, and sleeps for free when
there isn't. Overtime has no model of its own: it drives the coding agents you already use (Claude,
Codex, Gemini CLI, OpenCode and any other) through the [Agent Client Protocol](https://agentclientprotocol.com).

## Quick start

```bash
npm install -g @ukanwat/overtime
overtime
```

Needs Node 22.19 or later, and at least one coding agent signed in. Claude is built in and uses your
Claude Code login.

`overtime` opens a full-screen app in your terminal. Type a name for your first agent and press
Enter. You'll see what it will run on (backend, model, daily budget, workspace); Enter again keeps
those. Then tell it in plain words what it's for. That's the whole setup: it writes down its own job
and gets to work.

Quitting the app changes nothing. A small background process keeps your agents running, and on first
run Overtime asks whether to start it when you log in.

## What people use it for

Each of these is one agent you brief once, in plain words. It works on its own schedule, on what you
give it access to, and asks before anything that's yours to decide.

**For your work**

- **repo-keeper**: watches CI and dependency PRs, fixes what breaks, and asks before merging anything that ships.
- **on-call**: a watch on your logs or metrics wakes it within seconds; it finds the cause, rolls back or fixes, and writes the postmortem.
- **reviewer**: reviews each PR as it opens, big ones split across helpers, and leaves its findings worst first.
- **release**: cuts the release, writes the changelog and notes, canaries it, and asks before it reaches everyone.
- **research**: reads papers, docs or competitors on a schedule, and reports with sources only when something is worth knowing.

**For your life**

- **Trips**: watches fares and stays for the dates you give it, builds the itinerary, and asks before it books.
- **House hunt**: checks new listings each morning, compares them against what you want, and lines up viewings.
- **Money**: closes each month from the statements you export: spending against your budget, and subscriptions you no longer use.
- **Learning**: a short daily drill for a language or skill, adjusted to how you did yesterday.
- **Side project**: ships your weekend app, watches its reviews and crash reports, and fixes and resubmits while you sleep.

## What it's like

### Brief it once

<img src="docs/demos/brief.gif" alt="Making an agent called keeper in the Overtime app: it's pointed at a small repo and told to keep its tests green. It finds a wrong constant in the Fahrenheit conversion, fixes it, commits, reports, and goes to sleep until its next check." width="100%">

This one is a real run, like every GIF below. One message gives an agent its job. It writes that down in its own
`AGENT.md`, finds the failing test, fixes the bug, commits, tells you what it changed, and sets its
own next wake-up. You see its messages and what it's doing right now, not a scroll of tool calls.

### It wakes itself when something happens

<img src="docs/demos/watch.gif" alt="An agent called on-call is asleep, watching a log. The app is closed, a checkout fails with an unknown coupon and writes an ERROR line, and when the app is opened again the agent is already working; it reports the cause and the fix." width="100%">

An agent decides when to wake next: at a time, on a schedule, or on a *watch*, a small script
Overtime runs without the model. Every line the script prints wakes the agent, so
`tail -F app.log | grep ERROR` reacts within seconds and costs nothing while it's quiet. Here the app
is closed, a checkout breaks, and the agent is already on it.

### It builds its own team

<img src="docs/demos/helpers.gif" alt="An agent called reviewer is asked to review a repo before it's open-sourced. Its status shows working with 3 helpers; when they finish it merges their findings into REVIEW.md and reports the top three." width="100%">

For bigger work, the agent splits the job and runs up to six helpers in parallel, each a separate
session with only what it needs, in its own git worktree, on whichever backend and model suits it.
The agent checks what comes back before accepting it, and every helper has its own transcript you can
open.

### It asks, and keeps going

<img src="docs/demos/ask.gif" alt="An agent called releaser preparing a release asks whether it should be a major or minor version, with options and its recommendation. Pressing 1 answers, and it finishes the version bump, changelog and release notes." width="100%">

When something is genuinely yours to decide, the agent asks, with its recommendation and short
options you answer with one key, and carries on with everything else meanwhile. Otherwise it's fully
autonomous: it asks first only before destroying things outside its folders, spending money, or acting
publicly or as you.

### From the shell, and it remembers

<img src="docs/demos/cli.gif" alt="In a shell: overtime ls lists two agents; overtime send corrects one of them about date formats; its reply follows the new format, the rule appears as a line in its memory/MEMORY.md, and overtime set raises its budget." width="100%">

Everything in the app is also a command. And an agent learns: correct it once and it writes the rule
to `memory/`, one small file per memory with an index every session starts with. It's all plain
files you can read, edit or put in git.

## In the app

Your agents are on the left, like DMs. On the right is your conversation with the selected one, and
nothing else: its messages, its reports, its questions, and yours. While it's answering, its reply
streams in as it writes.

- **Move** with ↑↓; the conversation follows. Just type to message the selected agent.
- **Answer** a question with its number key, then Enter, or type an answer in your own words.
- **Attach** a file or image by dragging it into the terminal. It's copied into the agent's folder.
- **Settings** (→ or Tab): backend and model, daily budget, workspace, protected paths, MCP servers,
  skills, its schedule and helpers, plus wake, stop and archive.
- The mouse works too: click agents, options, links and files. `?` lists every key.

## How it works

**An agent is a folder.** `~/overtime/agents/<name>/` holds `AGENT.md` (who it is, its job and its
rules, which it writes and keeps current), `INDEX.md` (its map of the folder), `memory/` (what it has
learned), `skills/` (how-tos it wrote down) and whatever else it decides to keep. Sessions with the
model come and go underneath; the folder is what carries the agent from one to the next.

**It manages its own time.** After a stretch of work it decides when to wake next, between a minute
and three days ahead, on a schedule, or on a watch. Messages from you, answers and finished helpers
always wake it early. Asleep, it costs nothing.

**It learns.** Besides what it saves itself, a short *reflect pass* reads its recent work while it's
idle and notes corrections, decisions and what's gone stale, as small edits to `memory/` that cite the
run they came from. When you keep giving the same answer to the same kind of question, Overtime tells
the agent, which can propose deciding those itself; if you agree, the rule goes into its `AGENT.md`.

**It has full access, except what you protect.** An agent can do what your user account can. List
paths under `protect` (for example `~/.ssh` or `~/Documents`) and they become read-only for the agent
and everything it starts, enforced by the operating system (Seatbelt on macOS, bubblewrap on Linux).
Its own settings are yours: no agent can raise its budget or unprotect a path.

**It stays within a budget**, $100 a day per agent unless you set another, from the cost the backend
reports. On a Claude subscription, Overtime also reads the plan's usage window: when you hit it,
agents on that model pause until the reset instead of failing.

**It never hangs on a prompt.** Overtime answers every permission request the backend makes, at once,
so no session waits on a dialog nobody is watching.

**Agents can work together.** Public agents see each other's job and conversation, and message each
other when you've asked them to. `overtime set <name> visibility=private` takes one out.

More detail, including skills, the tools agents get, MCP servers and memory, is in
[How Overtime works](docs/how-it-works.md).

## Backends

| Backend | What it needs |
|---|---|
| `claude` | Built in. Uses your Claude Code login. |
| `codex` | Runs through its ACP adapter. Uses your Codex login. |
| `gemini`, `opencode` | Their CLI installed and signed in. |
| anything else that speaks ACP | A line in `customBackends` in `~/overtime/settings.json`, e.g. `"goose": { "command": "goose", "args": ["acp"] }` |

New agents use your default backend and model. Change them per agent in its settings or with
`overtime set <name> backend=codex model=…`. The model list comes from each backend, so new models show
up without an Overtime update (`overtime models [backend]`). MCP servers in `~/overtime/settings.json`
go to every agent; one agent can have its own too.

Overtime is also an ACP agent: add `overtime acp` as an external agent in Zed, JetBrains, VS Code or
Neovim and your agents appear as modes.

## Command line

```
overtime                            the app
overtime new <name> [key=value…]    create an agent (same keys as set)
overtime ls                         list agents
overtime send <name> "…"            message an agent (--attach <file>, repeatable)
overtime messages <name>            read your conversation with it
overtime answer <name> <n> [note]   answer its open question with option n
overtime settings <name>            show its backend, model, budgets and workspace
overtime set <name> key=value…      backend=  model=  budget=  tokens=  workspace=  protect=  visibility=
overtime models [backend]           the models a backend offers
overtime stop|start|wake <name>
overtime archive <name>             stop an agent for good and move its folder away
overtime acp                        ACP on stdio, for editors
overtime daemon [stop|install|uninstall]
```

## FAQ

**Does an idle agent cost anything?**
No. Asleep, an agent runs nothing. Watches are plain scripts run without the model; only the lines
they print wake it.

**What if I close the terminal or restart?**
Agents live in a background process, not the app. Close the app whenever you like. If you said yes to
starting it at login (or ran `overtime daemon install`), they carry on after a restart from where they
were.

**Can an agent break something?**
It has your user's access, so treat a long-running agent like a colleague with access to your
laptop. It asks before destroying things outside its folders, spending money or acting publicly or as
you, and anything under `protect` is read-only to it, enforced by the OS.

**How do I keep spending in check?**
Every agent has a daily budget ($100 by default; `overtime set <name> budget=10`). When it's used,
the agent pauses until tomorrow and you get one alert. Raising it lifts the pause at once.

**Where is my data?**
In plain files under `~/overtime` (or `$OVERTIME_HOME`): each agent's folder, its conversation, and
transcripts of every session in `.overtime/runs/`, kept 30 days. Overtime itself sends nothing
anywhere; the only traffic is your backend talking to its model, and any MCP servers you add.

**How is this different from running Claude Code in a loop, or a cron job?**
A loop has no judgment about when to stop or wake, and a cron job has no memory of what it did. An
Overtime agent keeps its own notes and memory between sessions, decides its own schedule, delegates,
and talks to you like a colleague: one conversation per agent, not a pile of sessions.

**How do I stop everything?**
`overtime stop <name>` stops one agent (it carries on from where it was when started again).
`overtime daemon stop` stops the background process; agents carry on when it next starts.

## Learn more

- [How Overtime works](docs/how-it-works.md): agents, memory, skills, tools, backends and MCP in detail.
- [The overtime-docs skill](skills/overtime-docs/SKILL.md): the manual every agent reads, and the most
  complete reference for settings, files and commands.
- [`examples/open-world-game`](examples/open-world-game): the run Overtime grew out of. One agent, one
  brief, a real game engine, no human help.
- [`docs/demos`](docs/demos): how the GIFs above were recorded, and how to record them again.

## Design

Overtime borrows its philosophy from [pi](https://github.com/earendil-works/pi): keep what you inject
small and stable, keep state in plain files, give the model few tools, and make everything
inspectable. Its terminal app is built on pi's TUI library. Where Overtime differs is the point of it:
agents that persist, keep their own time, and delegate.

## Status

Early. Claude is the backend tested most; Codex and Gemini are wired up through their ACP adapters
and need wider testing. Later: answering from your phone, quiet-time tidying, a morning standup,
sharing agents, and running Overtime on a server for around-the-clock watches.

MIT licence.
