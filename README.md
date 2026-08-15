<h1 align="center">AAABench</h1>

<p align="center">
  <strong>Give a coding agent a real game engine, professional conditions and time.<br>
  Ask it to build an open-world game. Then go away.</strong>
</p>

<p align="center">
  <img alt="licence: MIT" src="https://img.shields.io/badge/licence-MIT-black?style=flat-square">
  <img alt="engine: Unreal Engine 5" src="https://img.shields.io/badge/engine-Unreal%20Engine%205-black?style=flat-square">
  <img alt="control: MCP" src="https://img.shields.io/badge/control-MCP-black?style=flat-square">
  <img alt="contains: no results" src="https://img.shields.io/badge/contains-no%20results-black?style=flat-square">
</p>

<p align="center">
  <img src="docs/media/film.gif" alt="The game's entry screen: a title over a live street, traffic moving, a working menu" width="100%">
</p>

<p align="center">
  <em>An agent built this, including the menu. Output of one run, shown to say what the<br>
  benchmark asks for — no run output is committed here beyond these few frames.</em>
</p>

One agent. One Unreal Engine editor, driven live over MCP. A fierce brief, a shelf of production
knowledge, and no human help.

The agent decides everything — the geography, the districts, the roads, the buildings, the people,
the traffic, the weather, the game's own screens, and what to fix when it doesn't work. Nobody
points at anything for it.

```bash
git clone https://github.com/ukanwat/aaabench && cd aaabench
cp -R project AgentCity        # the project skeleton
./bin/setup-capabilities.sh    # plugins, renderer features, python libraries
./bin/run-agent.sh             # boots the editor, hands over the demand, keeps it going
```

> **The one rule.** Provide conditions, resources and the demand — never diagnosis, never the fix,
> never an answer. Whether the model *notices* its own mistakes is the capability being measured,
> so every hint is a result you can no longer claim. See [`HARNESS-RULES.md`](HARNESS-RULES.md).

## What it actually measures

Building a world turns out to be an unusually complete test, because it cannot be faked by
pattern-matching a familiar task:

- **Real-world understanding.** Does the model know how a city works — that deep water decides
  where the port goes, that industry follows the rail, that money builds uphill and upwind, that
  sunlight limits how tall a street can be, that a courthouse grows bail bonds around it? A world
  built without that knowledge looks wrong instantly, to anyone, with no expertise required.
- **Reasoning from causes rather than from examples.** The brief demands that nothing be placed
  because it looked good there. Every district, block and parcel has to be derivable from
  something — geology, water, trade, money, law, time. That is causal reasoning under a load no
  benchmark question puts on it.
- **Long-horizon execution.** Work that cannot fit in one context, across sessions that start
  cold, where the only continuity is what the agent chose to write down. Plans have to survive
  their author. Nothing is resumed for it.
- **Writing.** A world needs a story bible, characters with wants and contradictions, missions,
  radio scripts, signage, brands, street names. The prose is not decoration; it is where the
  design happens, and it is directly readable as quality.
- **Self-verification.** The agent has eyes — viewport capture, play-in-editor, its own
  screenshots — and reference photographs of the real world. Does it look at its own work, notice
  what a stranger would call fake, and fix it without being told? Nobody points at anything for
  it. Whether it *notices* is the measurement.
- **Systems thinking.** Traffic, crowds, time of day, weather, police, economy — independent
  systems that have to cross each other and produce something that behaves, cheaply, in frame
  budget.
- **Engineering under a hostile surface.** A real editor that crashes, an API it has to discover
  rather than recall, tools that fail silently, and a generator whose output has to be validated
  because plausible numbers describe impossible places.

The headline artefact is a playable world. The interesting data is everything above.

## What passing looks like

The bar is not "a level loads". It is a place that survives a stranger looking at it, and a game
that opens like a game.

<table>
  <tr>
    <td width="50%"><img src="docs/media/street.jpg" alt="Third-person character on a city street with traffic and a minimap"></td>
    <td width="50%"><img src="docs/media/map.jpg" alt="A full-screen map with named districts and a player marker"></td>
  </tr>
  <tr>
    <td><em>A street that behaves — traffic, pedestrians, a player in it.</em></td>
    <td><em>The game's own screens, built by the agent: a map with named districts.</em></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/media/city.jpg" alt="The central business district from the air"></td>
    <td width="50%"><img src="docs/media/coast.jpg" alt="The city on its headland seen across open water at a low warm sun"></td>
  </tr>
  <tr>
    <td><em>A city that reads as one from any height.</em></td>
    <td><em>A place, not a level — geography the city had to be built around.</em></td>
  </tr>
</table>

These are from one run, and they are here to show what the demand asks for. They are the only run
output in the repository — everything an agent produces belongs to the run that produced it, not
here.

This repository is **the harness**: everything needed to run the benchmark yourself.

## What's in here

