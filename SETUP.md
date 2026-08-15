# Setup — the one part that needs you (Epic sign-in)

Everything else is pre-built: the project skeleton, plugin enablement, MCP
config, harness script, and agent prompt.

## Your steps in the Launcher (just opened)

1. **Sign in** with your Epic account (create one if needed — it's free).
2. Top nav → **Unreal Engine** → **Library** → click **+** next to ENGINE VERSIONS
   → pick **5.8** → **Install**.
3. In the install dialog, hit **Options** and DESELECT to save ~25 GB:
   - Android, iOS, Linux, tvOS target platforms
   - Engine Source (not needed — we drive the editor, not modify it)
   - Editor symbols for debugging
   Keep: **Core Components**, **Templates and Feature Packs**, **MetaHuman Core Data**
   (note: Starter Content no longer exists — Epic removed it in 5.6+)
4. Install to the default location (`/Users/Shared/Epic Games/UE_5.8`) — the
   harness looks there.
5. Wait for download (~35–60 GB; you have 231 GB free, plenty).

That's it. Don't create a project — one already exists at
`ue-agent-experiment/AgentCity/AgentCity.uproject` with the needed plugins
pre-enabled (PythonScriptPlugin, EditorScriptingUtilities, ModelContextProtocol,
ToolsetRegistry, AllToolsets), and MCP auto-start baked into
`AgentCity/Config/DefaultEditorPerProjectUserSettings.ini`. No plugin clicking, no
Editor Preferences toggling, no console commands needed.

## VibeUE — DONE (compiled and live)

`AgentCity/Plugins/VibeUE` (branch 5-8, MIT), compiled against UE 5.8.1.

Key facts learned the hard way:
- Its own `BuildAndLaunchGame.sh` / `RunUAT BuildPlugin` **fails on Apple Silicon** —
  it targets x64 and dies on a PCH mismatch. What works is compiling it against the
  project target:
  ```bash
  "/Users/Shared/Epic Games/UE_5.8/Engine/Build/BatchFiles/Mac/Build.sh" \
    AgentCityEditor Mac Development -Project="$PWD/AgentCity/AgentCity.uproject" -waitmutex
  ```
  68 targets, ~41s. (Its docs claim Windows/Linux only — macOS works fine this way.)
- **There is no separate VibeUE server on 8088.** It registers into Epic's endpoint:
  31 service toolsets, 7 tools, and **85 skills** on `http://127.0.0.1:8000/mcp`.
- Never leave it uncompiled inside `Plugins/` — the editor tries to build it on launch
  and quits with "Incompatible or missing module".

## Then tell me, and I run:

```bash
cd ~/development/ue-agent-experiment && ./run-agent.sh
```

which boots the editor with the project, waits for the MCP server on
`127.0.0.1:8000`, and hands the job to `claude -p`.

## If the MCP endpoint doesn't come up

The Unreal MCP plugin is experimental in 5.8 and its exact plugin name may
differ from `UnrealMCP`. If the harness reports the endpoint never appeared:
1. In the editor: Edit → Plugins → search "MCP" → note the real name → enable it
   (+ "AllToolsets") → restart.
2. Edit → Editor Preferences → Model Context Protocol → **Auto-start: ON**.
3. In the editor console (`~`): `ModelContextProtocol.GenerateClientConfig ClaudeCode`
4. Rerun `./run-agent.sh`.

Fallback if MCP proves unusable: the agent can still work through Python editor
scripting (`UnrealEditor-Cmd ... -run=pythonscript`) — slower, no live viewport
feedback, but functional. Tell me and I'll rewire the harness that way.

## Content that needs one human login (worth doing — big realism wins)

None of this can be fetched headlessly: Fab has no public CLI or API for library downloads, so a
human must sign in once and click **Add to My Library**. After that, the Epic Games Launcher can
download it and the assets are local forever.

In priority order:

1. **Game Animation Sample** — 500+ AAA motion-captured animations with a working Motion
   Matching setup (locomotion, pivots, jumps, ledges, vaults, slides). This is the single biggest
   realism upgrade available, and `PoseSearch` is enabled with nothing to search until you have
   it. Free.
2. **City Sample** (~88 GB) — the only place **MassTraffic** ships: lane-based vehicle traffic
   with intersection management coordinated with pedestrian crossings. Also 13 driveable
   vehicles, 2,000+ modular building meshes, and MetaHuman-derived crowd characters. Sub-packs
   (City Sample Buildings / Vehicles / Crowds) can be added separately if the full project is too
   large. Free, UE-only licence.
3. **Electric Dreams** — a PCG-driven environment that bundles a curated set of Megascans assets
   as project content. This is now the *only* free route to Megascans: the free-with-UE era ended
   in 2025 and Megascans are paid per-asset on Fab. Vegetation and rock heavy, so it helps the
   rural and coastal edges more than the city. Free.
4. **Paragon character packs** — 39 AAA-quality characters with animation sets, free under a
   UE-only licence. UE4-era skeletons, so they need retargeting.

Steps: Epic Games Launcher → sign in → **Fab** → search the name → **Add to My Library** →
**Library** → find it under Fab Library → **Install to project** (or Download). Then tell the
agent nothing; let it find the content itself.

Two API keys also worth registering for (free, no card), because they unlock a lot:
**Freesound** (700K sounds, CC0-filterable — `freesound.org/apiv2/apply`) and **Sketchfab**
(programmatic CC0 model download — `sketchfab.com/settings#api`). Put them in the environment
before launching a session.
