#!/usr/bin/env bash
# Run this once the engine finishes installing. It discovers what the MCP plugin
# is ACTUALLY called in this build (the name differs between docs and releases),
# enables it in the project, and verifies the toolchain is ready.
set -uo pipefail
cd "$(dirname "$0")"

ENGINE_DIR="${1:-/Users/Shared/Epic Games/UE_5.8}"
PROJ="AgentCity/AgentCity.uproject"

echo "engine: $ENGINE_DIR"
[ -d "$ENGINE_DIR" ] || { echo "NOT FOUND — is the install finished? Pass the path if it's elsewhere."; exit 1; }

CMD="$ENGINE_DIR/Engine/Binaries/Mac/UnrealEditor-Cmd"
APP="$ENGINE_DIR/Engine/Binaries/Mac/UnrealEditor.app"
for f in "$CMD" "$APP"; do
  [ -e "$f" ] && echo "  ok: $(basename "$f")" || echo "  MISSING: $f"
done

echo
echo "=== searching for MCP / Python / MetaHuman plugins in this build ==="
find "$ENGINE_DIR/Engine/Plugins" -name "*.uplugin" 2>/dev/null | while read -r p; do
  n="$(basename "$p" .uplugin)"
  case "$(echo "$n" | tr 'A-Z' 'a-z')" in
    *mcp*|*modelcontext*|*toolset*) echo "  MCP-ish:      $n" ;;
    pythonscriptplugin|editorscriptingutilities) echo "  scripting:    $n" ;;
    *metahuman*) echo "  metahuman:    $n" ;;
  esac
done

echo
echo "=== verifying the exact plugins we need exist in this build ==="
for p in ModelContextProtocol ToolsetRegistry AllToolsets PythonScriptPlugin EditorScriptingUtilities; do
  if find "$ENGINE_DIR/Engine/Plugins" -name "$p.uplugin" | grep -q .; then echo "  ok: $p"; else echo "  MISSING: $p"; fi
done
echo "(the project already enables exactly these — no greedy auto-enable)"

echo
echo "next: ./run-agent.sh   (boots editor with the project, waits for MCP, runs the agent)"
