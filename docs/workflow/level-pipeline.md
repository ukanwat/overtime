# The world pipeline — order of operations

One rule above all others: **gameplay before art. The blockout must be good
before a single final asset is placed.** Every postmortem in the industry says
the same thing; every agent that ignores it produces a pretty demo that isn't a
game, or a dressed street it then can't afford to change.

## The passes, in order

1. **Paper design → `MAP_PLAN.md` (a required deliverable, written first).** Start with
   the **coastline silhouette** — the shape of the land is the first creative decision and
   everything else conforms to it (bays, headlands, a channel, islands, a barrier beach).
   Then a top-down sketch of the WHOLE city at target size, the district list with what makes
   each visually distinct, the water edge, the main artery, landmark positions, spawn,
   and where missions happen. Build to this plan — and if you change it, update it.
   Planning only the first street is how you end up with only one street.
2. **Blockout** — primitives on a grid, one flat grey material. Distinct greys
   for ground/wall; a bright colour for anything gameplay-critical (cover,
   objective, blocking volume). Walk it at player speed, never fly it.
3. **Greybox playable** — placeholder mission logic, triggers, traffic paths,
   police response. Prove the loop.
4. **Mesh pass** — real geometry and materials over the frozen layout. Budget
   split that professionals use: ~60–70% modular repeated pieces, ~20–25% hero
   assets at points of interest, ~10–15% tiling surfaces.
5. **Set dressing** — clutter, signage, awnings, rooftop units, street furniture.
   This is where "empty tech demo" is defeated. Ground detail (kerbs, crosswalks,
   drains, stains) matters more than another tower.
6. **Lighting pass** — sun angle and colour, sky, fog, exposure, post. Evaluate
   every material under BOTH noon and night; materials that only work in one are
   not done.
7. **VFX + audio** — particles, weather, engine sound, radio, ambience.
8. **Optimization** — profile first, fix what the profile says, not what you fear.
9. **Polish** — framing, feedback, wording, the last close-ups.

## Rules professionals never break
- Freeze **macro** structure (block sizes, street network, landmark positions)
  before dressing; leave **micro** (props, detail) mutable. Audio and mission
  work can proceed against a frozen macro layout — that's the whole point of it.
- Grid discipline from the first box. Everything snaps. If a piece doesn't fit
  the grid, the grid is wrong — fix the grid, not the piece.
- Playtest in-game with real physics and real speed, from the first blockout.
- A blockout that isn't interesting doesn't get art; it gets a new blockout.
- Sightlines and landmark visibility established in blockout are sacred.

## Sequence mistakes that wreck projects
art before layout · features before pillars · optimizing too early · lighting a
greybox · changing movement metrics after the layout exists · adding systems
during polish.
