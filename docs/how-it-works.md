# How Overtime works

The README is the short version; this is the rest. The same facts, written for agents, are in the built-in
[`overtime-docs`](../skills/overtime-docs/SKILL.md) skill, which is also the most complete reference
for settings, files and commands.

## The agent

**It is a folder.** `~/overtime/agents/<name>/` holds two files with fixed names and whatever else
the agent decides to keep:

- `AGENT.md`: who it is, its job, its rules and how you like things. The agent writes it from your
  first conversation and keeps it current. Its settings (backend, model, daily budget, where the
  work lives, protected paths) are shown at the top for reference. They're yours and change only in
  the app, with `overtime set`, or in the agent's `.overtime/settings.json` (the copy that counts):
  if anything else changes that block (the agent, a script, git, or
  an edit by hand), Overtime puts it back, so no agent can raise its own budget or unprotect a path.
- `INDEX.md`: the agent's own map of its folder. It's shown to the agent at the start of every
  session, so it always knows where to look.
- `memory/`: what it has learned, one small file per memory (a fact about you, a correction, a
  decision), with `memory/MEMORY.md` as the index: one line per memory that states the rule itself.
  The index is shown at the start of every session, and again when it changes. How-tos go in
  `skills/` instead. Overtime's own memory replaces the backends' (Claude's auto-memory and Codex's
  memories are turned off for agents; Claude's existing memories for the folder are copied in once,
  and the originals are kept).
- Everything else (notes, data, decisions, scripts, archives) is organised by the agent, the way
  a senior keeps their own desk.

**It learns, and you can see what it learned.** Besides what the agent saves itself, Overtime runs a
short *reflect pass* for it while it's idle. Each pass reads the next part of what the agent did, oldest
first, from where the last pass stopped, so every turn is read once: when enough has piled up, after its
backend compacts the session, or after an hour idle, never within a few minutes of a turn or while
offline (at most 10 passes and a tenth of its budget a day).
It notes what the agent was corrected on, what it worked out and what's gone stale, as small edits to
`memory/`, each citing the run it came from. It can change nothing else: AGENT.md and skills are shown
to it read-only, and what it thinks they lack becomes a memory for the agent to fold in. It counts
toward the budget and says nothing to you. It runs on the agent's own model unless you give it another
(`overtime set <name> reflectModel=…`), and `overtime set <name> reflect=off` (or `"reflect": false` in
settings.json, for every agent) turns it off.

**It manages its own time.** When a stretch of work is done, it decides when to wake next, between
one minute and three days ahead. It can wake on a schedule ("every day at 9") or on events: a
*watch* is a small script that Overtime runs without the model, and every line it prints wakes the
agent, so `tail -F app.log | grep ERROR` reacts within moments and costs nothing while quiet.
Messages from you, answers and finished helpers always wake it early.

**It never stops to wait for you.** When something is genuinely yours to decide, the agent asks,
with its recommendation and short options you can answer with one key (or several, unless the
options exclude each other), and carries on with everything else meanwhile: only the thing it asked
about waits on your answer. It can ask more at any time; several questions can be open at once, and
none replaces another. Each answer reaches it naming the question it's for and when that was asked
(`Answer to your question "…" (asked 3:12 PM): …`). Related questions come
together on one card that you answer in turn and send at once. It's fully autonomous otherwise. It asks first only before
destroying things outside its folders, spending money, or acting publicly or as you. Overtime
answers every permission request the backend makes itself, instantly, so no session can ever hang
on a permission prompt.

**It has full access, except what you protect.** An agent can do anything your user account can:
install packages globally, use any tool, write wherever its work needs. If there's something no agent
should ever change, list it under `protect` in `~/overtime/settings.json` (for every agent) or in an
agent's settings (`overtime set <name> protect=…`), for example `~/Documents` or `~/.ssh`. Those paths become read-only for the agent's
backend and everything it starts, scripts and programs it wrote included, enforced by the operating
system (Seatbelt on macOS, bubblewrap on Linux). Nothing is protected unless you list it.

**Agents are public unless you make them private.** Public agents see each other (their job, `AGENT.md`
and conversation) and can message each other. `overtime set <name> visibility=private` (or the toggle in
its settings) takes one out: it gets no `message` tool, nobody can message it, and on macOS other agents
can't read its folder at all (on Linux they still can).

**Trust grows.** Overtime notices when you keep giving the same answer to the same kind of
question and tells the agent, which can then propose deciding those itself. If you agree, the rule
goes into its `AGENT.md`, where you can see every freedom it has been given.

