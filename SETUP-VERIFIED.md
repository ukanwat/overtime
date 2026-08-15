# Verified setup (what actually works)

Every item below was tested on this machine — macOS, Apple Silicon (M4 Max).

## Prerequisites, in the order they matter
1. **Xcode 26.1.1** (NOT the latest — UE 5.8 documents 26.4 as incompatible).
   Installed with `xcodes` (already on PATH): `xcodes install 26.1.1`,
   then `sudo xcode-select -s /Applications/Xcode-26.1.1.app`
   and `sudo xcodebuild -license accept`.
2. **Xcode components + Metal toolchain** — the non-obvious blocker. UE cannot even
   boot without the Metal compiler, and in Xcode 26 it ships separately:
   ```
   xcodebuild -runFirstLaunch
   xcodebuild -downloadComponent MetalToolchain      # ~705 MB
   xcrun -sdk macosx metal --version                 # must print a version
   ```
3. **UE 5.8.1** via Epic Launcher. Components: core + macOS target + Templates +
   MetaHuman Core Data. Skip Android/iOS/Linux/tvOS, Engine Source, debug symbols.
   Starter Content no longer exists (removed in 5.6+).

## Project
`AgentCity/AgentCity.uproject` enables exactly: PythonScriptPlugin,
EditorScriptingUtilities, ModelContextProtocol, ToolsetRegistry, AllToolsets.

**Do not put an uncompiled C++ plugin in `AgentCity/Plugins/`** — the editor tries to
build it on launch and quits with "Incompatible or missing module". That is why
VibeUE lives in `vendor/` until it compiles.

## MCP server (no GUI steps needed any more)
`AgentCity/Config/DefaultEditorPerProjectUserSettings.ini` now contains:
```
[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]
bAutoStartServer=True
ServerPortNumber=8000
bEnableToolSearch=True
```
(Keys come from the plugin's shipped source — `ModelContextProtocolSettings.h`.)
Auto-start only takes effect at editor **startup**, so toggling it in a running
editor does nothing until relaunch. Verify with:
```
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/mcp   # 405 == alive
lsof -nP -iTCP:8000 -sTCP:LISTEN
```

## Launching
Never `open -a UnrealEditor.app project.uproject` — UE receives a relative path and
looks for the project inside the engine folder. Always:
```
"/Users/Shared/Epic Games/UE_5.8/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor" \
  "/abs/path/AgentCity/AgentCity.uproject"
```
First boot compiles Metal shaders (several minutes); later boots ~20s.

## VibeUE (optional upgrade, not yet working)
`vendor/VibeUE` (branch 5-8). Standalone `RunUAT BuildPlugin` fails on macOS: it
defaults to **x64** and dies on a PCH mismatch (`Build/Mac/x64/… SharedPCH … not
found`). Next approach: move it into `AgentCity/Plugins/` and let the editor build
it in-project now that the SDK exists — requires an editor restart, so do it between
agent sessions.
