# What you have — the full capability surface

An inventory, not instructions. Nothing here is required; it is here so that "I couldn't" is
never about not knowing the tool existed. Run `../bin/setup-capabilities.sh` if any of it is absent.

## The engine, with everything switched on

These plugins are enabled in the project. Most of them are **off by default** in a stock
install, and enabling one needs an editor restart — so if something here surprises you, that is
why you have not been using it.

**World building** — `PCG` (procedural placement and scatter, runtime-capable) · `Landmass`
(sculpt landscape from splines and shapes) · `Water` (ocean, rivers, lakes with real shoreline
behaviour) · `GeometryScripting` (build and edit meshes from Python or Blueprint — you can
generate buildings in-engine instead of importing them) · `ModelingToolsEditorMode`

**Characters** — `MetaHumanCharacter`, `MetaHumanGenerator`, `MetaHumanCharacterUAF`,
`MetaHuman`. MetaHuman Core Data is installed locally, so a cast can be *made* here rather than
sourced. This is the answer to a grey default mannequin.

**Animation** — `PoseSearch` and `MotionTrajectory` (Motion Matching — the modern way to get
locomotion that does not look like a game from 2009) · `AnimationLocomotionLibrary` ·
`ContextualAnimation` (interactions between two actors) · `Chooser` (data-driven animation
selection) · `AnimationBudgetAllocator` (keep hundreds of animated actors inside frame budget)

**Vehicles** — `ChaosVehiclesPlugin`. Real suspension, tyre friction, engine and gearbox.

**Crowds and traffic at scale** — `MassEntity`, `MassGameplay`, `MassAI`, `MassCrowd`,
`ZoneGraph`, `ZoneGraphAnnotations`, `SmartObjects`, `StateTree`, `GameplayBehaviors`. This is
the same family Epic's own city demo uses for thousands of agents: a lane graph the traffic and
pedestrians follow, affordances they can use, and behaviour trees driving them.

**Character variation at scale** — `Mutable` (production-ready in 5.8: merges skeletal meshes
and bakes textures at runtime, so a crowd can have real wardrobe variety without a draw call per
outfit) · `MetaHumanCrowd` (new in 5.8, experimental: instanced-skeletal-mesh crowds built from
MetaHuman data, spawned through Mass — this is the intended route to an ambient city population)

**Capture and systems** — `MovieRenderPipeline` (Movie Render Queue: high-fidelity capture,
scriptable from Python for automated shots) · `RemoteControl` (HTTP/WebSocket control of the
editor from outside the process) · `GameplayAbilities` (attributes, abilities, interactions) ·
`Mover` (the newer movement framework) · `GeometryCollectionPlugin` (Chaos destruction) ·
`NiagaraFluids` (fire, smoke, water) · `ProceduralVegetationEditor` (experimental: author
Nanite-ready plants that output PCG-compatible assets) · `USDImporter`

**Other** — `Text3D` (dimensional lettering for signage) · Niagara, Nanite, Lumen and
Interchange are on by default · World Partition, Data Layers, HLOD, Virtual Shadow Maps,
Virtual Textures and Megalights are renderer/engine features toggled in Project Settings rather
than plugins.

### MetaHuman from Python

The whole creation pipeline moved in-engine in 5.6, so a cast can be *made* here. Reference
scripts ship at `Engine/Plugins/MetaHuman/MetaHumanCharacter/Content/Python/examples/`. Via
`unreal.get_editor_subsystem(unreal.MetaHumanCharacterEditorSubsystem)` and
`unreal.MetaHumanCharacter` you can set face identity by PCA coefficients
(`get/set_face_model_coefficients`), move individual landmarks, drive parametric body shape
(`get/set_body_constraints`), conform to a DNA file, attach wardrobe and groom items, commit eye
and makeup settings, then `build_meta_human()` / `export_dna()` / `export_geometry()`. Two calls
need an Epic cloud login and will fail without one: `request_texture_sources()` (high-resolution
skin) and `request_auto_rigging()`.

## Python, on the interpreter you invoke as `python3`

`numpy` `scipy` `shapely` `trimesh` `networkx` `scikit-image` `opencv` `pyproj`
`mapbox_earcut` `noise` `pygltflib` `matplotlib` `pillow`

`shapely` matters most: buffer, offset, simplify, planarise, polygonise, triangulate,
boolean ops on polygons. If you are hand-writing polygon geometry, check whether it already
does it — correctly, and in C.

## Making 2D art: signage, billboards, posters, murals, packaging

A city is covered in printed matter, and blank rectangles read as unfinished faster than
anything else. Four ways, all available:

