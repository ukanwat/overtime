<h1 align="center">Overtime</h1>

<p align="center">
  <strong>Agents that exist, not sessions.</strong>
</p>

<p align="center">
  <a href="https://github.com/ukanwat/overtime/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/ukanwat/overtime/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="https://www.npmjs.com/package/@ukanwat/overtime"><img alt="npm" src="https://img.shields.io/npm/v/@ukanwat/overtime?style=flat-square&color=black"></a>
  <img alt="licence: MIT" src="https://img.shields.io/badge/licence-MIT-black?style=flat-square">
  <img alt="status: early" src="https://img.shields.io/badge/status-early-black?style=flat-square">
  <img alt="protocol: ACP" src="https://img.shields.io/badge/protocol-ACP-black?style=flat-square">
</p>

<p align="center">
  Built by <a href="https://utkarshkanwat.com">Utkarsh Kanwat</a> · <a href="https://x.com/ukanwat">𝕏</a>
</p>

<p align="center"><sub>Formerly AAABench, then SelfStarter. Old links redirect here.</sub></p>

Today's coding agents work like a junior or a student. You sit with them and chat through every
step, and the moment you stop talking, the work stops.

Overtime agents work like a senior. You brief them once. They plan the work, do it, keep their own
notes, check their own results, and come back only when something is really yours to decide. You
can steer whenever you like, but you don't have to.

Each agent has a name, a folder, a job and a clock. It keeps going between conversations, wakes
itself up when there is something to do, splits big work across helpers, and sleeps for free when
there isn't. Sessions with the model come and go underneath; the folder is what carries the agent
from one to the next.

