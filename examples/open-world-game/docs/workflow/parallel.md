# Subagents — when to fan out, and when it makes things worse

You can spawn subagents. A city is too much for one context, and a focused
subagent with a clean window behaves like a specialist rather than a tired
generalist. But the evidence on multi-agent work is genuinely mixed, so the rules
below are not bureaucracy — they are the difference between speed-up and wreckage.

## The barrier that unlocks everything: the contract
Studios use the **greybox** as the contract — once the layout is frozen in grey
boxes, mission scripting, audio, lighting and art can all proceed in parallel
against it.

Your equivalent, and you must write it BEFORE spawning anyone:
1. The module/file map — who owns which files (see below).
2. The interfaces — what each module exports and consumes (state shape, event
   names, the `window.__game` fields).
3. Per-lane acceptance criteria — what "done" means, measurably.

No contract = each subagent resolves ambiguity differently = locally sensible,
globally incompatible code that only fails at integration.

## Model discipline
Spawn every subagent with the model set explicitly — `Task(..., model="claude-opus-5")`.
Never omit the parameter and never use the bare `opus` alias (it has resolved to an older
Opus on some sessions). Do not let a lane default to a
cheaper tier: research, writing, script authoring and critique are all judgement work, and
one weak lane lowers the ceiling of everything it touches. (Cost is not a constraint on
this run; quality is the only metric.)

## Five conditions — fan out only if ALL hold
1. Three or more genuinely independent pieces of work exist.
2. File sets are **disjoint** — no two lanes write the same file, ever.
3. Each lane has a measurable acceptance criterion.
4. The work is big enough to justify coordination overhead.
5. The lanes need different focus, not just different labels.

## Natural lanes for this project
| lane | owns | consumes |
|---|---|---|
| world/city | `src/city/*`, `src/world.js` | config, metrics |
| vehicles | `src/vehicles/*` | config, world collision API |
| characters + animation | `src/people.js`, animation code | config, world |
| missions + story | `src/missions/*`, `phone.js`, story data | game state API |
| audio + radio | `src/audio/*`, `radio.js` | event bus |
| UI/HUD | `src/hud.js`, `ui.js` | game state API |
| asset sourcing | `game/assets/*`, `ASSETS.md` | nothing (perfectly parallel) |
| lighting/post | `src/sky.js`, `src/post.js` | stable geometry |

Sourcing and research lanes are the safest fan-out: they write to their own
directories and block nobody. Lighting should wait for stable geometry.

## Verification runs free — always do this
Read-only critics never conflict with builders, and this is the single
best-evidenced multi-agent win (generate → critique → revise roughly doubled fix
rates in published benchmarks, *provided the critic actually executes things*):
- a screenshot critic that runs a screenshot script it wrote, LOOKS at the images, and
  reports what a stranger would call fake;
- a perf prober running a perf script it wrote against the budgets;
- a playtest scripter driving synthetic input and reporting what broke.

A critic that only reads code and opines is worthless. It must run, look, measure.

## Never parallelize
- **Architecture, file structure, naming, data model** — one voice, or you get
  two incompatible engines.
- **A bug that spans coupled files** — one agent holding all three beats three
  agents holding one each.
- **Integration** — the wiring pass is single-threaded and sees everything.
- **Aesthetic consistency** — art direction, palette, tone, writing voice.
- **Anything that fits comfortably in one context** — pure overhead.

## Honest limits (don't ignore these)
On sequential reasoning tasks with equal token budgets, multi-agent setups have
measured *worse* than a single agent — by 40–50% in published comparisons. Much
of the reported multi-agent magic is simply more tokens spent. Coordination costs
2–15× the tokens. Documented failure modes: duplicated work, lanes ignoring the
spec, premature "done", and information withheld from the orchestrator.

Practical guidance: **4–6 parallel lanes maximum.** Prefer one strong builder plus
running critics over six builders. Fan out for breadth (sourcing, independent
systems); stay single-threaded for depth (architecture, integration, feel).

## Your loop as orchestrator
contract → (fan out independent lanes) → integrate yourself → run the critics →
fix what they find → repeat. Never let a lane merge its own work into the running
game, and never end a session with the game broken.
