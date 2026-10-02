# Controlling Unreal without a GUI

Two surfaces. Prefer MCP for live scene work, Python for bulk asset operations.

## 0. VibeUE — the main toolset (installed at `AgentCity/Plugins/VibeUE`)
Extends Epic's native MCP with 32 Python services (~1,000 methods) and 35 skill
packs. Its workhorse tool is **`execute_python_code`** — send a batch script that
calls any `unreal.*` API or VibeUE service in one round-trip, instead of dozens of
small tool calls. Other core tools: `discover_python_module` / `discover_python_class`
/ `discover_python_function` (introspect the API instead of guessing),
`list_python_subsystems`, `ListSkills` / `GetSkills`, `screenshot`, terrain tools,
and profiler tools (`frame_timing`, `start_trace`/`stop_trace`, `analyse`).
It also wraps edits in the editor's transaction buffer, so a bad batch can be undone.
Endpoint: `http://127.0.0.1:8088/mcp` (Epic's own server is on 8000).

**What it unlocks that Epic's plugin can't:** real Blueprint *graph* authoring
(`BuildGraph`, node/pin wiring, custom events, dispatchers, graph diffs), material
node graphs, MetaSound/SoundCue graphs, AnimBP + montage + skeleton editing,
Niagara, UMG with MVVM, StateTrees, landscape sculpting and auto-materials.

Rule: **read the relevant skill pack (`GetSkills`) before working in a domain**, and
use `discover_python_class` rather than guessing method names.

## 1. Epic's built-in MCP (live editor)
Epic's Unreal MCP plugin runs an HTTP+SSE server inside the *running* editor at
`http://127.0.0.1:8000/mcp`. The harness starts the editor and waits for it. Toolsets
seen in 5.8: scene composition, actor spawn/transform, object property setting,
material instances, PIE start/stop, viewport capture. Names may drift — list your
tools at session start and work with what's actually there.

Requires a rendering editor. It is **experimental** in 5.8 — if a tool errors, fall
back to Python rather than fighting it.

## 2. Python editor scripting (bulk, scriptable, headless-capable)
```bash
UE=/Users/Shared/Epic\ Games/UE_5.8/Engine/Binaries/Mac/UnrealEditor-Cmd
"$UE" "$PWD/AgentCity/AgentCity.uproject" -run=pythonscript \
      -script="/abs/path/script.py" -stdout -FullStdOutLogOutput -unattended
```
- `-nullrhi` makes it faster but disables rendering entirely → **no screenshots**. Only
  use it for pure data work (imports, property setting, asset creation).
- Useful entry points: `unreal.EditorAssetLibrary`, `unreal.AssetToolsHelpers`,
  `unreal.EditorLevelLibrary` / `LevelEditorSubsystem`, `unreal.EditorActorSubsystem`.
- Always finish with `unreal.EditorAssetLibrary.save_all_dirty_packages()`.

## Rules
- **Never** edit `.umap` / `.uasset` as text — they're binary. Work through the APIs.
- Prefer Blueprint + Python over C++: a C++ change costs a 3–15 minute compile and will
  eat the session.
- One process owns the editor. Don't try to run two editors against one project.
