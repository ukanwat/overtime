# How Overtime works

The README is the tour; this is the detail. The same facts, written for agents, are in the built-in
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
with its recommendation and short options you can answer with one key, and carries on with
everything else meanwhile. It's fully autonomous otherwise. It asks first only before
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
| `ask` | a question for you, without stopping work |
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