**It builds its own team.** For big work, the agent splits the job and runs helpers in parallel,
each a separate session with only what it needs, in its own git worktree, on whichever backend and
model suits it. The agent reviews what comes back before accepting it. Helpers are never black
boxes: each one has its own transcript you can open.

**It stays within a budget**, $100 a day per agent unless you set another. Spend is what the backend itself reports. On a Claude subscription
your real limit is the plan's usage window, so Overtime reads that too: when you hit it, agents on
that backend pause until the exact reset time instead of failing.

## Skills

A skill is written-down know-how: a folder with a `SKILL.md` (a name and a one-line description at the
top, then the instructions) and any scripts or references it needs. Agents see the list of their skills
every session, by name and description only, and load one with the `skill` tool when it's relevant, so
skills cost almost nothing until they're used. They come from three places:

- **Built in.** The `overtime-docs` skill is Overtime's own manual: where settings, MCP servers, budgets,
  files and logs live, what each tool does, and the exact commands you run. Ask an agent "how do I give
  you a GitHub MCP server?" and it answers from this, not from guesswork.
- **Yours**, for every agent: `~/overtime/skills/<name>/SKILL.md`.
- **Its own**: `skills/<name>/SKILL.md` in the agent's folder. When an agent works out how to do something
  it will do again, it writes it down as a skill, so later sessions and its helpers reuse it.

An agent's own skill replaces one of the same name from you or Overtime. You can see an agent's skills in
its settings (→), and open each one.

## The tools Overtime gives agents

Deliberately few, because every tool costs context on every turn:

| Tool | For |
|---|---|
| `wake` | when to wake next: at a time, after a delay, repeatedly, or on a watch |
| `cancel` | stop a repeating wake-up, a watch or a running helper, or withdraw a question |
| `ask` | a question for you, or a card of several, without stopping work |
| `send` | message you (a reply, a report, files to share), or set the one-line status next to its name |
| `spawn` | start a helper (up to 6 at once) |
| `tell` | tell one of its helpers something: a correction, more to go on, or a follow-up for a finished one |
| `helpers` | its helpers right now: what each is doing, and recent results |
| `message` | message another agent, when you asked it to or its AGENT.md says when (public agents only; at most 20 a day between any two, then you're alerted) |
| `done`, `update` | (helpers only) hand the result back; say how it's going meanwhile |
| `skill` | load a skill (or list them) |

Everything else is plain files the agent reads and writes with the tools its backend already has.

## Backends, models and MCP

New agents use your default backend and model. Change them per agent in the app (→ or Tab opens its settings,
where you pick a backend and then one of its models) or with `overtime set <name> backend=codex model=…`. The model list
comes from each backend through ACP, so new models appear without an Overtime update. If a backend
won't use the model you chose, the agent runs on its default and Overtime tells you; a model name
the backend doesn't offer is refused when you set it. Built in: `claude` (bundled, uses your Claude
Code login), `codex` (through its ACP adapter, uses your Codex login), `gemini` and `opencode` (each
needs its CLI installed and signed in). Any other coding CLI that speaks ACP works too: add its
command under `customBackends` in `~/overtime/settings.json`, for example
`"goose": { "command": "goose", "args": ["acp"] }`.