Overtime has no model and no agent loop of its own. It drives the coding agents you already use,
through the [Agent Client Protocol](https://agentclientprotocol.com): Claude, Codex, Gemini CLI,
GitHub Copilot, OpenCode, and the rest.

## Quick start

```bash
npm install -g @ukanwat/overtime
overtime
```

`overtime` opens a full-screen app in your terminal. Arrow down to **+ New agent**, type a name,
and tell it in plain words what it's for. That's the whole setup: it writes its own job
description and gets to work.

```
 ◆ overtime    1 needs you  │  repo-keeper  ○ asleep · wakes 18:00                     ⚙ Settings
                            │  CI green; watching the dependency PR     $1.20 of $100 today
▌ repo-keeper             1 │──────────────────────────────────────────────────────────────────
▌   ○ asleep · wakes 18:00  │
  game-builder              │  ▣ CI is green again on main
    ● working · lighting th…│  The flaky test was a timing race; fixed in 3f2a1c.
  scout                     │
    ◇ new · waiting for its…│  ┃ ? Merge the dependency fix?
                            │  ┃ Recommended: merge it now and release tomorrow.
  + New agent               │  ┃  1  Merge it      2  Wait for 1.35      3  Close it
                            │
  › Press 1–3 to answer, or type a message
 claude                        1–3 answer  ·  ↑↓ agents  ·  → settings  ·  ? keys
```

Your agents are on the left, like DMs. On the right is your conversation with the selected agent,
and nothing else: its messages, its reports, its questions (answer with a number key), and yours.
No tool calls, no logs. While it's answering you, its reply streams in as it writes.

- **Move** with ↑↓; the conversation follows. Just type to message the selected agent.
- **Attach** a file or image by dragging it into the terminal. It's copied into the agent's folder,
  and the agent opens it with its own tools when it needs to.
- **Settings** (→ or Tab, ← to go back): backend and model (picked from what the backend offers), daily budget,
  token budget, workspace, plus wake, stop, archive, and its folder and transcripts.
- The mouse works too: click agents, options, links and files.

Quitting the app changes nothing. A small background process keeps your agents running; on first
run, Overtime asks whether to start it when you log in.

## How an agent works

**It is a folder.** `~/overtime/agents/<name>/` holds two files with fixed names and whatever else
the agent decides to keep:

- `AGENT.md`: who it is, its job, its rules and how you like things. The agent writes it from your
  first conversation and keeps it current. A few settings sit at the top (backend, model, daily
  budget, where the work lives); those are yours, and Overtime puts them back if the agent ever
  removes them.
- `INDEX.md`: the agent's own map of its folder. It's shown to the agent at the start of every
  session, so it always knows where to look.
- Everything else (notes, data, decisions, scripts, archives) is organised by the agent, the way
  a senior keeps their own desk.

**It manages its own time.** When a stretch of work is done, it decides when to wake next, between
one minute and three days ahead. It can wake on a schedule ("every day at 9") or on events: a
*watch* is a small script that Overtime runs without the model, and every line it prints wakes the
agent, so `tail -F app.log | grep ERROR` reacts within moments and costs nothing while quiet.
Messages from you, answers and finished helpers always wake it early.

**It never stops to wait for you.** When something is genuinely yours to decide, the agent asks,
with its recommendation and short options you can answer with one key, and carries on with
everything else meanwhile. It's fully autonomous otherwise. It asks first only before
destroying things outside its folders, spending money, or acting publicly or as you. A small
fixed check in Overtime itself blocks the few actions that must never slip through (wiping your
home folder, force-pushing a main branch, erasing a disk), instantly and without a model, so no
session can ever hang on a permission prompt. It sees every action the backend asks permission
for, and looks inside `bash -c`, `eval`, `xargs` and inline scripts.

**It has full access, except what you protect.** An agent can do anything your user account can:
install packages globally, use any tool, write wherever its work needs. If there's something no agent
should ever change, list it under `protect` in `~/overtime/settings.json` (for every agent) or in an
agent's settings, for example `~/Documents` or `~/.ssh`. Those paths become read-only for the agent's
backend and everything it starts, scripts and programs it wrote included, enforced by the operating
system (Seatbelt on macOS, bubblewrap on Linux). Nothing is protected unless you list it.

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

## The tools Overtime gives agents

Deliberately few, because every tool costs context on every turn:

| Tool | For |
|---|---|
| `wake` | when to wake next: at a time, after a delay, repeatedly, or on a watch |
| `cancel` | stop a repeating wake-up or a watch |
| `ask` | a question for you, without stopping work |
| `send` | message you (a reply, a report, files to share), or set the one-line status next to its name |
| `spawn` | start a helper |
| `done` | (helpers only) hand the result back |

Everything else is plain files the agent reads and writes with the tools its backend already has.

## Backends, models and MCP

New agents use your default backend and model. Change them per agent in the app (→ or Tab opens its settings,
where you pick a backend and then one of its models) or with `overtime set <name> backend=codex model=…`. The model list
comes from each backend through ACP, so new models appear without an Overtime update. If a backend
won't use the model you chose, the agent runs on its default and Overtime tells you. Built in: `claude` (bundled, uses your Claude Code login),
`codex`, `gemini`. Anything else that speaks ACP goes under `customBackends` in
`~/overtime/settings.json`.

MCP servers you list in `settings.json` under `mcpServers` are given to every agent; an agent's
`AGENT.md` settings can add more or switch shared ones off. Agents don't inherit your personal
Claude Code settings, instructions or MCP servers: they get exactly what Overtime gives them.

## In your editor

Overtime is also an ACP agent. Add `overtime acp` as an external agent in Zed, JetBrains, VS Code
(ACP extensions) or Neovim, and your agents appear as modes; an editor chat talks to that agent's
conversation.

## Command line

```
overtime                            the live app
overtime new <name>                 create an agent
overtime ls                         list agents
overtime send <name> "…"            message an agent (--attach <file>, repeatable)
overtime messages <name>            read your conversation with it
overtime answer <name> <n> [note]   answer its open question with option n
overtime settings <name>            show its backend, model, budgets and workspace
overtime set <name> key=value…      backend=  model=  budget=  tokens=  workspace=
overtime models [backend]           the models a backend offers
overtime stop|start|wake <name>
overtime archive <name>             stop an agent and move its folder away
overtime acp                        ACP on stdio, for editors
overtime daemon [stop|install|uninstall]
```

## Examples

- [`examples/open-world-game`](examples/open-world-game): the run Overtime grew out of. One
  agent, one brief, a real game engine, no human help.

## Design

Overtime borrows its philosophy from [pi](https://github.com/earendil-works/pi): keep what you inject
small and stable, keep state in plain files, give the model few tools, and make everything
inspectable. Its terminal app is built on pi's TUI library. Where Overtime differs is the point of it:
agents that persist, keep their own time, and delegate.

## Status

Early. Claude is the backend tested most; Codex and Gemini are wired up through their ACP adapters
and need wider testing. Agents run with your user's access, so treat a long-running agent like a
colleague with access to your laptop, and protect anything that must never change. Later: answering from your phone, quiet-time tidying, agents
talking to each other, a morning standup, sharing agents, and running Overtime on a server for
around-the-clock watches.

MIT licence.
