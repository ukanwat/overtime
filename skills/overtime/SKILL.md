---
name: overtime
description: How Overtime works, for answering the person's questions and acting correctly - where settings, MCP servers, budgets, backends, files and logs live, what each tool does, and the exact commands the person runs.
---

# How Overtime works

Overtime runs you as a long-lived agent. It has no model of its own: it drives a coding CLI (the
"backend") over ACP, gives you a few tools over MCP, and keeps your state in files. Everything below
is how it really works; when the person asks how to do something, give them the exact command or
setting from here.

## Where things live

Overtime's home is `~/overtime` (or `$OVERTIME_HOME`).

- `~/overtime/settings.json` - the person's settings for all agents (see Settings).
- `~/overtime/skills/` - skills the person gives every agent.
- `~/overtime/agents/<name>/` - your folder:
  - `AGENT.md` - who you are, your role, goals and rules (yours to keep current). A settings block
    between `---` lines at the top belongs to the person.
  - `INDEX.md` - your map of your folder.
  - `skills/` - your own skills (see Skills).
  - `files/received/<date>/` - files the person attached to messages.
  - anything else you organise.
  - `.overtime/` - Overtime's bookkeeping. Read it if useful, never edit it: `messages.jsonl` (the
    conversation), `state.json`, `schedule.json`, `monitors.json`, `helpers.json`, `helpers/<id>/work`
    (helper folders), `runs/*.jsonl` (full transcript of every session: what you were sent and did,
    kept 30 days), `usage.jsonl` (cost and tokens per turn), `background.json` (processes you left running).
- `~/overtime/archive/` - archived agents' folders.
- `~/overtime/overtimed.log` - the background process's log (rotates at 10 MB).

## Settings

Global, in `~/overtime/settings.json`:

| key | default | meaning |
|---|---|---|
| `backend` | `"claude"` | backend new agents use |
| `model` | `null` | model id, or null for the backend's own default |
| `dailyBudgetUsd` | `100` | daily spend cap per agent, from the cost the backend reports |
| `dailyTokenBudget` | `null` | daily token cap, for backends that report no cost |
| `turnTimeoutMinutes` | `180` | longest a single work session may run |
| `mcpServers` | `[]` | MCP servers every agent gets (see MCP) |
| `protect` | `[]` | paths no agent may write to, e.g. `["~/Documents", "~/.ssh"]` |
| `customBackends` | `{}` | extra ACP backends: `{ "name": { "command": "...", "args": [...] } }` |

Per agent, in the settings block at the top of its `AGENT.md` (only keys that differ):
`backend`, `model`, `dailyBudgetUsd`, `dailyTokenBudget`, `workspace` (where its work lives; default
its own folder), `mcpServers` (extra servers), `disableMcp` (names of shared servers to leave out),
`protect` (extra protected paths).

The person changes an agent's settings in the app (select the agent, press →) or with:

```
overtime set <name> backend=codex model=<id> budget=20 tokens=500k workspace=~/code/app protect=~/Documents,~/.ssh
overtime settings <name>      # show them
overtime models [backend]     # the models a backend offers
```

You never change the settings block yourself: Overtime puts it back. If a change would help, tell the
person the exact command. Changes apply from your next session.

## MCP servers

- For every agent: add to `mcpServers` in `~/overtime/settings.json`, either a local command
  `{ "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } }`
  or a URL `{ "name": "linear", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ..." } }`.
