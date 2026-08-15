---
name: unreal-niagara
description: >
  Create and control VFX in Unreal Engine 5 with Niagara: systems and emitters, modules and
  the spawn/update stages, exposed User parameters, and spawning or driving effects from
  Blueprints or C++. Use when building particle effects, NS_/NE_ assets, spawning a Niagara
  system at runtime, setting User parameters, or when the user mentions Niagara, VFX, or a
  particle system in Unreal.
license: Apache-2.0
compatibility: Unreal Engine 5.4+ (Niagara is the current VFX system; Cascade is legacy)
metadata:
  engine: unreal
  category: unreal
  difficulty: advanced
---

# Unreal Niagara VFX

Build and control real-time visual effects in UE5 with Niagara: understand the
System/Emitter/Module hierarchy, expose parameters you can drive from gameplay, and spawn
effects at runtime. Targets **UE 5.4+**. (Niagara replaces the legacy Cascade system.)

## When to use

- Use when creating a Niagara System (`NS_`) and Emitters (`NE_`), wiring modules in the
  spawn/update stages, exposing **User** parameters to gameplay, or spawning/driving an effect
  (impact, muzzle flash, fire, magic) from Blueprint or C++.
- Use when the project has Niagara `NS_`/`NE_` assets or references `UNiagaraComponent`.

**When *not* to use:** material/shader authoring (the look of a surface, not particles) is a
separate topic; `shader-programming` covers cross-engine shader concepts. Audio for the effect
→ `audio-design`.

## Core workflow

1. **Understand the hierarchy.** A **Niagara System** (`NS_`) is the effect you place/spawn; it
   contains one or more **Emitters** (`NE_`, often emitter *templates*). Each emitter runs in
   stages: **Emitter Spawn/Update**, **Particle Spawn/Update**, optional **Event Handler**, and
   **Render**.
2. **Build behaviour from Modules**, which execute top-to-bottom in each stage (Spawn Rate,
   Add Velocity, Gravity Force, Color over Life, etc.). Order matters — a later module reads the
   values earlier ones wrote.
3. **Know the parameter namespaces:** `System`, `Emitter`, `Particle`, and **`User`**. Only
   **User-namespace** parameters are exposed to and settable from Blueprint/C++; the others are
   internal to the simulation.
4. **Spawn at runtime** with `UNiagaraFunctionLibrary::SpawnSystemAtLocation` (world position)
   or `SpawnSystemAttached` (follows a component/socket), which return a `UNiagaraComponent`.
5. **Drive the effect** by setting its User parameters on the returned component (color, spawn
   rate, a target position) and `Activate`/`Deactivate` it.
6. **Verify** in the Niagara editor preview and in-level; check bounds (especially GPU
   emitters), and confirm the effect culls/destroys correctly.

## Patterns

### 1. Spawn a one-shot effect at a world location (C++)

```cpp
#include "NiagaraFunctionLibrary.h"
#include "NiagaraComponent.h"

// ImpactSystem is a UPROPERTY(EditAnywhere) TObjectPtr<UNiagaraSystem>.
void AProjectile::SpawnImpact(const FVector& Location, const FRotator& Rotation)
{
    UNiagaraComponent* FX = UNiagaraFunctionLibrary::SpawnSystemAtLocation(
        GetWorld(), ImpactSystem, Location, Rotation);
    // FX auto-destroys when finished for a one-shot (system marked non-looping).
}
```

### 2. Spawn attached to a socket (muzzle flash that follows the gun)

```cpp
UNiagaraComponent* Muzzle = UNiagaraFunctionLibrary::SpawnSystemAttached(
    MuzzleSystem, WeaponMesh, FName("MuzzleSocket"),
    FVector::ZeroVector, FRotator::ZeroRotator,
    EAttachLocation::SnapToTarget, /*bAutoDestroy*/ true);
```

### 3. Drive an exposed User parameter at runtime

```cpp
// Only User-namespace parameters can be set from gameplay. Names match the User parameter.
if (UNiagaraComponent* Fire = UNiagaraFunctionLibrary::SpawnSystemAttached(
        FireSystem, RootComponent, NAME_None, FVector::ZeroVector, FRotator::ZeroRotator,
        EAttachLocation::KeepRelativeOffset, /*bAutoDestroy*/ false))
{
    Fire->SetVariableFloat(FName("SpawnRate"), 250.f);                 // User.SpawnRate
    Fire->SetVariableLinearColor(FName("FireColor"), FLinearColor::Red);
}
```

### 4. Blueprint equivalent (node flow)

```text
Spawn System at Location (System = NS_Impact, Location, Rotation)  -> returns Niagara Component
On the returned component:
  Set Niagara Variable (Float)  Name="SpawnRate"  Value=250
  Set Niagara Variable (LinearColor)  Name="FireColor"  Value=Red
```

## Pitfalls

- **Trying to set a System/Emitter/Particle parameter from gameplay** — it won't take. Expose
  it in the **User** namespace; only User parameters are settable via the component.
- **Using Cascade tutorials** — Cascade is legacy/deprecated. Niagara is the current system; the
  emitter/module workflow differs.
- **Effect disappears or doesn't cull right** — fixed/incorrect bounds, especially for **GPU
  Compute** emitters which need explicit Fixed Bounds. Set bounds on the emitter/system.
- **Looping effect never stops** — spawned with `bAutoDestroy = false` and never
  `Deactivate()`d; manage the returned component's lifetime, or mark the system non-looping for
  one-shots.
- **GPU sim can't drive gameplay** — GPU particle data isn't readily read back to the CPU;
  collision/events that gameplay must react to should use CPU emitters (or Niagara → gameplay
  via the data interface), not GPU.
- **Module order bugs** — a Force/Velocity module placed before the one that initializes the
  value reads zero. Mind the top-to-bottom stack order.

## References

- Primary docs: "Overview of Niagara Effects"
  (`https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-niagara-effects-for-unreal-engine`)
  and the `UNiagaraFunctionLibrary` / `UNiagaraComponent` API. Add the `Niagara` module to
  `*.Build.cs` for C++ access.

## Related skills

- `shader-programming` — material/shader concepts for particle materials.
- `unreal-cpp-gameplay` — spawning effects from gameplay code and module setup.
- `unreal-blueprints` — triggering effects from visual scripts.
