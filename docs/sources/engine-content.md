# What's already on this machine

## Correction worth knowing
**Starter Content no longer exists** — Epic removed it in UE 5.6+. Don't look for
`/Game/StarterContent`; it isn't there. What IS local:

## Engine Content (`/Engine/Content/`, enable "Show Engine Content")
Primitives (cube, sphere, plane, cylinder, cone, capsule), basic/debug materials,
editor meshes. Utility only — no architecture, no props worth shipping. Fine for
blockout, useless for dressing.

## Third Person template — Manny & Quinn (the real prize)
`/Game/Characters/Mannequins/`
- `SKM_Manny`, `SKM_Quinn` — full skeletal meshes, LODs, cloth
- `SK_Mannequin` — UE5's standard ~67-bone humanoid skeleton
- `IK_Mannequin` (IK Rig) + `RTG_Mannequin` (IK Retargeter), pre-configured
- Locomotion set: idle, walk, run, jump, land, strafe

Aesthetic is a grey mannequin — but the **rig is production grade**. Correct use:
keep this skeleton as your animation target, retarget real mocap onto it, and swap
the mesh for an imported character. See [open-sources.md](open-sources.md).

## MetaHuman Core Data (installed)
Contains the DNA framework, preset base definitions, control rigs, grooms, and the
in-editor Creator (local since 5.6 — no cloud needed). Characters are *generated*,
not pre-baked: presets are starting configurations. Generated output is photoreal
(`BP_Metahuman`, `SKM_Face`, `SKM_Body`, LODs, grooms, cloth).
**Headless caveat:** full Python-only MetaHuman generation is experimental. The safe
pattern is generate once in the editor, save into the project, then use it headlessly
from then on.

## Behind a login (available to the human, not to you)
City Sample / Matrix Awakens (~93 GB — photoreal buildings, vehicles, crowds),
Animation Starter Pack, anything on Fab/Quixel, Mixamo. If these appear in the
project already, use them; you cannot fetch them yourself.