Overtime adapts to each backend rather than assuming Claude: it picks the backend's mode that asks
before risky actions (so Overtime's check sees them), gives Overtime's tools through a local bridge
to backends that can't reach MCP servers over HTTP, reads cost when the backend reports it (and
tokens when it doesn't), and if an agent answers without using its tools, its final words still
reach you.

MCP servers you list in `~/overtime/settings.json` under `mcpServers` are given to every agent;
switch one off for a single agent in the app (its settings, "MCP servers"). To give one agent a server
of its own, add it under `mcpServers` in `~/overtime/agents/<name>/.overtime/settings.json` (same
shape; keep the file valid JSON): it's used from the agent's next turn, and its `AGENT.md` shows it.
An agent can also add servers for itself in `mcp.json` in its folder. Agents don't inherit your personal
Claude Code settings, instructions or MCP servers: they get exactly what Overtime gives them.

## In your editor

Overtime is also an ACP agent. Add `overtime acp` as an external agent in Zed, JetBrains, VS Code
(ACP extensions) or Neovim, and your agents appear as modes; an editor chat talks to that agent's
conversation.

## The app

Your agents are on the left, like DMs. On the right is your conversation with the selected one, and
nothing else: its messages, its reports, its questions, and yours. While it's answering, its reply
streams in as it writes.

- **Move** with ↑↓; the conversation follows. Just type to message the selected agent: what you type
  is always a message, even with questions open.
- **Questions** wait for you together, pinned just above the message box, newest last, so they never
  scroll away and you can answer any time. Tab (or a click) goes to one and ↑↓ to another; then pick
  with its number keys (one or several), or type an answer in your own words in the box, and Enter.
  Esc goes back to the message you were writing, keeping what you'd picked. On a card of several
  questions, Tab moves between them and Enter on the last sends them all. Once answered, a question
  shows in the conversation where it was asked, with your answer, and your reply says which question
  it answered.
- **Attach** a file or image by dragging it into the terminal. It's copied into the agent's folder.
- **Settings** (→, Ctrl+P, or Tab when no question is open): backend and model, daily budget, workspace, protected paths, MCP servers,
  skills, its schedule and helpers, plus wake, stop and archive.
- The mouse works too: click agents, options, links and files. `?` lists every key.

## Command line

```
overtime                            the app
overtime new <name> [key=value…]    create an agent (same keys as set)
overtime ls                         list agents
overtime send <name> "…"            message an agent (--attach <file>, repeatable)
overtime messages <name>            read your conversation with it
overtime answer <name> [<q>] <n> [note]
                                    answer its open question with option n (several: 1,3); with several
                                    open, <q> says which: its number in `overtime messages`, or its id
overtime settings <name>            show its backend, model, budgets and workspace
overtime set <name> key=value…      backend=  model=  budget=  tokens=  workspace=  protect=  visibility=
overtime models [backend]           the models a backend offers
overtime stop|start|wake <name>
overtime archive <name>             stop an agent for good and move its folder away
overtime acp                        ACP on stdio, for editors
overtime set autoUpdate=on|off      whether Overtime updates itself (on by default)
overtime daemon [stop|install|uninstall]
```

## FAQ

**Does an idle agent cost anything?**
No. Asleep, an agent runs nothing. Watches are plain scripts run without the model; only the lines
they print wake it.

**What if I close the terminal or restart?**
Agents live in a background process, not the app. Close the app whenever you like. If you said yes to
starting it at login (or ran `overtime daemon install`), they carry on after a restart from where they
were. Whatever was running when the background process stopped (an update, a crash), a turn or a
helper, carries on by itself in the same session when it starts again.

**How do I update?**
Overtime updates itself: once a day, and whenever its background process starts, it checks npm for a
newer version and installs it the way you installed it (`npm i -g`, pnpm, bun or yarn), then hands over
to it while agents keep working. The app says "Updated to …" once. It never goes back to an older
version, and doesn't run from a source checkout or `npm link`. If it can't install (no permission to
write where Overtime is installed, say), you're told once, with the command to run. Turn it off with
`overtime set autoUpdate=off` (or in the app's settings); `~/overtime/overtimed.log` shows what it did.

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

## Design

Overtime borrows its philosophy from [pi](https://github.com/earendil-works/pi): keep what you inject
small and stable, keep state in plain files, give the model few tools, and make everything
inspectable. Its terminal app is built on pi's TUI library. Where Overtime differs is the point of it:
agents that persist, keep their own time, and delegate.

## Recorded runs

The README's demo is scripted (the real app with made-up agents). These are real runs: real agents on
Claude, recorded as they happened. How they're made, and how to record them again, is in
[`docs/demos`](demos).

- [Brief it once](https://github.com/ukanwat/overtime/releases/download/media/brief.gif): a new agent is told to keep a repo's tests green; it fixes the bug, commits, reports and schedules its next check.
- [It wakes itself](https://github.com/ukanwat/overtime/releases/download/media/watch.gif): an agent watching a log is asleep with the app closed; a checkout breaks, and it's already fixing it.
- [It builds its own team](https://github.com/ukanwat/overtime/releases/download/media/helpers.gif): one review split across three helpers in parallel, merged into one report.
- [It asks, and keeps going](https://github.com/ukanwat/overtime/releases/download/media/ask.gif): the one decision that's yours, with options and a recommendation, answered with one key.
- [From the shell](https://github.com/ukanwat/overtime/releases/download/media/cli.gif): `ls`, `send`, `messages`, `set`, and a correction saved as a memory.
- [One person's agents overnight](https://github.com/ukanwat/overtime/releases/download/media/life.gif) (scripted): a trip, a house hunt, money and a side project, through one evening and night.