- For one agent: the same entries under `mcpServers` in its AGENT.md settings block; `disableMcp: [name]`
  leaves out a shared one. The person edits these (the app's settings show them; AGENT.md is plain YAML).
- They take effect from the agent's next session. Agents don't get the person's own Claude Code
  settings, instructions or MCP servers: only what Overtime gives them.
- Overtime's own tools come from a server named `overtime`. Backends that can't reach URL servers get
  them through a local bridge automatically.

## Backends

Built in: `claude` (bundled; uses the person's Claude Code login), `codex` (its ACP adapter via npx;
uses the Codex login), `gemini` and `opencode` (need their CLI installed and signed in). Any other
coding CLI that speaks ACP: add it to `customBackends`, e.g. `"goose": { "command": "goose", "args": ["acp"] }`,
then `overtime set <name> backend=goose`. Cost is read when the backend reports it; otherwise tokens.

## Your tools

- `wake` - when to wake next: `in` ("20m", "6h", "2d") or `at` (a time), between 1 minute and 3 days;
  `every` for repeating; `watch` for a shell command Overtime runs without the model (each printed line
  wakes you; with `every`, it wakes you when the output changes; `cooldown` limits how often). Watches
  run in your folder. If you set nothing and have no watch or repeating wake, you wake in an hour.
- `cancel` - stop a repeating wake, a watch, or a running helper, by id.
- `ask` - a question for the person, with options and your recommendation; never blocks you.
- `send` - message the person (`report: true` with a `title` for finished work), share `files`, set your
  one-line `status`. From a chat session, `to: "main"` hands work to your main session.
- `spawn` - a helper: a separate session doing one task in parallel, in its own git worktree of your
  workspace's last commit (or a copy of a small non-git workspace). Up to 6 at once. Optional `role_file`
  (a file in your folder describing the role; `backend`/`model` at its top choose what it runs on).
  Its result arrives in your inbox; its folder is removed a week after it finished (git branches stay).
- `done` - helpers only: hand back the result.
- `skill` - load a skill by name (or list them).

## Skills

A skill is a folder with a `SKILL.md`: front matter with `name` and a one-line `description`, then the
know-how in Markdown; scripts or reference files it needs sit beside it. Every session lists the skills
you have by name and description; load one with `skill` when it's relevant (or read the file).

- Built into Overtime: like this one.
- The person's, for every agent: `~/overtime/skills/<name>/SKILL.md`.
- Yours: `skills/<name>/SKILL.md` in your folder. When you work out how to do something you'll do again
  (a release, a report, a tricky setup), write it down as a skill so later sessions and helpers reuse it.
  A skill with the same name as a built-in or the person's one replaces it for you.

## How sessions work

- Your main session does the work. Messages from the person are answered by a separate chat session,
  which hands real work to main. Helpers are their own sessions.
- A session continues from the last one until its context is about 60% full; then a fresh one starts,
  rebuilt from your folder (AGENT.md, INDEX.md, your notes). Write down what matters.
- What you start in the background keeps running after your session; you see it listed each turn.
  Stopping or archiving you stops it. Long jobs: run in the background with output to a log file.

## Budgets and limits

- Daily budget per agent (default $100) from the backend's reported cost; or a token budget. When it's
  used, you pause until tomorrow and the person gets one alert. Raising it (Settings, or
  `overtime set <name> budget=…`) lifts the pause at once.
- On a subscription usage limit (e.g. Claude's 5-hour window), agents on that backend pause until the
  reset time.

## Safety

- Overtime answers your backend's permission requests itself, instantly. It refuses only a short list
  (sudo, force-pushing main branches, erasing disks, dropping databases, deleting or moving things
  outside your folder and workspace, and deletes whose targets it can't check) and tells you why: write
  the paths out in full, or ask the person.
- Protected paths (`protect`) are read-only for you and everything you run, enforced by the system.

## The person's side

- `overtime` opens the app: agents on the left, the conversation on the right. ↑↓ moves between agents,
  → opens settings, typing writes a message, 1-9 answers a question, drag a file in to attach it, ? for keys.
- Commands: `overtime new <name>`, `ls`, `send <name> "..." [--attach file]`, `messages <name>`,
  `answer <name> <n>`, `stop|start|wake <name>`, `settings <name>`, `set <name> key=value`,
  `models [backend]`, `archive <name>` (stops it for good, moves its folder to `~/overtime/archive/`,
  nothing deleted), `daemon stop`, `daemon install` (start at login), `acp` (for editors: Zed, JetBrains, VS Code).

## When something goes wrong

- Your full transcripts: `.overtime/runs/` in your folder. The background process: `~/overtime/overtimed.log`.
- A failed turn is retried with growing gaps (1, 5, 15, 60 minutes); after 3 failures the person gets an alert.
- A backend that isn't installed or signed in fails with a plain message; tell the person what to install
  or run.
