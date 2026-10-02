# Detail and density — how "thousands of unique things" is actually done

The bar: **nothing in the player's view should look copy-pasted, and every surface should
reward a closer look.** That is what separates a world from a tiled demo.

The trap: trying to hand-author thousands of unique assets. Nobody does that — not even
the studios whose worlds feel infinitely varied. They build **kits + combinatorial
variation + a detail pass**, and the uniqueness is real *as experienced*, which is the
only kind that counts.

## The combinatorics — where the "thousands" actually come from

Do this arithmetic before you build. A handful of parts becomes a city:

- **Pedestrians:** 8 body/height variants × 12 tops × 8 legs × 6 hair/head × 10 colour
  palettes = **46,000+ distinct people from ~44 authored pieces.** Add 3 walk styles and
  2 accessory slots and no two people in a frame ever match.
- **Buildings:** 6 archetypes × 10 facade textures × per-instance height (3–20 storeys) ×
  width × tint × 4 roof kits × 3 ground-floor treatments = **tens of thousands of distinct
  silhouettes.** The instance parameters do the work, not the mesh count.
- **Vehicles:** 6 body types × 12 paint colours × 3 wear levels × trim/wheel variants =
  hundreds of cars, and traffic never repeats within a block.
- **Signage:** generate 200–400 business names procedurally (word lists × formats ×
  fonts × colour schemes × sign shapes) so **every single storefront in the city is
  unique text.** This is the highest perceived-uniqueness-per-byte trick available.

Rule of thumb: if a thing repeats, it must vary on at least **three axes** (scale, tint,
rotation, wear, prop set, signage). One axis of variation still reads as clones.

## Density targets, per block
- 8–15 named/distinct POIs per district (a reason to look at a place)
- 20–40 props per street block: AC units, vents, bins, hydrants, benches, planters,
  bollards, newspaper boxes, cables, satellite dishes, aerials, pipes, meters, crates
- 3–6 decal types per surface family: stains, cracks, patches, tyre marks, graffiti,
  posters, gum, water streaks under vents
- Every ground-floor unit gets: a sign, a door, a window treatment, and something
  outside it (chairs, crates, an A-board, a bike, a bin)
- No two identical objects adjacent; no identical building visible twice in one frame

## The detail pass (this is where "perfect" lives)
Do this AFTER the layout and lighting are stable, and do it at eye height:
- **Contact:** everything must touch the ground believably — kerb transitions, dirt
  gathering at wall/floor joins, shadows at contact points, no floating props
- **Wear where wear happens:** grime low on walls, rust at fixings, paint worn on
  handles/thresholds, tyre marks at turns, stains under drainpipes and AC units
- **Edges:** kerbs, thresholds, window reveals, roof parapets — flat edges read as fake
  faster than anything else
- **Verticality:** cables, wires, drainpipes, fire escapes, aerials, awnings. Empty
  vertical space is the loudest "unfinished" signal in a city
- **Windows:** never a flat black plane — reflection, interior parallax or lit rooms.
  Vary which windows are lit; the pattern of lit windows is the personality of a night
  city
- **Ground:** lane markings, worn paint, patched asphalt, manholes, drains, puddles in
  low points, leaves and litter against kerbs

## Deeper than the surface
- **Interiors:** a handful of enterable hero interiors beats fifty fake ones — but every
  non-enterable window needs interior parallax or lit geometry so it isn't a void.
- **Named things:** name streets, districts, businesses, radio stations, gangs. A world
  where things have names reads deeper than one where they don't, and text is free.
- **Written world:** billboards, posters, newspaper boxes, graffiti tags, shop menus,
  bus-stop ads. Hundreds of unique strings cost nothing and are read by players.
- **Sound density:** each district needs its own ambience bed plus point sources (AC
  hum, distant sirens, buskers, traffic) — silence reads as empty even when the visuals
  are full.

## Verify it
Screenshot at eye height in three different districts and ask:
1. Can I see the same object twice in one frame? (fix by varying instance parameters)
2. Is there any flat, undetailed surface larger than a few metres? (add decals, props, wear)
3. Does every storefront have unique text? (procedural signage)
4. Is any vertical space empty? (cables, pipes, aerials, awnings)
5. Would a stranger believe someone lives here?
