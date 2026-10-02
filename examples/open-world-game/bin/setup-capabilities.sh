#!/usr/bin/env bash
# Give the agent maximum capability. Idempotent — safe to re-run.
#
#   ./bin/setup-capabilities.sh [/abs/path/to/Project.uproject]
#
# Three things happen here:
#   1. engine plugins are enabled in the .uproject (a plugin the project has not enabled is
#      unreachable to the agent, because turning one on needs an editor restart and the agent
#      does not control the launcher)
#   2. Python libraries a world generator wants are installed for the interpreter the agent
#      will actually invoke
#   3. optional local tools: an on-device image generator for signage and billboard art, and
#      mesh/texture CLIs
set -uo pipefail
cd "$(dirname "$0")/.."   # anchor at the repo root
PROJECT="${1:-$(ls -1 "$PWD"/*/*.uproject 2>/dev/null | head -1)}"

# ---------------------------------------------------------------- 1. engine plugins
if [ -n "${PROJECT:-}" ] && [ -f "$PROJECT" ]; then
  cp "$PROJECT" "$PROJECT.bak"
  python3 - "$PROJECT" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
have = {x["Name"] for x in d.get("Plugins", [])}
WANT = [
    # control surface
    "PythonScriptPlugin", "EditorScriptingUtilities", "ModelContextProtocol",
    "ToolsetRegistry", "AllToolsets",
    # world building
    "PCG", "GeometryScripting", "ModelingToolsEditorMode", "Water", "Landmass",
    # characters
    "MetaHumanCharacter", "MetaHumanGenerator", "MetaHumanCharacterUAF", "MetaHuman",
    # animation
    "PoseSearch", "MotionTrajectory", "AnimationLocomotionLibrary",
    "ContextualAnimation", "Chooser", "AnimationBudgetAllocator",
    # interaction animation: ContextualAnimation aligns two actors and plays synchronised
    # montages (the enter/exit-a-vehicle case); MotionWarping bends the montage so the hand
    # lands on the actual handle from any approach angle. Without warping it plays in place.
    "MotionWarping", "AnimationWarping",
    # capture: Takes (Take Recorder) records a live play session into a LevelSequence, which
    # MovieRenderPipeline then renders OFFLINE at full quality — so gameplay footage is not limited
    # by interactive frame rate. SequencerScripting exposes sequence authoring to Python.
    "Takes", "SequencerScripting", "LevelSequenceEditor",
    # vehicles
    "ChaosVehiclesPlugin",
    # crowds and traffic at scale
    "MassEntity", "MassGameplay", "MassAI", "MassCrowd",
    "ZoneGraph", "ZoneGraphAnnotations", "SmartObjects", "StateTree", "GameplayBehaviors",
    # crowds at scale, character variation, capture, abilities
    "Mutable", "MetaHumanCrowd", "RemoteControl", "MovieRenderPipeline",
    "GameplayAbilities", "GeometryCollectionPlugin", "Mover",
    # import and effects
    "USDImporter", "NiagaraFluids", "ProceduralVegetationEditor",
    # misc
    "Text3D",
]
# A plugin named in the .uproject that is missing on disk makes the editor ABORT at startup,
# so only enable what actually exists in this engine install.
import glob, os
roots = [os.environ.get("UE_ROOT") or ""]
roots += sorted(glob.glob("/Users/Shared/Epic Games/UE_*"))
on_disk = set()
for r in roots:
    if r:
        on_disk |= {os.path.basename(f)[:-8]
                    for f in glob.glob(os.path.join(r, "Engine/Plugins/**/*.uplugin"), recursive=True)}
missing = [n for n in WANT if on_disk and n not in on_disk]
if missing:
    print("  not in this engine, skipped:", ", ".join(missing))
added = [n for n in WANT if n not in have and (not on_disk or n in on_disk)]
for n in added:
    d.setdefault("Plugins", []).append({"Name": n, "Enabled": True})
json.dump(d, open(p, "w"), indent=1)
print(f"  plugins: {len(d['Plugins'])} enabled ({len(added)} added)")
PY
  echo "  a backup is at $PROJECT.bak — run-agent.sh restores it if the editor won't boot"
else
  echo "  no .uproject found; skipping plugin step"
fi

# ------------------------------------------------ 1b. renderer features that are OFF by default
# Some capabilities are gated behind project settings rather than plugins, and the only symptom of
# a disabled one is that content silently renders wrong. Nanite Foliage is the case that bit us:
# the editor prints "A Nanite Assembly asset was encountered while Nanite Assemblies are currently
# disabled" and otherwise carries on, so assembled/scanned foliage looks broken for a reason
# nothing in the scene explains. These need an editor restart to take effect.
if [ -n "${PROJECT:-}" ] && [ -f "$PROJECT" ]; then
  INI="$(dirname "$PROJECT")/Config/DefaultEngine.ini"
  if [ -f "$INI" ]; then
    python3 - "$INI" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
