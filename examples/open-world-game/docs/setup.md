# Setup

Two things need a human: installing the engine, and one Epic sign-in for the free content packs.
Everything else — the project skeleton, plugin enablement, MCP config, the runner — is scripted.

Verified on macOS / Apple Silicon. Windows should be easier, since the MCP plugin targets it
natively; the launch paths in `bin/run-agent.sh` would need changing. The runner auto-detects
whichever engine is installed — override with `UE_ROOT`.

## 1. Xcode, and the trap inside it

Pin the Xcode version your engine release documents as supported, **not** necessarily the latest.
A too-new Xcode is a documented incompatibility, not a warning you can ignore.

```bash
xcodes install <supported-version>
sudo xcode-select -s /Applications/Xcode-<supported-version>.app
sudo xcodebuild -license accept
```

Then the **Metal toolchain**, which ships separately in recent Xcode and is the non-obvious
blocker — Unreal cannot boot without it:

```bash
xcodebuild -runFirstLaunch
xcodebuild -downloadComponent MetalToolchain      # ~705 MB
xcrun -sdk macosx metal --version                 # must print a version
```

## 2. Unreal Engine

Install via the Epic Launcher. In the install dialog hit **Options** and deselect, to save ~25 GB:

- Android, iOS, Linux, tvOS target platforms
- Engine Source — not needed, the harness drives the editor rather than modifying it
- Editor symbols for debugging

Keep **Core Components**, the **macOS target**, **Templates and Feature Packs**, and **MetaHuman
Core Data**. Starter Content no longer exists; Epic removed it in 5.6+.

Install to the default location so the runner can find it. Expect 35–60 GB.

**Don't create a project.** Copy the skeleton instead:

```bash
cp -R project AgentCity
```

It enables the plugins the harness needs and bakes MCP auto-start into
`project/Config/DefaultEditorPerProjectUserSettings.ini`, so there is no plugin clicking, no
Editor Preferences toggling and no console commands.

Then widen the capability surface:

```bash
./bin/setup-capabilities.sh
```

## 3. Launching, and two ways to get it wrong

```bash
./bin/run-agent.sh
```

Never `open -a UnrealEditor.app project.uproject`. Unreal receives a **relative** path that way
and looks for the project inside the engine folder. Always exec the binary inside the bundle with
an absolute project path — which is what the runner does:

```bash
"$UE_ROOT/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor" \
  "/abs/path/AgentCity/AgentCity.uproject"
```

First boot compiles Metal shaders and takes several minutes. Later boots are much faster, though
a large level slows cold boot considerably — the runner waits up to 20 minutes for that reason.

Verify the bridge by hand if you want:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8123/mcp   # 405 == alive
lsof -nP -iTCP:8123 -sTCP:LISTEN
```

**405 is the correct answer**, not an error — it is an MCP endpoint refusing a GET. Anything else
answering on that port is a squatter, usually a crash reporter.

## 4. If the MCP endpoint never comes up

The MCP plugin is experimental and its exact plugin name can differ by version.

1. In the editor: Edit → Plugins → search "MCP" → note the real name → enable it, plus
   "AllToolsets" → restart.
2. Edit → Editor Preferences → Model Context Protocol → **Auto-start: ON**.
3. Auto-start only takes effect at editor **startup**. Toggling it in a running editor does
   nothing until relaunch.
4. Rerun the harness.

Fallback if MCP proves unusable: the agent can still work through Python editor scripting
(`UnrealEditor-Cmd … -run=pythonscript`) — slower, and with no live viewport feedback.

## 5. The extended toolset (optional, and worth it)

Epic's built-in MCP server covers a lot. [VibeUE](https://github.com/vibeue/VibeUE) (MIT)
registers **31 service toolsets and 85 skills into Epic's endpoint** — there is no separate
server. That adds Blueprint graph authoring, materials and MetaSounds, Niagara, UMG, landscape
and profiling.

It is not vendored here. Clone it into `AgentCity/Plugins/` and compile it against the project
target — its own `RunUAT BuildPlugin` fails on Apple Silicon, defaulting to x64 and dying on a
PCH mismatch:

```bash
"$UE_ROOT/Engine/Build/BatchFiles/Mac/Build.sh" \
  AgentCityEditor Mac Development -Project="$PWD/AgentCity/AgentCity.uproject" -waitmutex
```

**Never leave an uncompiled C++ plugin in `Plugins/`.** The editor tries to build it at launch and
quits with *"Incompatible or missing module"*.

## 6. Content that needs one human login

None of this can be fetched headlessly — Fab has no public CLI or API for library downloads, so a
human must sign in once and click **Add to My Library**. After that the Launcher can download it
and the assets are local forever.

In priority order:

1. **Game Animation Sample** — 500+ motion-captured animations with a working Motion Matching
   setup: locomotion, pivots, jumps, ledges, vaults, slides. The single biggest realism upgrade
   available, and `PoseSearch` is enabled with nothing to search until you have it. Free.
2. **City Sample** (~88 GB) — the only place **MassTraffic** ships: lane-based vehicle traffic with
   intersection management coordinated with pedestrian crossings. Also driveable vehicles, 2,000+
   modular building meshes, and crowd characters. Sub-packs (Buildings / Vehicles / Crowds) can be
   added separately if the full project is too large. Free, engine-only licence.
3. **Electric Dreams** — a PCG-driven environment bundling a curated set of Megascans assets as
   project content. Now the only free route to Megascans. Vegetation and rock heavy, so it helps
   rural and coastal edges more than the city. Free.
4. **Paragon character packs** — characters with animation sets, free under an engine-only
   licence. Older skeletons, so they need retargeting.

Launcher → sign in → **Fab** → search the name → **Add to My Library** → **Library** → find it
under Fab Library → **Install to project**. Then tell the agent nothing; let it find the content
itself.

Two free API keys are also worth registering for, because they unlock a lot: **Freesound**
(`freesound.org/apiv2/apply`) and **Sketchfab** (`sketchfab.com/settings#api`). Put them in
`keys.env` at the repo root — the runner sources it into the session environment, so the agent
discovers them as capabilities rather than being told they exist. It is gitignored; never commit
it.
