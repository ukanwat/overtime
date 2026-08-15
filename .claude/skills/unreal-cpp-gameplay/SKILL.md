---
name: unreal-cpp-gameplay
description: >
  Write Unreal Engine 5 C++ gameplay code: the UCLASS/UPROPERTY/UFUNCTION reflection macros,
  the Gameplay Framework (GameMode, Pawn, Character, PlayerController, Actor components), and
  the module Build.cs. Use when writing or debugging UE C++, deriving from AActor/ACharacter/
  AGameModeBase, exposing properties to the editor or Blueprints, or when the user mentions
  Unreal C++, UCLASS, GENERATED_BODY, GameMode, ACharacter, or .Build.cs.
license: Apache-2.0
compatibility: Unreal Engine 5.4+ (docs verified against current UE5); C++17 toolchain
metadata:
  engine: unreal
  category: unreal
  difficulty: advanced
---

# Unreal C++ Gameplay

Write correct UE5 gameplay C++: the reflection macros that connect C++ to the editor and
Blueprints, the Gameplay Framework class roles, and module dependencies. Targets **UE 5.4+**.

## When to use

- Use when creating C++ gameplay classes (`AActor`, `APawn`, `ACharacter`, `AGameModeBase`,
  `UActorComponent`), exposing properties/functions with `UPROPERTY`/`UFUNCTION`, setting up a
  GameMode's default classes, or adding a module dependency in `*.Build.cs`.
- Use when the project has a `Source/` tree with `*.h`/`*.cpp` using `UCLASS`, and `*.Build.cs`.

**When *not* to use:** designer-facing visual logic → `unreal-blueprints`. Player input
binding details → `unreal-enhanced-input`. AI logic → `unreal-behavior-trees`. This skill owns
the C++ class/reflection foundation those build on.

## Core workflow

1. **Name with the right prefix.** `A` = Actor-derived, `U` = `UObject`/component-derived,
   `F` = plain struct, `E` = enum, `I` = interface. The prefix must match the base class.
2. **Declare the class with reflection macros.** `UCLASS()` above the class, `GENERATED_BODY()`
   as the first line in the body, and `#include "ClassName.generated.h"` as the **last**
   include in the header.
3. **Expose data with `UPROPERTY`** (editor/Blueprint visibility *and* garbage-collection
   tracking) and behaviour with `UFUNCTION` (`BlueprintCallable`, etc.).
4. **Create components in the constructor** with `CreateDefaultSubobject<T>(TEXT("Name"))` and
   set the `RootComponent`.
5. **Know the framework roles:** `AGameModeBase` sets the rules + default classes; `APawn`/
   `ACharacter` is the controllable body; `APlayerController` is the player's will;
   `UActorComponent` is reusable behaviour.
6. **Add module dependencies** to `*.Build.cs` (e.g. `EnhancedInput`) or unresolved-symbol
   link errors follow.
7. **Verify** by compiling (Live Coding `Ctrl+Alt+F11` for function bodies; full rebuild for
   header/UPROPERTY changes) and checking the class/properties appear in the editor.

## Patterns

### 1. Minimal Actor class (header + source)

```cpp
// Pickup.h
#pragma once
#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Pickup.generated.h"          // MUST be the last include

UCLASS()
class MYGAME_API APickup : public AActor   // MYGAME_API = your module's export macro
{
    GENERATED_BODY()
public:
    APickup();

    // EditAnywhere = tweak per-instance & on the CDO; BlueprintReadWrite = BP get/set.
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Pickup")
    int32 ScoreValue = 10;

    // UPROPERTY on a UObject* pointer is what keeps it from being garbage-collected.
    UPROPERTY(VisibleAnywhere)
    TObjectPtr<UStaticMeshComponent> Mesh;   // UE5: TObjectPtr instead of raw UStaticMeshComponent*

    UFUNCTION(BlueprintCallable, Category = "Pickup")
    void Collect();

protected:
    virtual void BeginPlay() override;
};
```

```cpp
// Pickup.cpp
#include "Pickup.h"
#include "Components/StaticMeshComponent.h"

APickup::APickup()
{
    Mesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Mesh"));
    RootComponent = Mesh;                     // the mesh is this actor's root
}

void APickup::BeginPlay() { Super::BeginPlay(); }   // always call Super
void APickup::Collect()   { Destroy(); }
```

### 2. GameMode wiring its default classes

```cpp
// MyGameMode.cpp — set in the constructor so the engine spawns your classes.
AMyGameMode::AMyGameMode()
{
    DefaultPawnClass      = AMyCharacter::StaticClass();
    PlayerControllerClass = AMyPlayerController::StaticClass();
}
```

### 3. Module dependency in Build.cs

```csharp
// MyGame.Build.cs
PublicDependencyModuleNames.AddRange(new string[]
{
    "Core", "CoreUObject", "Engine", "InputCore", "EnhancedInput"
});
```

## Pitfalls

- **`generated.h` not last / missing** — compile errors like "Cannot find generated header" or
  "Expected an include". It must be the final include in the header.
- **Forgetting `GENERATED_BODY()`** — UHT (Unreal Header Tool) errors; it must be the first
  thing inside the class body.
- **Raw `UObject*` without `UPROPERTY`** — the garbage collector doesn't see it and may destroy
  it out from under you. Track every UObject pointer with `UPROPERTY` (use `TObjectPtr` in UE5).
- **Header/UPROPERTY edits with Live Coding** — Live Coding handles function bodies, but
  changes to `UCLASS`/`UPROPERTY`/headers need a full editor restart + rebuild.
- **Wrong class prefix** — naming an Actor `UFoo` (or a component `AFoo`) breaks UHT; match the
  prefix to the base type.
- **Unresolved external symbol at link** — the module providing the API isn't in `Build.cs`
  `PublicDependencyModuleNames`.
- **Not calling `Super::`** in overridden `BeginPlay`/`Tick`/etc. skips engine setup.

## References

- For `UActorComponent` creation/attachment, the `UPROPERTY` garbage-collection ownership rules
  (`TObjectPtr`, `TArray<TObjectPtr<>>`, `AddToRoot`), and a replication primer, read
  `references/components-and-gc.md`.
- Primary docs: "Unreal Engine CPP Quick Start" and "Gameplay Framework"
  (`https://dev.epicgames.com/documentation/en-us/unreal-engine/gameplay-framework-in-unreal-engine`).

## Related skills

- `unreal-blueprints` — exposing C++ to designers; BP/C++ interop.
- `unreal-enhanced-input` — binding input in a C++ Pawn/Character.
- `unreal-behavior-trees` — C++ AI tasks driven from a behaviour tree.