WANT = {
    "r.Nanite.Foliage": "True",              # also required for Nanite Assembly assets
    "r.MegaLights.EnableForProject": "True", # many small emitters: a night city
    "r.HeterogeneousVolumes": "1",           # real volumetrics: smoke, steam, fog banks, cloud
    "r.HeterogeneousVolumes.Shadows": "1",   # and those volumes cast/receive shadow
    "r.Nanite.Tessellation": "1",            # displacement on Nanite meshes: true surface relief
}
# Deliberately NOT set here, and the reason is worth keeping:
#   r.Substrate=1                 rewrites the material system and auto-converts every existing
#                                 material. On a project whose look rests on a few hand-built
#                                 master materials that is a real risk of losing work, plus a
#                                 full shader rebuild. It is a decision, not a default.
#   r.Lumen.HardwareRayTracing=1  support and performance vary by platform; turning it on blind
#                                 can cost more frame time than it buys.
block = "[/Script/Engine.RendererSettings]"
if block not in s:
    s += "\n" + block + "\n"
i = s.index(block) + len(block)
for k, v in WANT.items():
    if re.search(rf"^{re.escape(k)}\s*=", s, re.M):
        s = re.sub(rf"^{re.escape(k)}\s*=.*$", f"{k}={v}", s, flags=re.M)
    else:
        s = s[:i] + f"\n{k}={v}" + s[i:]
open(p, "w").write(s)
print("  renderer settings:", ", ".join(f"{k}={v}" for k, v in WANT.items()))
PY
  fi
fi

# ------------------------------------------------------- 2. python for the generator
# Use the interpreter the AGENT will invoke as `python3`, not necessarily this shell's.
AGENT_PY="$(command -v python3)"
echo "  python for generator work: $AGENT_PY ($("$AGENT_PY" -V 2>&1))"
"$AGENT_PY" -m pip install --user --quiet --disable-pip-version-check \
  numpy scipy shapely trimesh networkx scikit-image opencv-python-headless \
  pyproj mapbox_earcut noise pygltflib matplotlib pillow 2>&1 | grep -vi "already satisfied" | tail -3
"$AGENT_PY" - <<'PY'
import importlib
ok, bad = [], []
for m in ["numpy","scipy","shapely","trimesh","networkx","skimage","cv2","pyproj",
          "mapbox_earcut","noise","pygltflib","matplotlib","PIL"]:
    try: importlib.import_module(m); ok.append(m)
    except Exception: bad.append(m)
print("  available:", ", ".join(ok))
if bad: print("  MISSING:", ", ".join(bad))
PY

# --------------------------------------------- 3a. on-device image generation (signage)
# A city is covered in printed matter: billboards, posters, murals, packaging, signage,
# portraits. SDXL-Turbo runs locally on Apple Silicon via MPS, is ungated (no HF login), and
# costs nothing per image. Used through tools/gen-image.py, which shells into this venv.
IMG_VENV="${IMG_VENV:-$HOME/imagegen}"
if ! "$IMG_VENV/bin/python" -c "import diffusers" 2>/dev/null; then
  PY312="$(command -v python3.12 || command -v python3.13 || true)"
  if [ -n "$PY312" ]; then
    echo "  installing on-device image generation into $IMG_VENV"
    [ -d "$IMG_VENV" ] || "$PY312" -m venv "$IMG_VENV"
    "$IMG_VENV/bin/pip" install --quiet --upgrade pip
    "$IMG_VENV/bin/pip" install --quiet torch diffusers transformers accelerate safetensors \
      && echo "  image generation ready — first run downloads ~7GB of weights"
  else
    echo "  no python3.12+ found — skipping image generation (brew install python@3.12)"
  fi
else
  echo "  image generation already installed at $IMG_VENV"
fi

# ------------------------------------------------------------ 3b. mesh/texture/audio CLIs
if command -v brew >/dev/null; then
  for f in ffmpeg sox imagemagick assimp; do
    brew list "$f" >/dev/null 2>&1 || { echo "  brew install $f"; brew install -q "$f" 2>&1 | tail -1; }
  done
  command -v blender >/dev/null || echo "  NOTE: install Blender from blender.org (the cask has been unreliable)"
fi
command -v npm >/dev/null && { npm ls -g @gltf-transform/cli >/dev/null 2>&1 || npm i -g -s @gltf-transform/cli 2>&1 | tail -1; }

echo
echo "done. See docs/tech/capabilities.md for what is now reachable."