**Typography is most of it.** Advertising is type, shape and colour. Google Fonts is keyless —
about a thousand OFL families, free to bake into textures:

```bash
curl -sL "https://fonts.google.com/download?family=Bebas%20Neue" -o /tmp/f.zip
# or per-file from the mirror:
curl -s "https://api.github.com/repos/google/fonts/contents/ofl/bebasneue" \
  | python3 -c "import json,sys;[print(f['download_url']) for f in json.load(sys.stdin)]"
```

Pick faces the way an art director would: a deco display for the hotel strip, a condensed
industrial gothic for the docks, a soft geometric sans for anything corporate, a script for
the old family businesses. Wrong typeface is the single loudest tell in a fake city.

**Draw them in code.** `PIL`, `cairo`/SVG, `numpy`, `opencv` are all present. Sunbursts,
stripes, halftone dots, misregistered overprint, sun-bleaching, torn edges, paste-up layers —
all cheap, all controllable, all yours.

**Draw them in the engine.** Canvas Render Targets, UMG widgets rendered to a texture (for
screens and animated boards), material graphs for procedural signage, `Text3D` for lettering
with real depth and edge lighting.

**Generate them on-device.** A Python environment for image generation is installed at
`~/imagegen` — `torch` with Metal acceleration plus `diffusers`, `transformers` and `accelerate`.
No API key and no per-image cost.

**Pick whatever model you want.** The environment is the capability; the model is your choice.
Anything on Hugging Face that `diffusers` can load will run, and it is worth choosing
deliberately — different models are better at photography, at illustration, at type-like
graphics, at faces. Check a repo is fetchable before you commit to it, because gated ones need an
account:

```bash
curl -s https://huggingface.co/api/models/<org>/<repo> \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('gated:',d.get('gated'))"
```

`gated: False` downloads straight away; `auto` or `manual` needs a Hugging Face login and token,
so prefer an ungated equivalent unless the gated one is clearly better. Look for current models
rather than assuming — the good ones change every few months, and a web search will tell you what
is strong right now for the kind of image you need. Larger models are slower but better; few-step
"turbo"/"schnell" variants trade quality for seconds.

`tools/gen-image.py` at the repo root is a forty-line convenience wrapper around one model. Treat it as
a starting point, not the interface — replace it, extend it with image-to-image, inpainting,
ControlNet, LoRAs, higher resolution, upscaling, or a different model entirely if that serves the
work better.

**Whatever model you use, it will not spell.** Verified: imagery comes out convincing, lettering
comes out as plausible nonsense. Do what a studio does — generate the *picture*, then set the
*type* yourself over it with PIL and a real font. That separation is better art direction anyway:
you control typeface, kerning, hierarchy and weathering, and those are what make signage read as
designed rather than dreamt.

Use it for billboard art, magazine covers, film posters, product packaging, murals, graffiti,
phone wallpapers, TV stills, portraits for a phone contact list. Two rules: **invent your own
brands** — never reproduce a real company's mark, logo, slogan or livery, and never anything from
an existing game — and pass the output through a print-and-weather step so it sits in the world
rather than floating on it.

## Other tools on the machine

`blender` (headless: `blender --background --python script.py`) · `ffmpeg` · `sox` ·
`imagemagick` · `assimp` · `gltf-transform`

## The local library — use it and learn from it

Whatever is installed on this machine is provisioned for you, including anything in the local
Epic/Fab library and any sample project or template that has been added. Two ways to use it,
and the second is the one people forget:

- **Take the assets.** Meshes, materials, animations, characters, vehicles, audio, VFX.
- **Read how they were made.** Open a shipped Epic sample and study the actual construction: how
  a vehicle's Chaos setup is tuned, how a crowd is spawned and budgeted, how a modular building
  kit is authored, how a motion-matching database is structured and queried, how a material
  handles wear and layering. That is production knowledge written by the people who built the
  engine, sitting on your disk. Copy the technique even where you do not want the asset.

Check again occasionally — content may be installed while you are working that was not there
when you started. `Engine/Content`, `Engine/Plugins/*/Content`, the project's own `Content`, and
the engine `Templates/` directory are all worth a look.

The one absolute exception: nothing extracted from, ripped from, or imitating any existing
commercial game.

## Driving a desktop application

Some things are only reachable through a GUI. `tools/appui.py` at the repo root lets you operate one
application's window: it captures **only that window's rectangle** — never the whole screen,
never anything else that is open — and takes click coordinates relative to the window's top-left.