```
PROMPT.md            the demand — this is the benchmark
HARNESS-RULES.md     the line between operating it and doing the agent's job
bin/                 run it, keep it alive, check whether it is working
tools/               what the agent uses: eyes, widgets, image generation
docs/                the handbook it may consult
project/             the Unreal project skeleton
```

| Path | What it is |
|---|---|
| `PROMPT.md` | **The demand.** The brief handed to the agent — scope, standards, what failure looks like, the certification requirements. This is the benchmark. |
| `docs/` | The handbook the agent may consult: production workflow, level pipeline, systems budgets, detail and density, parallelism, the world inventory (hundreds of kinds of real-world object, mined from OpenStreetMap), asset/mocap/map-data/rendering sources, and the engine's version traps. |
| `.claude/skills/` | 21 skill packs — game AI, level design, game feel, shaders, Niagara, Blueprints, Enhanced Input, behaviour trees, physics tuning, camera, dialogue, audio, save systems, performance, and reference-image search. |
| `bin/run-agent.sh` | One session: boots the editor, waits for MCP, hands over the demand, resumes the session if it stops early, relaunches the editor if it dies. |
| `bin/run-many.sh` | Sequential unattended sessions, single-instance locked. |
| `tools/ue_qa.py` | Sensor: viewport capture and inspection so the agent can see its own work. |
| `bin/prep-project.sh` | Creates the project skeleton if you're starting from nothing. |
| `bin/setup-capabilities.sh` | Widens what the agent can reach: enables engine plugins in the `.uproject`, turns on renderer features that are off by default, installs the Python libraries a world generator wants, and the optional local image/mesh/audio tools. Idempotent. |
| `project/` | The project skeleton: `.uproject` with the required plugins, and the config that auto-starts the MCP server. Copy it to `AgentCity/` to begin. |
| `HARNESS-RULES.md` | **Read this.** The line between operating the harness and doing the agent's job. Breaking it invalidates the result. |
| `docs/setup.md` | Install steps end to end, with every trap that cost us time: the Xcode version pin, the separately-shipped Metal toolchain, why `open -a` fails, and the content packs that need one human sign-in. |

### Running unattended

A long run outlives your attention, so these exist to keep one going without a human watching, and
to tell you honestly whether it is working or merely running.

| Path | What it is |
|---|---|
| `bin/supervise.sh` | Keeps exactly one runner alive indefinitely, with exponential backoff so a broken editor or a dead credential cannot turn into a relaunch loop. Honours a pause file so a manual restart cannot race it. |
| `bin/health.sh` | One-shot check: process counts, the MCP bridge, who holds the port, commit age, and whether the agent is *taking turns* rather than merely existing. Exits non-zero if anything is wrong. |
| `bin/restart-agent.sh` | The only safe manual restart: pause the supervisor, stop the runner and agent, verify they are actually dead, then relaunch and release the pause. |

Two lessons are baked into these, and both cost real time to learn. **Counting processes with
`pgrep -f` also matches the shell running your check**, which manufactures phantom duplicates —
`bin/health.sh` counts process trees with an anchored pattern instead. And **a runner and an editor
both being up is not progress**: if something else holds the MCP port, every boot produces an
editor with no bridge and the runner cycles forever. Liveness has to be measured from work done,
not from processes present.

### Optional extras

| Path | What it is |
|---|---|
| `tools/gen-image.py` | On-device image generation for the printed matter a city is covered in — signage, posters, billboards, brands. Runs locally, no API key. |
| `tools/appui.py` | Helper for authoring UMG widgets from Python, for the game's own screens. |

## Prerequisites

Verified on macOS / Apple Silicon; exact versions that worked are recorded in
`docs/setup.md`. Windows should be easier (VibeUE targets it natively); the launch paths in
`bin/run-agent.sh` would need changing. The runner auto-detects whichever engine is installed —
override with `UE_ROOT`.

1. **Xcode** — pin the version your engine release documents as supported, *not* necessarily the
   latest; a too-new Xcode is a documented incompatibility.
   ```bash
   xcodes install <supported-version>
   sudo xcode-select -s /Applications/Xcode-<supported-version>.app
   sudo xcodebuild -license accept
   ```
2. **The Metal toolchain**, which ships separately in Xcode 26 and is the non-obvious blocker —
   UE cannot boot without it:
   ```bash
   xcodebuild -runFirstLaunch
   xcodebuild -downloadComponent MetalToolchain      # ~705 MB
   xcrun -sdk macosx metal --version                 # must print a version
   ```
3. **Unreal Engine** via the Epic Launcher (any recent version; the runner picks the newest
   installed). Take Core Components, the macOS target, Templates and
   Feature Packs, and MetaHuman Core Data. Skip Android/iOS/Linux/tvOS, Engine Source and debug
   symbols to save ~25 GB. (Starter Content no longer exists in current versions.)
4. **An agent CLI** on `PATH`, authenticated. `claude` by default.
5. Optional but useful to the agent: **Blender** (headless asset authoring), **ffmpeg**.

## Running a session

