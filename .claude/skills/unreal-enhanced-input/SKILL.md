---
name: unreal-enhanced-input
description: >
  Set up player input in Unreal Engine 5 with Enhanced Input: Input Actions, Input Mapping
  Contexts, modifiers and triggers, adding the mapping context, and binding actions by
  ETriggerEvent. Use when wiring movement/look/jump input, creating IA_/IMC_ assets, binding
  in C++ or Blueprints, or when the user mentions Enhanced Input, Input Mapping Context,
  Input Action, IA_/IMC_, or ETriggerEvent.
license: Apache-2.0
compatibility: Unreal Engine 5.4+ (Enhanced Input is the default UE5 input system)
metadata:
  engine: unreal
  category: unreal
  difficulty: intermediate
---

# Unreal Enhanced Input

Wire player input the modern UE5 way with the **Enhanced Input** system: data-driven Input
Actions and Mapping Contexts instead of the legacy Project Settings axis/action mappings.
Targets **UE 5.4+** (Enhanced Input is the default; legacy input is deprecated).

## When to use

- Use when adding movement/look/jump/fire input, creating Input Action (`IA_`) and Input
  Mapping Context (`IMC_`) assets, applying modifiers/triggers, adding a mapping context to a
  player, or binding actions in C++ or Blueprints.
- Use when the project has `IA_*`/`IMC_*` assets or references `EnhancedInput`.

**When *not* to use:** engine-agnostic input *architecture* (rebinding strategy, buffering,
multi-device design) → `input-systems`. The Pawn/Character C++ those bindings live in →
`unreal-cpp-gameplay`.

## Core workflow

1. **Enable the module/plugin.** Enhanced Input is on by default in UE5; for C++ binding add
   `"EnhancedInput"` to `PublicDependencyModuleNames` in `*.Build.cs`.
2. **Create Input Actions (`IA_`).** Each has a **Value Type**: `Digital (bool)` for buttons,
   `Axis1D (float)` for triggers, `Axis2D (Vector2D)` for movement/look.
3. **Create an Input Mapping Context (`IMC_`)** that maps keys/buttons to those actions. Use
   **Modifiers** to shape raw input (Negate, Swizzle Input Axis Values, Dead Zone) — e.g. WASD
   into one Axis2D needs Negate on A/S and a Swizzle on W/S. Use **Triggers** (Pressed, Hold,
   Tap) to decide *when* an action fires.
4. **Add the mapping context to the player** via the `EnhancedInputLocalPlayerSubsystem`
   (`AddMappingContext(IMC, Priority)`), usually in `BeginPlay`/possession.
5. **Bind actions** to handlers by `ETriggerEvent` (`Triggered`, `Started`, `Completed`, …) on
   the `EnhancedInputComponent`, and read the `FInputActionValue` in the handler.
6. **Verify** in PIE; the Enhanced Input debugging console commands
   (`showdebug enhancedinput`) show which actions trigger and their values.

## Patterns

### 1. Add the mapping context (C++ Character)

```cpp
void AMyCharacter::BeginPlay()
{
    Super::BeginPlay();
    if (APlayerController* PC = Cast<APlayerController>(GetController()))
        if (ULocalPlayer* LP = PC->GetLocalPlayer())
            if (auto* Subsystem = LP->GetSubsystem<UEnhancedInputLocalPlayerSubsystem>())
                Subsystem->AddMappingContext(DefaultMappingContext, /*Priority*/ 0);
}
// DefaultMappingContext is a UPROPERTY(EditAnywhere) TObjectPtr<UInputMappingContext>.
```

### 2. Bind actions and read values

```cpp
void AMyCharacter::SetupPlayerInputComponent(UInputComponent* InputComponent)
{
    Super::SetupPlayerInputComponent(InputComponent);

    // The component is an Enhanced Input component when the plugin is active.
    if (UEnhancedInputComponent* EIC = Cast<UEnhancedInputComponent>(InputComponent))
    {
        EIC->BindAction(MoveAction, ETriggerEvent::Triggered, this, &AMyCharacter::Move);
        EIC->BindAction(LookAction, ETriggerEvent::Triggered, this, &AMyCharacter::Look);
        EIC->BindAction(JumpAction, ETriggerEvent::Started,   this, &ACharacter::Jump);
        EIC->BindAction(JumpAction, ETriggerEvent::Completed, this, &ACharacter::StopJumping);
    }
}

void AMyCharacter::Move(const FInputActionValue& Value)
{
    const FVector2D Axis = Value.Get<FVector2D>();          // Axis2D action
    AddMovementInput(GetActorForwardVector(), Axis.Y);
    AddMovementInput(GetActorRightVector(),   Axis.X);
}
```

### 3. Blueprint equivalent (node flow)

```text
Event BeginPlay
  -> Get Controller -> Cast To PlayerController -> Get Local Player
  -> Get EnhancedInputLocalPlayerSubsystem -> Add Mapping Context (IMC_Default, Priority 0)

// IA_Move is exposed as its own event node in the Character's Event Graph:
EnhancedInputAction IA_Move (Triggered)
  -> Action Value (Vector2D) -> Add Movement Input (Forward * Y, Right * X)
```

## Pitfalls

- **No input at all** — the mapping context was never added (`AddMappingContext`), or the
  player has no Local Player yet. Add it after possession/`BeginPlay`.
- **Link/compile error binding in C++** — `"EnhancedInput"` isn't in `Build.cs`
  `PublicDependencyModuleNames`.
- **WASD only moves on two keys / wrong axis** — Axis2D needs **Modifiers**: Negate on the
  negative keys (A, S) and a Swizzle Input Axis Values on the vertical (W/S) so both axes map
  correctly. Raw bindings without modifiers misbehave.
- **`Get<FVector2D>()` returns zero** — value-type mismatch: the Input Action is Digital/Axis1D,
  not Axis2D. Match the `Get<T>()` to the action's Value Type.
- **Action fires every frame unexpectedly** — `Triggered` repeats while held for a Down trigger;
  use `Started`/`Completed` for one-shots (jump press/release), or a Pressed/Tap trigger.
- **Two contexts fight** — multiple mapping contexts stack by Priority; a higher-priority
  context can consume a key. Manage with priorities and `RemoveMappingContext`.

## References

- For a complete first-/third-person C++ Character with Enhanced Input (header + source,
  including look/jump and a control-rebind note), read `references/cpp-setup.md`.
- Primary docs: "Enhanced Input in Unreal Engine"
  (`https://dev.epicgames.com/documentation/en-us/unreal-engine/enhanced-input-in-unreal-engine`).

## Related skills

- `input-systems` — engine-agnostic input architecture and rebinding strategy.
- `unreal-cpp-gameplay` — the Character/Pawn class and module setup.
- `fps-shooter` — composes input with a 3D controller and shooting.