```bash
python3 ../appui.py apps                                   # what GUI apps are running
python3 ../appui.py shot  "<App>" /tmp/ui.png              # capture, then Read the PNG
python3 ../appui.py click "<App>" 420 260                  # window-relative coordinates
python3 ../appui.py type  "<App>" "search text"
python3 ../appui.py key   "<App>" return
python3 ../appui.py scroll "<App>" -5
```

The loop that works: **shot → Read the image → decide → click → shot again to confirm.** Never
click blind. A GUI you cannot see is a GUI you are guessing at, and a misclick in someone else's
application is worse than not trying.

**The editor itself is one of those applications, and this is the answer to being stuck.** A
scripting channel can only reach things the scripting API exposes; a modal dialog is not one of
them, and a modal blocks the channel completely — so the exact moment you most need control is the
moment scripting stops working. That is not a dead end: take a screenshot of the editor window,
read it, and click the button. Crash-recovery prompts, "save these packages?", import and migrate
dialogs, plugin-restart prompts, asset-conversion warnings, the Fab browser, anything modal at all.

Two things follow from that. **A hung editor is worth *looking* at before you kill it** — a process
blocked on a dialog and a process genuinely working are indistinguishable from resource usage, and
one screenshot tells you which you have. And **"I cannot do that, it needs the UI" is not a
limitation you have.** You have the UI. It is slower and clumsier than scripting and it is a real
capability, so reach for it before concluding something is impossible or rebuilding it another way.

This opens storefronts, launchers and asset managers whose libraries have no API — which is often
exactly where the best free content lives. **The Epic Games Launcher's Fab tab is the biggest
example and it is already signed in.** Fab carries a large catalogue of genuinely free, genuinely
professional content — Quixel Megascans scans, environment and prop kits, vehicles, characters,
animation sets, materials — far better than most of what you will find by scraping open asset
sites. Filter to free, add what you want to the library, and install it into this project; it then
appears in `Content` like anything else. It is the single best source of photoreal assets you
have, so look there before you consider modelling something yourself.

**When a listing says it does not support your engine version, that is metadata, not physics.**
Each listing declares the versions Epic has validated; a brand-new engine release will have
nothing validated against it yet, so the launcher refuses to offer your project as a target even
though the engine would load those assets happily and upgrade them on import. Three ways past it,
cheapest first:

1. **Use Fab from inside the editor, not the standalone launcher.** The editor has its own Fab
   browser, and it will let you pick a different compatible version of a listing and install it
   straight into the currently open project — which is exactly what the standalone launcher
   refuses to do. There is also a Python service for it, so you need not click at all: look for
   `unreal.FabService` (`discover_python_class` will show you its methods), which can discover and
   import the signed-in account's owned library. **Try this first; it dissolves the problem rather
   than working around it.**
2. **Prefer listings that do offer your version.** Much of the catalogue — surfaces, textures,
   scanned props, static meshes — is listed across many versions. Filter to free, sort by what
   installs, and take the good things that are available rather than fighting for one that is not.
3. **Download to the vault and copy by hand.** If a listing offers a plain download rather than
   "install to project", the pack lands in the launcher's `VaultCache` directory; its `data/`
   folder contains an ordinary `Content` tree you can copy straight into the project. The editor
   upgrades assets on load. This works well for meshes, materials and textures; Blueprints and
   anything compiled are riskier and may need fixing up.
4. **Install an older engine alongside the current one**, install the pack into a throwaway
   project on that version, then use the editor's **Migrate** tool (right-click the assets →
   Asset Actions → Migrate) to copy them with their dependencies into this project. Costs a large
   engine download, but it is the only route to content that ships as a whole project rather than
   as a pack — and to plugins bundled inside those projects.

Whichever route: log what you took and where it came from, and check the result actually looks
right in-engine rather than assuming a migrated asset survived intact. Take only what is free and legitimately available, log
what you take, and leave anything that would spend money or change an account setting.

## Capturing frames and video — the tool decides what you are allowed to conclude

**A scene-capture component is not the camera the game renders from, and it lies in more than one
direction.** It runs its own exposure, and — because it renders a single isolated frame — it has no
temporal history, so any temporal anti-aliasing (TSR/TAA, the modern default) has nothing to
accumulate and effectively does not run. The result aliases hard on thin geometry: railings, wires,
poles, mullions, kerb lines. Add a low-resolution or 8-bit render target and it aliases further.
None of that is a property of the world; all of it will be read as one if you judge from those
frames. Whatever you use to look, know which of its properties are the scene's and which are the
instrument's, and confirm anything important against the camera a player actually looks through.