```bash
git clone https://github.com/ukanwat/aaabench && cd aaabench
cp -R project AgentCity && mv AgentCity/AgentCity.uproject AgentCity/   # project skeleton
./bin/run-agent.sh
```

`bin/run-agent.sh` will:

1. launch the editor with an absolute project path, `-unattended -nosplash -NoPause`
   (a modal dialog freezes the game thread and kills the MCP transport, so never run the editor
   interactively for a session);
2. poll `http://127.0.0.1:8123/mcp` until it answers `405` — which is what an MCP endpoint
   correctly returns for a GET — and kill any `CrashReportClient` squatting on the port;
3. hand `PROMPT.md` to the agent with the MCP config attached;
4. if the session ends with most of its time unused, **resume the same session** rather than
   starting a new one, so its plan survives;
5. relaunch the editor between nudges if it has crashed.

Everything the agent makes lands in your project: assets under `Content/`, its own plan and
progress documents at the project root, screenshots wherever `tools/ue_qa.py` writes them.

### Running a different agent

The harness is agent-agnostic. `AGENT` selects the CLI; add your own preset in `agent_run()`.

```bash
AGENT=claude MODEL=claude-opus-5 ./bin/run-agent.sh
AGENT=codex ./bin/run-agent.sh
AGENT=gemini ./bin/run-agent.sh
AGENT=custom AGENT_CMD='my-cli --headless "$1"' ./bin/run-agent.sh
```

The only requirements on a candidate: it runs headless from a prompt on argv, has shell and file
access, can reach an HTTP MCP endpoint, and exits when it's finished.

### Tuning

| Variable | Default | Meaning |
|---|---|---|
| `AGENT` | `claude` | which CLI is under test |
| `MODEL` | `claude-opus-5` | pin the exact model id — bare aliases have been observed resolving to a different generation between sessions, which silently destroys comparability |
| `MAX_NUDGES` | `4` | how many times to resume after a clean stop before giving up |
| `MCP_PORT` | `8123` | keep it off common ports; a service already listening reads as a slow editor boot and costs hours |
| `NOTE` | unset | a file prepended to the demand, for restarts ("prior work stands, here is what changed") |

## The control surface the agent gets

Epic's built-in MCP server plus [VibeUE](https://github.com/vibeue/VibeUE) (MIT), which registers
**31 service toolsets and 85 skills into Epic's endpoint** — there is no separate VibeUE server.
That covers actor spawning and properties, lights, assets, Play-In-Editor, viewport capture,
Blueprint graph authoring, materials and MetaSounds, animation, Niagara, UMG, landscape and
profiling. `execute_python_code` runs whole batch scripts against the full `unreal.*` API in one
call, and `discover_python_class` / `discover_python_function` let it find an API rather than
guess one.

VibeUE is not vendored here. Clone it into `AgentCity/Plugins/` and compile it against the
project target — its own `RunUAT BuildPlugin` fails on Apple Silicon, defaulting to x64 and
dying on a PCH mismatch:

```bash
"$UE_ROOT/Engine/Build/BatchFiles/Mac/Build.sh" \
  AgentCityEditor Mac Development -Project="$PWD/AgentCity/AgentCity.uproject" -waitmutex
```

Never leave an uncompiled C++ plugin in `Plugins/` — the editor tries to build it at launch and
quits with *"Incompatible or missing module"*.

## Rules of the experiment

`HARNESS-RULES.md` is the short version: **provide conditions, resources and the demand — never
diagnosis, never the fix, never an answer.** Restart a dead session, relaunch a crashed editor,
repair a path that resolves to nothing, back the work up. Do not tell the agent what is wrong
with its build, do not hand it a working API call, do not edit its files. Whether the model
*notices* its own mistakes is the capability being measured; every hint is a result you can no
longer claim.

Keep a contamination log and publish it. Ours is at the bottom of `HARNESS-RULES.md`.

## Traps worth knowing before you start

- `open -a UnrealEditor.app project.uproject` hands UE a **relative** path and it looks inside
  the engine folder. Always exec the binary in the bundle with an absolute path.
- Two editor processes fight over the project lock and the MCP port, and the second usually
  crashes. `bin/run-many.sh` holds a single-instance lock; don't run two launchers.
- `CrashReportClient` inherits the MCP port and silently blocks the next editor from binding it.
- MCP auto-start only applies at editor **startup**; toggling it in a running editor does
  nothing until relaunch.
- Set `EditorStartupMap` to your own map once one exists. The default opens an empty engine map,
  and a session that forgets to load the real one will build a city into nothing.
- Long document-writing produces **zero** MCP calls for many minutes. Any watchdog that
  fingerprints only tool activity will kill a session that is thinking. We removed ours and
  supervise interactively instead.
- Heavy asset churn from Python can trip an RHI resource-lifetime assertion and take the editor
  down. Expect it, and make sure a crash is survivable rather than fatal to the run.

## Licence

Harness: MIT. `docs/sources/` records where third-party assets come from and under what terms;
the demand forbids using anything extracted from, ripped from or imitating an existing game.
