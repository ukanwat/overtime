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

Overtime runs agents that keep working without you. Brief one once, in plain words: it plans, does
the work, keeps its own notes, wakes itself when something happens, splits big jobs across helpers,
and messages you only when something is yours to decide. It has no model of its own: it drives the
coding agents you already use (Claude, Codex, Gemini CLI, OpenCode, anything that speaks
[ACP](https://agentclientprotocol.com)).

## Quick start

```bash
npm install -g @ukanwat/overtime
overtime
```

1. Type a name for your first agent and press Enter.
2. Check what it runs on (backend, model, daily budget, folder) and press Enter again.
3. Tell it what it's for. It writes down its own job and gets to work.

Needs Node 22.19+ and one coding agent signed in (Claude is built in and uses your Claude Code login).
Closing the app changes nothing: a small background process keeps your agents running.

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

## How it works

- **An agent is a folder** in `~/overtime/agents/<name>/`: its job in `AGENT.md`, its notes, its
  memory and its skills, all plain files you can read and edit.
- **It keeps its own time.** It decides when to wake next: at a time, on a schedule, or on a *watch*,
  a small script that wakes it the moment something happens. Asleep, it costs nothing.
- **It asks, and keeps going.** A question comes with options and its recommendation; you answer with
  one key. You also get a notification for every question and report.
- **It stays inside your limits**: a daily budget per agent, and paths you protect are read-only to it,
  enforced by the operating system.

The app, every command, backends, memory, the FAQ and recordings of real runs are in
[How Overtime works](docs/how-it-works.md). The run Overtime grew out of (one agent, one brief, a real game engine, no human help)
is in [`examples/open-world-game`](examples/open-world-game).

## Status

Early. Claude is the backend tested most; Codex and Gemini are wired up through their ACP adapters
and need wider testing. Later: answering from your phone, quiet-time tidying, a morning standup,
sharing agents, and running Overtime on a server for around-the-clock watches.

MIT licence.