**For final imagery and video, Movie Render Queue exists and is enabled** (`MovieRenderPipeline`).
It is built for exactly this: temporal sample accumulation for clean anti-aliasing and motion blur,
spatial sampling, warm-up frames so streaming and shader compilation settle before the first frame,
high bit depth, arbitrary resolution, and deterministic output. It is scriptable from Python, so a
capture can be a repeatable artefact rather than a manual recording. Anything intended to be *shown*
should come from there rather than from a viewport grab or a scene capture.

## Geometry: what the renderer will absorb for you

Worth knowing before budgeting anything in triangles, because the intuition most people carry is
from before virtualized geometry existed.

**Nanite decouples cost from source triangle count.** A Nanite mesh is streamed and clustered by the
renderer, and its cost tracks the *pixels it covers on screen*, not the triangles it was authored
with. A film-quality scan used a thousand times does not cost a thousand times its triangle count.
Budgeting a scene by multiplying instance count by source triangles will produce numbers that look
catastrophic and are not real. Measure a frame instead.

**This includes foliage.** Nanite supports Opaque *and* Masked blend modes, and Nanite Foliage is a
supported, documented path in current versions. The practitioner consensus is stronger than mere
viability: **geometry foliage generally outperforms card/billboard foliage under Nanite — and also
outperforms non-Nanite cards — while looking considerably better.** Enabling Nanite on card-based
foliage is *not* reliably a win and can be slower than leaving it off.

The reason is alpha. Crossed billboards depend on masked materials, **masked-out pixels cost nearly
as much as drawn ones**, and masked runs roughly 2× opaque per triangle in Nanite. So the trade is
not "cheap flat cards versus expensive real geometry" — it is often the reverse, and a real mesh
with fewer masked pixels can beat a card that is mostly discarded alpha. Where real geometry does
cost more, the honest levers are the material and the pixels, not the polygon count.

None of which says every plant needs to be a scan. It says the *triangle count is not the reason* to
avoid one, and that a choice made on those grounds is worth re-examining against a measured frame.

**What Nanite covers in this engine build**, checked against the binary rather than remembered:
static meshes, instanced and hierarchical instanced meshes, foliage, **assemblies** (gated behind
the Nanite Foliage project setting — now on), **skinned/skeletal meshes**, landscape, voxels, and a
translucency path. In practice you can default to it for geometry.

The exclusions and gotchas that actually bite, from the engine's own diagnostics:

- **The `SingleLayerWater` shading model is not supported** on Nanite static *or* skeletal meshes.
  Water surfaces stay non-Nanite; `Disallow Nanite` on the component suppresses the warning.
- **Nanite landscape has a per-actor material-count limit** — too many components in one landscape
  actor and it refuses.
- **World Position Offset must be opted into per component.** Nanite does not evaluate WPO unless
  told to, so a perfectly correct wind, growth or deformation material will simply do nothing and
  give you no error. It also costs culling efficiency, so it is a per-component decision, not a
  global switch.
- **Nanite does not make material complexity free.** Its shading cost scales with the number of
  distinct material bins covering the screen, which this project has already measured the hard way.
  Geometry stops being the budget; materials become it.

### Prefer the current path, then verify it

**Nothing here is off-limits and nothing is mandatory** — use whatever serves the work. The reason
this section exists is that these features are not decoration: they are the engine's answers to the
exact problems that keep stopping you. Performance ceilings, geometry you think you cannot afford,
crowd and traffic scale, lighting that will not hold up, quality that costs too much to keep. When
you hit one of those walls, check whether the engine already solved it before you design around it.

The engine has moved a long way and most "common knowledge" about how to build a world is advice
from before these existed. Where a modern path exists, it is usually the right default: virtualized
geometry rather than hand-authored LOD chains and billboard impostors; dynamic Lumen and virtual
shadow maps rather than baked lightmaps; many-light shading rather than rationing light count;
motion matching rather than hand-blended state machines; entity-based crowds rather than an actor
per pedestrian; procedural tooling rather than placing every instance by script.

Two balancing rules. **Check what exists now rather than assuming** — this changes every release,
and something that was experimental or absent when you last looked may be production-ready. And
**the modern path is not automatically cheaper in every case**, so the decision still ends at a
measured frame, not at a preference.

## Making the world alive — what exists for it

Inventory, as everywhere else here. Nothing below is a recommended plan and none of it is required;
it is here so that "there was no way to do it" is never true.

### The distinction that matters

