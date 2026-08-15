# Blueprint communication: Cast vs Interface vs Event Dispatcher (UE 5.4+)

Depth for `unreal-blueprints`. The three ways Blueprints talk to each other, when to use each,
and the gotchas. Verified against the Blueprints Visual Scripting and Blueprint Communications
documentation.

## Decision guide

| Method | Direction | Coupling | Use when |
|--------|-----------|----------|----------|
| **Direct + Cast To** | caller → known target | hard (loads that class) | you have a reference and genuinely depend on that exact type (e.g. player calls a specific door it owns) |
| **Blueprint Interface** | caller → any implementer | loose (no hard ref) | many unrelated types share a verb (Interact, Damage, Save) and the caller shouldn't know concrete types |
| **Event Dispatcher** | source → many listeners | loose (listeners find source) | one event, many reactions (health changed → HUD + audio + achievements) |

Rule of thumb: **Cast down, broadcast up.** A manager can Cast to things it owns; a low-level
actor should broadcast a Dispatcher rather than reach up to its owner.

## Casting — the cost

`Cast To BP_X` adds `BP_X` (and its dependencies) to this Blueprint's load references. A web of
casts inflates memory and load times and is a common cause of "why does my small Blueprint pull
in half the game". Use it where the dependency is real; otherwise prefer an interface.

```text
Some Actor ref -> Cast To BP_Enemy
   Cast Failed (exec) -> skip          // always handle failure; a wrong-type ref returns invalid
   As BP_Enemy (success) -> call enemy-specific function
```

## Blueprint Interface — decoupled verbs

1. Content Browser → Blueprint → **Blueprint Interface** (e.g. `BPI_Interactable`).
2. Add a function signature, e.g. `Interact(AActor* Instigator)`. (Interfaces declare signatures
   only — no node implementation in the interface asset.)
3. In each implementer (BP_Door, BP_Chest): Class Settings → **Implemented Interfaces** → add
   `BPI_Interactable`, then implement the `Interact` event in its Event Graph.
4. Caller, holding any `AActor` reference:

```text
-> Does Object Implement Interface (BPI_Interactable)?   // optional guard
   True -> Interact (Message)  [Target = the actor]      // 'Message' node is safe even if not implemented
```

The "Message" call node does nothing on actors that don't implement the interface, so it never
errors — unlike a Cast that fails.

## Event Dispatcher — one-to-many

Declare on the source Blueprint (e.g. `BP_Player`): My Blueprint panel → Event Dispatchers →
add `OnHealthChanged` with a `float NewHealth` input.

Broadcast it where the state changes:

```text
ApplyDamage -> Set Health (clamp >= 0) -> Call 'OnHealthChanged' (NewHealth = Health)
```

Bind from any listener that has a reference to the source:

```text
WBP_HUD :: Event Construct
  -> Get Player Pawn -> Cast To BP_Player
  -> Bind Event to 'OnHealthChanged'  [Event = custom 'HandleHealth(NewHealth)']

HandleHealth(NewHealth) -> Set Progress Bar Percent = NewHealth / MaxHealth
```

- Multiple listeners can bind to the same dispatcher; all are called on broadcast.
- **Unbind** (`Unbind Event from ...`) when a listener is destroyed/hidden to avoid stale binds.
- Dispatchers are the Blueprint equivalent of a C++ multicast delegate
  (`DECLARE_DYNAMIC_MULTICAST_DELEGATE`), so the same actor's event can be bound from C++ too.

## Gotchas

- Binding inside `Event Construct`/`BeginPlay` requires the source to already exist; for
  spawn-order issues, bind after you spawn the source, or have the source broadcast an initial
  value once listeners are known.
- Interface functions with return values are implemented as functions (not events) on the
  implementer; pure interface calls can't have exec pins.
- Casting a soft reference forces a synchronous load; prefer `Async Load Asset` for soft refs.
