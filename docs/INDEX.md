# Handbook index — UE agent experiment

Read `../PROMPT.md` (the job) first. Everything here is reference; load what you need.

## workflow/ — how professionals build this
- [phases.md](workflow/phases.md) — production phases and their exit gates
- [level-pipeline.md](workflow/level-pipeline.md) — blockout → set dress → lighting → polish
- [metrics.md](workflow/metrics.md) — real-world dimensions and conventions
- [parallel.md](workflow/parallel.md) — subagent lanes and the barriers (note: UE limits
- [game-content.md](workflow/game-content.md) — what a complete game contains:
  mission counts/anatomy from shipped titles, story arc, cast size, cheap narrative,
  and the minimum viable content set in priority order
- [systems.md](workflow/systems.md) — genre systems with REAL parameters: wanted-level
- [detail-density.md](workflow/detail-density.md) — how "thousands of unique things"
- `workflow/world-inventory.md` — the catalogue: hundreds of KINDS of thing a map contains (infrastructure, utilities, transport, industry, street furniture, signage, life) and how to place them so they read as systems, not scatter
  is really done: combinatorial variation maths, per-block density targets, and the
  eye-height detail pass (wear, contact, edges, verticality, lit windows, ground)
  thresholds and search radii, police tiers, driving handling values, cover/aim-assist,
  economy rates, streaming budgets, POI density, audio stack, game-feel timings, triage
  parallel building — binary assets can't merge and one process owns the editor)

## tech/ — driving Unreal without a GUI
- `tech/capabilities.md` — the full capability surface: which engine plugins are switched on (MetaHuman, Chaos vehicles, Mass crowds and traffic, Motion Matching, PCG, GeometryScript, Water), the Python libraries available, how to make signage and billboard art (fonts, code, in-engine, on-device image generation), and the other tools on the machine
- [control.md](tech/control.md) — MCP tools, Python editor scripting, what works headless
- [feedback.md](tech/feedback.md) — how to SEE the game (viewport capture, PIE, screenshots)

## Skills — use VibeUE's, they ship with the plugin
`AgentCity/Plugins/VibeUE/Content/Skills/` contains **35 authored skill packs**:
blueprint-graphs · blueprints · materials · metasounds · sound-cues · niagara-emitters ·
niagara-systems · animation-blueprint · animation-editing · animation-montage ·
animsequence · skeleton · landscape · landscape-materials · landscape-auto-material ·
terrain-data · pcg · foliage · level-actors · map-blockout · umg-widgets ·
enhanced-input · gameplay-tags · enum-struct · asset-management · uv-mapping ·
viewport · pie-testing · profiling · frame-rate · project-settings · engine-settings ·
fab · vibeue.

Discover and load them at runtime with the MCP tools `ListSkills` / `GetSkills` —
don't guess an API, read the skill for that domain first.

Also installed in `.claude/skills/`: **reference-images** (keyless image search →
download → Read, so you can actually look at real photographs), plus community packs: **unreal-blueprints ·
unreal-cpp-gameplay · unreal-behavior-trees · unreal-enhanced-input ·
unreal-niagara · unreal-packaging**, plus engine-agnostic craft disciplines
(game-feel · level-design · camera-systems · performance-optimization ·
physics-tuning · procedural-gen · audio-design · game-ui-ux · shader-programming ·
input-systems · dialogue-systems · game-ai · save-systems).

## sources/ — getting assets in
- `sources/verified-2026-08.md` — sources tested live with the login walls named: Objaverse and Poly Haven and Smithsonian for models, MPFB2 and 100STYLE and Mixamo for humans, Overture and Geofabrik and Microsoft footprints for real-world data, Sonniss and Freesound and EchoThief impulse responses for sound
- [engine-content.md](sources/engine-content.md) — what ships locally and is free to use
- [importing.md](sources/importing.md) — headless import API per format
- [open-sources.md](sources/open-sources.md) — login-free external sources (and the walls)