**Rendering and simulation are separate layers, and instanced meshes are not frozen.** An
instanced-mesh component's per-instance transforms can be *updated at runtime* — that is how
city-scale traffic and crowds are drawn in production, including in Epic's own city demo: a
simulation decides where each entity should be and writes transforms into instanced meshes for
drawing. So a city already populated with instanced vehicles has its render layer built; what a
static city lacks is the layer deciding where things should be this frame. Neither layer implies
the other, and adding one does not mean rebuilding the other.

### Free Epic sample projects — installable, and several address this directly

All free, from the **Fab tab in the Epic Games Launcher**, **Fab.com**, or the **Fab plugin inside
the editor**; once acquired they appear under *Unreal Engine → Library → Fab Library*. The
version-gate workarounds in the section above apply to these too.

- **City Sample** — the project behind *The Matrix Awakens*, and the most relevant item here: a
  complete city with buildings, **vehicles and crowds of MetaHuman characters**, moving at scale. It
  ships its traffic and crowd implementation as project plugins, not merely as content — so it is a
  working reference for exactly this problem, with the C++ already written and the configuration
  already authored. Worth installing even if none of its assets are kept.
- **Game Animation Sample** — over 500 AAA-quality animations with a working character and animation
  Blueprint, built around Motion Matching. The difference between characters that move and
  characters that look like a game from 2009.
- **Lyra Starter Game** — a full gameplay sample; useful for how systems are wired.
- **Content Examples** — one map per engine feature, each a minimal working demonstration. The
  fastest way to see how something is *meant* to be set up.
- **Stack O Bot**, **Project Titan** — smaller sandboxes, useful as reference.

One trap, already paid for once here: a plugin named in a `.uproject` that is **not present on
disk** makes the editor abort at startup. Plugins shipped inside a sample project only exist after
that project is installed, so confirm the name is really on disk before enabling it.

### Already compiled into the engine — configuration, not C++

`MassCrowd` · `MassAI` · `MassGameplay` · `ZoneGraph` · `ZoneGraphAnnotations` · `SmartObjects` ·
`StateTree` · `GameplayBehaviors` — the pedestrian-crowd-on-a-lane-graph family, complete and
already enabled in this project. Also `MetaHumanCrowd` and `Mutable` for crowd variety without a
draw call per outfit, `AnimationBudgetAllocator` to keep hundreds of animated actors inside frame
budget, `PoseSearch`/`MotionTrajectory` for Motion Matching, `ChaosVehiclesPlugin` for real vehicle
physics, `Mover` for movement. Configuration for these lives largely in **data assets**, which
Python creates and edits perfectly well — and an installed sample supplies authored examples to
study rather than Blueprints to invent from nothing.

### Aliveness is not only agents

The cheapest and often largest gains need no AI at all, and a city without them reads as abandoned
however many characters walk through it:

- **Things that move because of wind or time** — foliage and grass, flags, awnings, hanging laundry,
  loose litter, swinging signs, chains, curtains at open windows.
- **Fluids and atmosphere** — smoke from stacks, steam from vents and manholes, exhaust, dust, spray
  at the seawall, moving water with real shoreline behaviour.
- **Things that switch** — traffic lights actually cycling, pedestrian crossings, level crossings,
  street lamps coming on at dusk, windows lighting up irregularly through the evening and going dark
  through the night, illuminated signage, animated screens and billboards, aircraft warning lights.
- **Machinery** — cranes slewing, lifts, conveyors, ventilation fans, pump jacks, opening bridges.
- **Distant life that costs almost nothing** — birds, gulls over the water, aircraft on approach,
  boats making way, a train crossing the far side of the bay.
- **Sound, which is half of aliveness and the neglected half** — a different ambient bed per
  district, traffic hum that rises with the road you are near, gulls at the docks, industry, rigging
  in the marina, insects at night, reverb that changes in a canyon or under a bridge. A silent city
  is never alive; a well-scored one feels alive even when the frame is still.

### Routes to moving traffic and people, cheapest first

- **Instances along the road graph.** Update instance transforms each frame from a lane network or
  spline you already have. No AI, no per-vehicle actors; convincing at any distance a player is
  likely to be, and it scales to thousands.
- **Pooled actors near the camera, instances far from it.** Full physics and behaviour only where it
  can be inspected; cheap representation everywhere else.
- **Mass entities on a ZoneGraph** — the production answer, and what the engine's crowd family is
  built for.
- **Vertex-animated or Niagara-driven crowds** for distant density.

## Sourcing at run time

`docs/sources/` has the verified list — models, textures, HDRIs, real map data, mocap, audio,
and the reference-photograph APIs. `docs/workflow/world-inventory.md` has the catalogue of what
a world contains, including the live query into OpenStreetMap's own object taxonomy.
