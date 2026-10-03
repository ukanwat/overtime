# Phases and their gates

Professional productions move through gates, not vibes. Each gate has an exit
criterion. Compressed to your session budget, but the ORDER is not negotiable —
skipping ahead is the most expensive mistake in game development.

## 0. Pillars (minutes, not hours)
Write 3 design pillars in `PROGRESS.md` — non-negotiable statements every later
decision is checked against ("a city that feels lived-in", "driving that has
weight", "one honest crime story"). **Gate:** if you can't write three that
survive scrutiny, you don't understand the brief yet.
Rule: *features before pillars* guarantees scope creep — every feature seems
reasonable alone, collectively they double the work.

## 1. Metrics test scene (do this FIRST, always)
Establish and lock: player height and eye height, walk/run speed, jump, capsule
width, camera FOV, vehicle top speed. See [metrics.md](metrics.md).
**Gate:** a character moves through a test box at correct scale and it *feels*
right. Everything downstream is calibrated to these numbers.
Rule: changing movement metrics after layout exists invalidates every distance,
sightline and cover position you built. Lock them now.

## A note on the "vertical slice"
In real production a vertical slice is one small area at near-final quality, built to
prove a game before scaling the team. It is a *pitching* gate. This project is not a
pitch — the brief asks how much of a whole city you can build, so the gate here is
**whole-map blockout first, then a quality gradient outward** (see BRIEF/PROMPT
"Scope"). Don't build one perfect street.

## 2. Blockout (grey boxes only — the WHOLE map, not one block)
Layout in primitives: roads, blocks, landmarks, the mission path. Flat grey
material. No textures, no lighting work, no assets.
**Gate:** you can walk/drive the whole space and the layout reads clearly.
Rule: **it must be interesting as grey boxes.** Deleting a box is free; deleting
a dressed street costs a session.

## 3. Greybox playable
Placeholder logic on top of the layout: mission triggers, wanted system, traffic
paths, spawn points. Still no final art.
**Gate:** the core loop is completable start to finish. Someone who didn't build
it could navigate without instruction.

## 4. Mesh pass / set dressing
Now the art: real materials, sourced models, hero props, storefronts, clutter.
Replace primitives; do not move the layout.
**Gate:** no untextured placeholder surfaces remain in the playable area.
Rule: an art pass that breaks a sightline established in blockout gets reverted,
not accepted.

## 5. Lighting pass (late, deliberately)
Lighting reacts to final geometry and final material values — lighting a greybox
is wasted iteration. Sun angle + sky + fog + exposure + post.
**Gate:** every zone is intentionally lit; the scene holds up at BOTH noon and
night (the probe shoots both).

## 6. Audio + effects pass
Ambience, engine sound, radio, weather, particles. Keyed to the now-stable world.
**Gate:** the world sounds inhabited with the screen off.

## 7. Optimization (continuous from step 4, not a final chore)
Profile, then fix. Draw calls, instancing, texture budget.
**Gate:** inside the budget in [../tech/capabilities.md](../tech/capabilities.md).
Rule: optimizing before geometry is stable is wasted work; discovering a budget
problem after art is locked is worse.

## 8. Polish
The last 10% of the session: nothing new, only better. Sound cues that guide,
camera framing, fail-message wording, one more close-up fixed.
**Gate:** a stranger's first 30 seconds contain nothing embarrassing.

## What gets cut when time is short
Cut content volume, extra systems, extra districts, feature breadth.
**Never cut:** the metrics scene, one blockout→playtest→iterate cycle, a locked
art direction, and verification on real output. Those are what separate a slice
from a mess.
