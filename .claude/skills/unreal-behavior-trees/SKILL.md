---
name: unreal-behavior-trees
description: >
  Build NPC AI in Unreal Engine 5 with Behavior Trees and Blackboards: composites
  (Selector/Sequence), tasks, decorators, services, and running the tree from an AIController.
  Use when creating enemy/NPC AI, BT_/BB_ assets, custom BTTask or BTService nodes, or when
  the user mentions Behavior Tree, Blackboard, AIController, BTTask, decorator, or service.
license: Apache-2.0
compatibility: Unreal Engine 5.4+ (AIModule; Behavior Tree + Blackboard; NavMesh for movement)
metadata:
  engine: unreal
  category: unreal
  difficulty: advanced
---

# Unreal Behavior Trees

Author NPC decision-making in UE5 with Behavior Trees driven by a Blackboard: structure the
tree with composites, gate branches with decorators, keep state current with services, and run
it from an AIController. Targets **UE 5.4+**.

## When to use

- Use when building enemy/NPC AI: creating a `BT_`/`BB_` asset pair, structuring
  Selector/Sequence branches, adding decorators (conditions) and services (periodic updates),
  writing custom `BTTask`/`BTService` nodes, or wiring an AIController to run the tree.
- Use when the project has Behavior Tree (`BT_`) and Blackboard (`BB_`) assets and an
  `AAIController`.

**When *not* to use:** the *concept* of AI (FSM vs BT vs steering, cross-engine) →
`game-ai`. Pure navigation/pathing math is engine navmesh (BT's `MoveTo` uses it). Simple
one-off logic may be cheaper as a small state machine than a full tree.

## Core workflow

1. **Create the pair:** a Blackboard (`BB_`) holds typed keys (the AI's memory: `TargetActor`,
   `LastKnownLocation`, `bIsInvestigating`); a Behavior Tree (`BT_`) references that Blackboard.
2. **Possess and run.** An `AAIController` possesses the pawn and calls `RunBehaviorTree(BT)`,
   which also initializes the referenced Blackboard.
3. **Structure with composites.** **Selector** runs children left→right until one *succeeds*
   (priority/fallback: "attack, else chase, else patrol"). **Sequence** runs children until one
   *fails* (do-all: "move to cover → reload → peek"). **Simple Parallel** runs one main task
   alongside a secondary.
4. **Gate branches with Decorators** that read Blackboard keys (e.g. "Has Target?" guards the
   combat branch). Set **Observer Aborts** so the tree re-evaluates when the key changes.
5. **Keep the Blackboard current with Services** attached to a branch — they tick periodically
   (e.g. update `TargetActor` via a sight check) only while that branch is active.
6. **Do work in Tasks**, which return `Succeeded`, `Failed`, or `InProgress` (latent tasks like
   `MoveTo` finish later).
7. **Verify** with the Behavior Tree debugger during PIE — it highlights the running node and
   shows live Blackboard values, so you see exactly which branch executes.

## Patterns

### 1. AIController that runs the tree (C++)

```cpp
void AEnemyAIController::OnPossess(APawn* InPawn)
{
    Super::OnPossess(InPawn);
    if (BehaviorTree)                 // UPROPERTY(EditAnywhere) TObjectPtr<UBehaviorTree>
        RunBehaviorTree(BehaviorTree); // initializes & uses the Blackboard the BT references
}
```

### 2. A priority tree (node structure)

```text
ROOT
└── Selector (try combat, else investigate, else patrol)
    ├── Sequence            [Decorator: Blackboard 'TargetActor' Is Set, Observer Aborts: Both]
    │     ├── Task: MoveTo (TargetActor)          // latent: returns InProgress then Succeeded
    │     └── Task: Attack
    ├── Sequence            [Decorator: 'LastKnownLocation' Is Set]
    │     ├── Task: MoveTo (LastKnownLocation)
    │     └── Task: Wait (3s) + clear key
    └── Task: Patrol (BTTask_FindPatrolPoint -> MoveTo)
```

`Observer Aborts: Both` makes the combat branch interrupt patrol the instant `TargetActor` is
set, and bail out when it's cleared — this is what makes the AI feel reactive.

### 3. Updating the Blackboard from code (e.g. on seeing the player)

```cpp
void AEnemyAIController::SetTarget(AActor* Target)
{
    if (UBlackboardComponent* BB = GetBlackboardComponent())
        BB->SetValueAsObject(TEXT("TargetActor"), Target);   // key name must match the BB asset
}
// Clear with BB->ClearValue(TEXT("TargetActor")); to drop back to a lower-priority branch.
```

## Pitfalls

- **AI never starts** — the pawn isn't possessed (set the Pawn's *Auto Possess AI* to "Placed
  in World or Spawned" and assign the AIController), or `RunBehaviorTree` was never called.
- **`MoveTo` instantly fails** — no NavMesh in the level (add a Nav Mesh Bounds Volume), or the
  target is off the navmesh.
- **Branch doesn't react to changes** — the gating Decorator's **Observer Aborts** is set to
  None; set it to Self/Lower Priority/Both so the tree re-evaluates when the key changes.
- **A task hangs the tree** — a custom task returned `InProgress` and never calls
  `FinishLatentTask`. Always complete latent tasks.
- **Blackboard key typos** — `SetValueAsObject("Taget", ...)` silently does nothing; match the
  key name and type exactly, or use a cached `FBlackboardKeySelector`.
- **Sequence vs Selector confusion** — Sequence = AND (stops on first failure); Selector = OR
  (stops on first success). Swapping them inverts the behaviour.

## References

- For a **custom C++ `UBTTaskNode`** (instant and latent `ExecuteTask` returning `EBTNodeResult`,
  with a `FBlackboardKeySelector`), read `references/custom-bttask.md`.
- Primary docs: "Behavior Trees in Unreal Engine"
  (`https://dev.epicgames.com/documentation/en-us/unreal-engine/behavior-trees-in-unreal-engine`).

## Related skills

- `game-ai` — engine-agnostic AI design (FSM, BT, steering, pathfinding choices).
- `unreal-cpp-gameplay` — the AIController and pawn classes in C++.
- `fps-shooter` / `tower-defense` — genres that compose enemy AI.
