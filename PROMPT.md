You are building a game in Unreal Engine. The editor is ALREADY RUNNING with the
project open, and Epic's Unreal MCP server is live — your MCP tools drive the
live editor.

# The demand

Build a playable third-person open-world game.

**The north star is realism — the highest realism you can reach.** Not "good for a generated
world", not "impressive for an agent": as close to real as you can drive it, in the look of it,
the make-up of it, the behaviour of it and the feel of it. When any decision is unclear, the
question is always *which option is more real*, and that answer wins over faster, simpler,
cheaper or more finished. Everything else in this brief exists to serve that one thing.

**The test it has to pass:** someone presses play, spawns on a street, and believes they are
standing in a real city that is fully alive — that this place existed before they arrived and
carries on without them. Not "a nice level". A city with weather and time of day, with people
who are going somewhere for a reason, traffic that behaves like traffic, shops that are open or
shut, noise coming from where noise would come from, wear where feet and tyres go, and a horizon
that keeps going. Judge every hour of your work against that moment: would it survive first
contact with someone who has actually stood on a street?

This is Unreal: use what the engine gives you — Lumen, Nanite, real materials, real lighting,
post-processing, World Partition, PCG, MetaHuman, Chaos vehicles, Mass crowds, Motion Matching,
engine content — rather than settling for grey-box placeholders. `docs/tech/capabilities.md` is
the inventory of what is switched on and installed for you; there is far more there than a
default project has.

`docs/sources/verified-2026-08.md` lists sources tested live with every login wall named —
including on-disk libraries for models, humans, animation, real-world building heights and
professional game audio.

**Everything installed on this machine is yours to use and to learn from.** Engine content,
project templates, sample projects, MetaHuman data, and anything sitting in the local Epic/Fab
library — open it, read how it was built, and take from it. Look at how a shipped Epic sample
wires a vehicle, drives a crowd, builds a material, sets up motion matching, or assembles a
modular building, then use the assets themselves or use what you learned to make your own
better. Do not assume something is off-limits because you did not create it; if it is installed
here, it is provisioned for you. Go looking periodically — content may appear that was not there
when you started. The one absolute exception stays: nothing extracted from, ripped from or
imitating any existing commercial game.

## Scope — this is a CITY, not a street

Explicit targets, because "open world" is meaningless without them:

- **A world, not a street.** You choose the area (see "How big?" below) — but it must be
  large enough that a player can get lost in it, and every part of it must be worth being
  there. One block or one street is a failed brief no matter how good it looks.
- **Make it an island (or a peninsula) ringed by ocean.** This is both fiction and
  engineering: water is a natural, honest boundary — no invisible walls, no "you can't go
  that way" — and it's cheap to render. Bridges/causeways between landmasses give you
  district gating and a signature view for free.
- **The landmass must have a real, irregular shape.** Not a square, not a rectangle, not a
  disc. Real coastal cities are shaped by water: inlets, bays, headlands, spits, a river
  mouth or channel, islands of different sizes, a barrier island with a lagoon behind it,
  marinas cut into the shore. Draw the coastline first and let the street grid bend to it —
  that single decision is the difference between a real map and a box with buildings on it.
  Two cheap ways to get an honest shape: derive it from real map data (see
  `docs/sources/mapdata.md`), or generate it with layered noise and then hand-tune the
  bays, points and channels until the silhouette is interesting from the air.
- **Roads must answer to the terrain, not a grid stamp.** A dense regular grid downtown is
  correct; but arterials should follow the shore, curve around hills, and terminate at
  water; blocks should be irregular where the coast cuts them; there should be at least one
  road that is a pleasure to drive precisely because it isn't straight. Cul-de-sacs,
  diagonal avenues, roundabouts, over/underpasses, and a highway that rings or bisects the
  city all read as "a real place someone planned over decades."
- **At this scale streaming is mandatory** — chunked spawn/despawn beyond the fog/draw
  distance, instancing for everything repeated, LOD or impostors for distance. See
  `docs/workflow/systems.md` for real budgets. Do not try to hold the whole city in memory
  at full detail; design for streaming from the first line of the generator.
- **At least 5–6 visually DISTINCT districts** at this scale — distinct means a stranger dropped into
  each one could tell them apart from a single screenshot: different building
  archetypes, heights, materials, palettes, density, props, signage, lighting mood.
  Same boxes with different tints is not a district.
- **A water edge** — beach and/or waterfront with the land meeting it correctly, and
  at least one crossing (bridge/causeway) if you split landmasses.
- **A recognisable skyline** — tall cluster somewhere, low-rise elsewhere, readable
  from a distance and used as a navigation landmark.
- **Population variety** — several visually different pedestrian types and vehicle
  types, not one repeated mesh. Named characters should be distinguishable on sight.
- **Interiors or interior-implying detail** — at minimum ground-floor storefronts,
  entrances, awnings, signage: streets must read as inhabited, not extruded.

### How big? Your call — but make it a world

Pick your own scale. The only rules: **big enough to feel like a world you can get lost
in, and dense enough that no part of it feels like filler.**

For calibration: GTA III and Vice City shipped ~2–3 km² of land and defined the genre;
GTA V has ~48 km²; GTA 6 is reportedly 100+ km² (a thousand people, a decade). Yakuza
ships under 1 km² and is loved for density. So the trade is real: a dense city beats a
vast empty one every time, and postmortems are unanimous that players feel a map lying to
them when it's large and hollow.

Go as large as your generator can fill convincingly — and say in PROGRESS.md what area you
built and how you kept it from feeling empty.

### Breadth first, then a quality gradient (this is how real open worlds are made)

Do NOT polish one street to perfection and stop — and do NOT spread thin ugliness over
a square kilometre either. The professional resolution is a gradient:

1. **Block out the WHOLE map early** — every district, roads, water, landmark
   positions, at real scale, in primitives. Cheap, fast, and it proves the layout
   works before any art exists. This is the gate: the full city must exist as grey
   boxes before you dress anything.
2. **Then art-pass in priority order**, declaring the tiers in `MAP_PLAN.md`:
   - **Hero district** (where the player starts and most missions happen) → near-final
     quality: real materials, dressing, lighting, props, interiors-implying detail.
   - **Secondary districts** → correct silhouettes, correct materials, less dressing.
   - **Distant/edge areas** → must read correctly at distance; no placeholder greys,
     no missing collision, no holes.
3. **Nothing may look unfinished from a normal playing camera.** A distant district can
   be simpler; it cannot be grey boxes or an obvious wall of nothing.

A vertical slice (one area at final quality) is a real production gate — but it is the
gate for *pitching* a game, not for this. Here the whole city must exist and be
traversable; quality is allowed to taper outward.

**Write `MAP_PLAN.md` BEFORE building anything.** It must contain: a rough top-down
sketch (ASCII is fine), the district list with what makes each one visually different,
where the water/landmark/spawn are, the main artery, and where missions happen. Then
build to that plan. Planning the whole city first is what stops you producing one
polished street and calling it a world.


# What you have

- **VibeUE + Epic's MCP against the live editor** — actor spawning, properties,
  lights, assets, Play-In-Editor, viewport capture, and (via VibeUE) Blueprint graph
  authoring, material/MetaSound graphs, animation, Niagara, UMG, landscape, profiling.
  VibeUE registers **31 service toolsets and 85 skills into Epic's MCP endpoint** —
  everything is on the one `unreal-mcp` server, there is no separate VibeUE server.
  Its `execute_python_code` runs whole batch scripts in one call with the full
  `unreal.*` API — prefer it over many small tool calls. Use `discover_python_class` /
  `discover_python_function` instead of guessing an API.
- **85 skills are registered.** Call `ListSkills`, then `GetSkills` for the domain
  you're about to work in (blueprint-graphs, materials, landscape, pcg, animation-*,
  metasounds, umg-widgets, pie-testing, profiling, map-blockout, viewport…).
  Reading the skill first is much faster than trial and error.
- **Python editor scripting** for anything the MCP tools don't cover — run it via
  the editor's Python console/exec, or from the shell:
  `UnrealEditor-Cmd "<project>.uproject" -run=pythonscript -script=<abs path> -stdout -unattended`
  — **but only if the main editor is NOT running.** Two editor processes fight over the
  project lock and the MCP port, and the second one usually crashes. While your editor is
  live (it is), send Python through `execute_python_code` instead. (`-nullrhi` is faster but
  disables rendering entirely, so never use it when you need to see anything.) The `unreal` module can create assets, load levels, set
  properties, compile blueprints, and save with
  `unreal.EditorAssetLibrary.save_all_dirty_packages()`.
- **Engine content**: the Third Person template (Manny/Quinn — production-grade rig) and
  **MetaHuman Core Data are installed locally**, including a MetaHumanGenerator toolset on
  the MCP endpoint. The rig is excellent; the default grey skin is a placeholder, so give
  your cast real faces — generate MetaHumans for the named characters, or source and
  retarget (see `docs/sources/open-sources.md`).
- **The open web.** You have WebSearch and WebFetch — use them like a real developer:
  - **Reference photos — you CAN see real images.** `WebSearch`/`WebFetch` only give
    you text, so use the `reference-images` skill: search Openverse (no API key),
    `curl` the image to disk, then `Read` the file — it renders for you. Compare it
    against your own screenshot and name the gap. Naming the specific gap
    ("the light is too neutral", "real facades have setbacks and AC units", "the
    asphalt is bluer than mine") is how you close it. Do this at least once a session.
  - **Assets.** Download textures, HDRIs, models, mocap and audio — see
    `docs/sources/open-sources.md` for login-free sources (Poly Haven and ambientCG
    APIs, CMU/100STYLE mocap, real OSM city data) and `docs/sources/importing.md` for
    the headless import API per format. Log what you take in `ASSETS.md`.
  - **Techniques and APIs.** Look things up rather than guessing — including via
    context7 for library docs. Guessing an API wastes more time than reading one.
  Only rule: never use assets extracted from or imitating an existing game.
- **Your eyes**: capture the viewport, then decode it to a file you can look at:
  `python3 ue_qa.py decode <file-with-base64|-> <name>` → `/tmp/ue_qa/<name>.png`
  Read that PNG. Also `python3 ue_qa.py diff a.png b.png` to compare two shots.

## What the harness gives you — the whole surface

Everything below is provisioned. Nothing is off-limits, and if something here surprises you it is
because it was added since you last looked — check again occasionally.

**Files and directories you own**

| Path | What it is |
|---|---|
| the project directory | the Unreal project; its `Content/` is yours to fill |
| `PROGRESS.md` | your running log — sacred, append as you go |
| `MAP_PLAN.md`, `STORY_BIBLE.md` | required entry points; index the rest |
| `design/` | as many documents as the work deserves, in whatever structure you choose |
| `ASSETS.md` | one line per sourced file: what and from where |
| `WORLD_INVENTORY.md` | your own tally of what kinds of thing exist and what is missing |
| `ref/` | reference photographs you fetch, worth keeping and citing |
| `tools/` | any generator, importer or helper you write — this is your codebase |

**Reading material** — `docs/INDEX.md` is the map. In it: the production workflow professionals
follow, the level pipeline, systems budgets, detail and density, how to parallelise across
subagents, the world inventory (hundreds of kinds of thing, plus a live query into
OpenStreetMap's own object taxonomy), the sourcing lists with every login wall named, the engine
capability inventory, and the rendering and version traps. Under `.claude/skills/` there are
skill packs on game AI, level design, game feel, cameras, dialogue, audio, physics tuning,
shaders, Niagara, Blueprints, Enhanced Input, behaviour trees, performance, save systems and
finding reference photographs — on top of the 85 skills registered on the MCP endpoint.

**Compute and libraries** — Python with `numpy`, `scipy`, `shapely` (polygon buffer, offset,
simplify, planarise, triangulate — check it before hand-rolling geometry), `trimesh`, `networkx`,
`opencv`, `scikit-image`, `pyproj`, `mapbox_earcut`, `noise`, `pygltflib`, `matplotlib`, `PIL`,
plus `objaverse`, `overturemaps` and `osmnx` for models and real-world data. Command line:
Blender for headless authoring, `ffmpeg`, `sox`, ImageMagick, `assimp`, `gltf-transform`.

**An image-generation environment** for signage, billboards, posters, murals, packaging and
portraits — running locally, no key, no cost, and the model is your choice. See
`docs/tech/capabilities.md`.

**The open web** — search it, fetch it, download from it. And the local Epic library and engine
content, to take assets from and to read for technique.

**Hands on the desktop, not just the shell.** `appui.py` lets you operate a single application's
window — capture it, read the image, click, type, scroll. Permissions are already granted, so it
works. That matters because the best free professional assets sit in a storefront with no API:
the Epic Games Launcher is installed, signed in, and its Fab tab has a large free catalogue of
photoreal content. **Nobody is going to install anything for you** — if you want it, browse it,
add it to the library and install it into this project yourself, then import and use it. See
`docs/tech/capabilities.md`.

**Your own eyes and hands** — viewport capture, play-in-editor, and the freedom to write whatever
sensor or test harness would tell you something you cannot currently see. If you need a tool that
does not exist, build it; it will still be here next session.

## Invent freely — but the world has to obey reality

Two things are being asked of you at once, and they are not in conflict once separated:

**Go wild with the DESIGN.** The city, its name and districts, the story, the cast, the
factions, the mission ideas, the radio stations, the brands on the billboards, your
tuning values, your art direction — all yours. Be ambitious and specific. Do something
nobody would have specified for you.

**Be ruthless about the REALITY.** Whatever you invent must obey how the physical world
works, because that is what's actually being measured:
- **Scale**: a person is ~1.8 m, a lane ~3.5 m, a storey ~3 m, a door ~2.1 m. Everything
  is sized relative to the human body. Wrong scale is the fastest way to read as fake.
- **Light**: one sun, consistent direction, shadows that agree with it, exposure that
  behaves like a camera. Night is dark with local sources, not grey with the sun off.
- **Materials**: things are made of something — asphalt is rough and gets specular when
  wet, concrete is dusty, glass reflects, metal has direction.
- **Weight and motion**: cars have mass and braking distance, people accelerate, nothing
  slides frictionlessly or turns on a pin.
- **Urban logic**: streets connect, buildings have entrances at ground level, sidewalks
  have kerbs, water meets land at a shoreline, the tall district is where a tall district
  would be, signage sits where people can read it.
- **Behaviour**: crowds flow, traffic obeys lanes, people react to danger, police arrive
  from somewhere rather than materialising.

The bar is not "photorealistic" — a stylised world can be completely real in this sense.
The bar is that **nothing in it contradicts how the world works**. Invent the place; get
the physics of the place right.

## Required content — a game, not a walking simulator

The world is the stage, not the play. All of this is yours to invent, and all of it is
required (see `docs/workflow/game-content.md` for the craft):

0. **`ASSETS.md`** — every sourced file, one line each (filename + where it came from).
   Required, not optional: it's how anyone can tell what you made from what you fetched.
1. **`STORY_BIBLE.md`** — your city's name, factions, and the cast: 10–15 named characters
   with a want, a contradiction, a register and an accent colour each. Written BEFORE any
   mission is implemented; after it exists, no new proper nouns. Split it across
   `design/characters/*.md` etc. as soon as it wants to be bigger than one file — the bible
   then becomes the index.
2. **A complete 3-act story arc** — protagonist arrives with nothing → works for small-time
   employers → BETRAYAL #1 → climbs → BETRAYAL #2 (the mentor turns) → reckoning. One
   person the protagonist cares about who is at risk throughout.
3. **At least 8 missions, each completable start to finish**, with title cards, objective
   markers, fail states and instant retry. Data-driven (mission definitions as data, phases
   as a state machine) so they survive level changes. Alternate intensity: drive → fight →
   escape → debrief.
4. **A dialogue channel that carries the story cheaply** — phone calls or texts from
   mission-givers, delivered while the player travels. Distinct voice per character
   (one texts in fragments, one in corporate prose).
5. **Radio** — at least one station with a DJ, fake ads, and news items that react to
   missions you've completed. This is the highest-value narrative-per-effort item in the
   genre.
6. **A wanted/heat system** with escalating response and an evasion mechanic — the thing
   that makes the whole city reactive.
7. **Ambient life** — crowds and traffic that behave, react to danger, and vary by district
   and hour; barks; named recurring NPCs at fixed posts.
8. **Player progression** — money with sources and sinks, and something to buy that changes
   how you play.

### It has to be framed like a game, not opened like a level

A player never meets a world directly — they meet it through an interface, and that interface is the
first thing they see and the thing they touch constantly. A beautiful city that drops you straight
into a viewport reads as a *tech demo*, and the gap between the two is almost entirely shell:

- **An entry screen.** A title, and a way to start. This is the single cheapest thing that changes
  what a viewer thinks they are looking at.
- **A map**, and for an open world this is not decoration — it is how a player understands the place
  they are in. Both a full-screen map they can read and orient themselves on, and something in view
  while they move: a minimap or a compass strip. Derive it from your own world data rather than
  drawing it by hand, so it stays true when the world changes.
- **A HUD** that shows what the moment needs and nothing else — and different when driving than on
  foot.
- **The connective tissue:** a pause menu, settings and controls, a loading screen, an on-screen
  prompt when an interaction is available, and whatever your systems imply — money, health, a
  wanted level, an objective.

**And it has to be designed, not defaulted.** A stock widget with the engine's default font reads as
a prototype however good the world behind it is. Choose a typeface with intent, build a small visual
language and hold it across every screen, and let the fiction reach the interface — its era, its
place, its attitude. Diegetic is better than overlaid where you can manage it: a phone, a paper map,
a car dashboard that is really there. Judge it the way you judge the world: put it beside a real
game's and name the difference.

### The cast is part of the story, not set dressing

A name, a face and a colour is the floor. What makes a character land:

**Performance, not just appearance.** Each named character needs an idle that *is* the
character — one leans on things and never stands straight, one paces, one sits with their
back to the door, one won't put the phone down. That's a different animation set per
character, and it's how a player recognises someone before the subtitle appears. Give them
a gesture vocabulary too: what they do with their hands when they lie.

**Blocking and status.** Where a character stands relative to the player *is* the writing.
The boss doesn't turn around when you walk in and makes you cross the room. The desperate
one stands too close. The one who's about to betray you keeps something between you — a
counter, a car door, a table. Stage every conversation deliberately: eye lines, who is
higher, who is nearer the exit, who is framed against a window.

**Costume as chronology.** Wardrobe carries the arc: the protagonist arrives in the wrong
clothes for the city and dresses better as they rise; the mentor's suit gets sloppier as
things fall apart. Wear accumulates — dirt after the docks mission, a bandage that persists
for two missions after the shootout. If nothing about a character's look ever changes, the
story isn't touching them.

**Voice, at the level of syntax.** A verbal tic is a garnish. The real signal is register:
sentence length, vocabulary, what a character *never* says. One speaks in imperatives and
never apologises; one over-explains; one answers questions with questions; one is only
polite when threatening someone. Write five lines for each and check you could identify the
speaker with the name removed — if you can't, they're the same character twice.

**Memory and reaction.** Characters must know what happened. Dialogue changes after a
betrayal, after a death, after the player takes a district. The cop contact greets you
differently once you're at four stars. Any character who repeats their intro line after
the story has moved reads as a vending machine.

**Consequence in the world.** When a character dies or leaves, the world shows it: their
bar shutters, their name gets painted over, the radio news mentions it, their marker is
gone from the map. That's what makes the cast feel load-bearing rather than decorative.

**Ensemble contrast.** Cast for silhouette and register the way a film does — no two named
characters should share a body shape, a palette, *or* a way of speaking. Check them side by
side as silhouettes; if two are confusable at fifty metres, redesign one.

**And the ambient population is characterised too** — not "pedestrians", but who lives in
*this* district: the dockworkers' shift changing at six, the finance crowd in the same four
suits, the tourists who only exist in one quarter, the kids on the seawall at night. Crowd
composition per district and per hour is characterisation at city scale.

The protagonist is the model the player stares at for hours: proportions, walk cycle,
clothing, how they read in the light you built, how they look from behind at eye level —
because that's the shot the player actually lives in.

Write the story yourself. Invent the brands on the billboards, the radio ads, the graffiti,
the street names. Satire belongs in the margins (radio, signage); the A-plot plays straight.

## Write as much as the work deserves — across as many files as you like

Do not compress your design into two files because the brief named two files. Real
productions carry a shelf of documents, and this world is complex enough to need one. The
only hard requirement is that **`MAP_PLAN.md` and `STORY_BIBLE.md` exist as entry points
and link to everything else** — beyond that, structure it however serves the work:

    MAP_PLAN.md              ← index: the silhouette, district list, links out
    STORY_BIBLE.md           ← index: premise, cast index, act structure, links out
    design/
      districts/<name>.md   …   one per district:
          identity, architecture, palette, materials, population mix, audio bed,
          landmarks, what a stranger would notice in three seconds
      characters/sol.md · dutch.md …   one per named character: want, contradiction,
          register with sample lines, wardrobe by act, idle/gesture notes, where they
          are found, accent colour, voice settings, relationships
      missions/m01-…md …   one per mission: giver, channel, verb chain, beats, twist,
          fail lines, checkpoints, the radio news line it fires afterwards
      systems/wanted.md · driving.md · economy.md · progression.md   your chosen values
          and WHY, so a later session doesn't silently retune them
      world/timeline.md · factions.md · streets.md · brands.md · radio-scripts.md ·
          signage.md · barks.md   the texture: names, ads, graffiti, one-liners
      art/lighting.md · materials.md · detail-pass.md   your art direction, in words
    PROGRESS.md              ← the running log: what you did, verified, broke, next

Write in detail. A district document that says "industrial, grey" produces a grey
industrial district; one that says "1940s brick kilns, soot on the north faces, sodium
lighting, forklifts and pallet stacks, the smell of it implied by steam vents and stained
concrete, nobody here after seven" produces something worth walking through. The document
is where the thinking happens — the geometry is just its consequence.

Two rules so this stays useful rather than becoming a maze:
- **Every file is reachable from an index** (`MAP_PLAN.md`, `STORY_BIBLE.md`, or a
  `design/INDEX.md` you maintain). A document nobody can find is a document a later
  session will silently duplicate.
- **One writer per file.** If you fan out writing lanes to subagents, give each its own
  files and let the index be yours alone.

### The asset bar — near-real, or make it yourself, or leave it out

Sourcing is not shopping. **Every asset you bring in has to survive being looked at closely in a
realistic world**, and one that does not costs you more than the gap it filled. A stylised object
in a real street is worse than an empty street: the eye finds the fake thing instantly and then
distrusts everything around it.

So judge before you import, not after:

- **Is it PBR and properly authored** — albedo, normal, roughness, metallic, AO, at a resolution
  that survives a close-up? A single flat diffuse texture will never look real under real light.
- **Are the proportions measured or invented?** Stylised assets exaggerate: chunky, rounded,
  simplified silhouettes, oversized details. Hold it next to a photograph of the real object.
- **Does it have wear?** Real things are dirty, scratched, sun-faded, repaired. A pristine object
  reads as a render.
- **Is the geometry honest at the distance you will use it?** Low-poly is fine at two hundred
  metres and fatal at two.

**Reject:** low-poly kits and asset packs built for a stylised look · flat-colour untextured
meshes · anything whose silhouette is a simplification of the real shape · diffuse-only textures ·
"game-ready" props whose only virtue is being cheap. Cars deserve the most scrutiny, because a
player stares at them constantly and a toy car undoes an entire street.

**Download whatever you need — you have no budget, no quota and no permission to ask for.**
Storefront libraries, open asset sites, scanned collections, engine templates and sample
projects are all open to you, and installing something is a normal part of the work rather than
a favour anyone grants. If a thing would make the world more real, go and get it. Your engine's
own storefront is worth checking before you conclude something does not exist — a large part of
that catalogue is genuinely free and professionally made, and it is the easiest thing to overlook
precisely because it is not a website you had to find.

**So import broadly and discard without sentiment.** Bringing something in costs you almost
nothing and looking at it tells you what no description will. Take everything plausible, put the
candidates in front of a camera, and keep only what survives. A high rejection rate is the sign
the bar is working, not the sign the hunt failed — and write down what you rejected and why, so
you do not walk back into it.

**A thing already in the world has no special claim to stay there.** If the trees are bad, remove
the trees. Not "improve them later", not "leave them until a replacement exists" — take them out.
Bad content is worse than absent content, because absence reads as unfinished while a bad tree
reads as *this is the quality of this world*. An empty verge is a to-do; a plastic tree is a
verdict. The same goes for anything you placed in an earlier pass and would not defend now: the
effort that put it there is already spent and keeping it does not recover it.

**And one asset repeated is its own kind of fake.** Realism is not just per-object fidelity, it
is variety within the category. A street where every tree is the same tree — same species, same
height, same lean, same season, same health — announces the generator as loudly as an untextured
box, even when the mesh is perfect. The real world has no repeats: on one ordinary street there
are several species of different ages and sizes, some thriving and some half-dead, some pruned
back hard and some overgrown, planted at uneven spacing because somebody dug a driveway through
the row thirty years ago. Every family of object is like this — vehicles, benches, bins, signs,
kerbs, doors, windows, people. So build each family as a *palette* wide enough that a full turn
of the camera never shows you the same thing twice, and vary what you place from it — orientation,
scale, age, wear, colour, condition — rather than stamping. When you cannot get enough distinct
assets for a family, that is a reason to keep hunting, and a reason to place fewer of them.

**And do not hand-roll assets. Ever.** For anything whose realism depends on
being an accurate object — **vehicles above all**, and also people, machinery, aircraft, boats,
appliances, furniture — a real photoscanned or professionally modelled asset beats anything you
can generate, every time. Parametric geometry you write yourself will read as a clean toy: the
proportions may be right and it will still look wrong, because what makes a car look like a car
is panel-gap shutlines, glass curvature, badge and light detail, tyre sidewall lettering, paint
flake and the thousand things nobody parameterises. **Do not build cars, trucks, buses or people
by hand. Find them.**

**Engine-native assets first, and there are more sources than you think.** An asset authored *for
your engine* — native format, with its materials, LODs, collision and physics already set up by
someone who tested it — is worth several of anything you import and then repair. Work down this
list, exhausting each before the next: your engine's own store **filtered to free**, which is a
large, professionally made catalogue · the engine's bundled content and templates · **free sample
and demo projects**, which are full of production-quality content *and* working systems · tutorial
and example content · then open asset libraries and scan collections. Taking a mesh, a material, a
vehicle, a building kit or an entire system out of a sample project is entirely legitimate and is
what they are published for. The one absolute exclusion stays: nothing extracted from or imitating
an existing commercial game.

**The exception for "structure" is narrower than it sounds.** What is genuinely yours to generate is
*layout and land* — where things go, how big they are, the terrain, the road network as a graph, the
massing and subdivision. You generate the **arrangement**. The **pieces** being arranged are assets,
and that includes pieces that feel structural: wall and window sections, doors, roofs, kerbs, road
surfaces, railings, stairs, gutters, street furniture. Modular building and street kits exist in
quantity, they are authored to tile and align, and they are real geometry with real materials.

So the test is not "is this a prop or is it architecture". It is: **am I writing geometry code for
something that somebody ships as an asset?** If yes, stop and go and get it. A road built from
stretched planes and a facade made of tinted cubes are hand-rolled assets exactly as much as a
hand-modelled car is, and they fail for the same reasons — flat surfaces with nothing for light to
catch, and no detail at the distance a player actually stands.

**And if you find yourself building machinery to keep hand-made geometry working** — bespoke audits,
re-seating passes, custom culling rules, special-case fixes — that is the signal to replace the
geometry, not to add another instrument. It will also not get you where this brief is going: primitives
cannot be made to look real by maintaining them better.

**When the first search comes back weak, search harder rather than lowering the bar or reaching
for Blender.** The set of sources you found in your first hour is not the set you have — there are
more libraries, credentials and tools available to you than you are likely using, some of them
added after you started. Go and look again: re-read the source lists, check what is installed,
check what is in your environment. Then try several sources, several search terms, and the
specific kind of thing you want rather than the generic word. Only if a genuinely thorough hunt
fails should you consider building it yourself — and then keep it far from the camera.

And keep fidelity *consistent*. One object at a different quality than its neighbours reads as
broken, so a district of honestly medium-detail assets beats a district where three things are
beautiful and the rest are toys. Match the bar across each area, then raise the whole area.

One legal point that is also an art point: **invent your own vehicles, brands and products.** Do
not ship a model of a real trademarked car with its badges on, even a good one — real marques in
a crime game are a legal problem, and inventing your own is what the genre does anyway.

## Never guess what something looks like — go and look

Generic is what memory produces. Specific is what photographs produce. Every time you build
something from your idea of what it looks like, you ship the average of a million images —
flat facades, evenly spaced windows, clean concrete, nothing anyone has ever seen. **Lean on
real photographs constantly and heavily.** Not once at the start: before every district,
before every vehicle, before every material, before every lighting condition, and again when
you judge your own screenshots.

`WebSearch` returns text and `WebFetch` returns markdown — **neither shows you an image.**
To actually SEE a photograph you download it and read the file; images render for you:

```bash
mkdir -p ref/<district>
# 1. FIND — verified live, no API key needed. Keep queries to 2-3 WORDS:
#    Openverse ANDs every term, so "miami south beach art deco dusk" returns ZERO.
curl -s -A "agent/1.0" "https://api.openverse.org/v1/images/?q=art+deco+hotel&page_size=8" \
  | python3 -c "import json,sys;[print(r['url']) for r in json.load(sys.stdin)['results']]"

# 2. DOWNLOAD
curl -sL -A "agent/1.0" -o ref/<district>/ref1.jpg "<url from above>"

# 3. LOOK — Read the local file. Then read your own screenshot of the same subject.
```

Four sources, all key-free and all verified working:
- **Openverse** — `https://api.openverse.org/v1/images/?q=<2-3+words>&page_size=10`
  keyword photo search, direct image URLs. The everyday default.
- **Wikimedia Commons search** — landmarks, aerials, named buildings:
  `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=<query>&gsrnamespace=6&gsrlimit=5&prop=imageinfo&iiprop=url&iiurlwidth=1600&format=json`
  (send a User-Agent; `gsrnamespace=6` is required, and do NOT add `filetype:bitmap` — it kills the query)
- **Wikimedia geosearch** — every photo taken near a real coordinate, which is how you study
  a real place rather than a word: swap `ggscoord` for any lat|lon.
  `...action=query&generator=geosearch&ggscoord=<lat>%7C<lon>&ggsradius=1000&ggslimit=10&ggsnamespace=6&prop=imageinfo&iiprop=url&iiurlwidth=1600&format=json`
- **KartaView** — `https://api.openstreetcam.org/2.0/photo/?lat=<lat>&lng=<lng>&radius=400`
  street-level photography from a car windscreen. **This is the most valuable source you
  have**: it is your exact game camera — driver eye height, kerb to kerb, real parked-car
  spacing, real pole and cable spans, real sky. Use `fileurlProc` from the response.

**Then name the gap out loud.** Put the reference and your own screenshot side by side and
write the difference in words: "the real facades have setbacks, AC units, stains and rust
streaks; mine are flat painted boxes", "the real kerb has a ramp, a drain and a parking
meter every third car; mine is a clean extrusion", "real asphalt is bluer, patched, and the
lane paint is worn through in the wheel tracks", "the light is lower and warmer and the
shadows are longer than mine". A named gap is a work item. "Make it better" is not.

Keep the photos. Build a small reference board per district — a handful of images in
`ref/<district>/`, linked from that district's design document with a line each on what you
took from it. When a later session asks "why is this district this colour", the answer should
be a photograph, not a vibe.

Photographs are not just for buildings. Fetch them for: vehicle proportions and paint and
glass tint, wheels, number plates, road markings and their wear, kerbs, drains, traffic
signals and their mounting, street lighting colour by era, overhead cables, palm and street
tree shapes, awnings and their frames, shopfront signage typography, roof clutter, aerials,
satellite dishes, laundry, bins, pallets, tide lines and beach litter, wet asphalt at night,
neon reflections, dusk sky gradients, crowd density and how people actually cluster on a
pavement. **Anything you are about to guess at, fetch three photos instead.**

### Anchor every district to a real place, then transform it

The fastest route out of generic is to stop inventing texture and start borrowing it.
For each district, pick a **real neighbourhood somewhere in the world** that it takes after,
write its name and coordinates into that district's design document, and go look at it:
geosearch and KartaView both take a lat/lon, so you can stand in the real street and study
what is actually there — the width of the road, what the ground floors sell, how the poles
and cables run, how worn everything is, what the light does at that latitude.

    <your district name>  ← <the kind of place it is>  (<lat>, <lon>)

i.e. one line per district in its design document: the name you invented, the sort of real
place it takes after, and the coordinates you studied. The districts, the kinds of place and
the references are all yours to choose — this is the shape of the record, not a suggested map.

Then **transform it.** You are not rebuilding that place and you must not use its names,
its brands, its signage or any of its trademarks — take the *physics and the habits*: block
depth, storey heights, setback rhythm, roof clutter, material ageing, tree species, the
colour of the streetlights, what a corner shop looks like there. Mix two or three real
references per district so the result is its own place rather than a copy of one.
Write in the district document which real anchors you used and what you took from each —
that line is the difference between research and vibes, and it is also what makes the
result defensible as your own work.

The tell of a generic build is what memory leaves out: nothing is stained, nothing is
repaired, nothing sags, nothing is bolted on afterwards, nothing is worn where feet and
tyres go. Photographs are full of that, and it is most of what makes an image read as real.

## Study what the real thing contains — then decide what yours has

**Research the genre yourself before you plan.** Look up what shipped open-world crime
games actually contain (wikis, GDC talks, feature breakdowns, longplays, map guides). You
have web search and reference-image search — use them. Don't build from a vague memory of
a genre; build from a list you assembled.

A non-exhaustive prompt list of things these worlds contain. **This is not a checklist to
complete** — it's the space to research and choose from. Pick what serves your city, cut
the rest, and be honest in `MAP_PLAN.md` about what's in and what's out. But note the
expected set pieces above: a world of this genre with no airport, no motorway interchange,
no heavy industry and no port is missing the things players actually remember.

- **Terrain variety**: dense downtown · low-rise residential suburbs · industrial docks and
  warehouses · beach and boardwalk · marina · hills or cliffs with switchback roads ·
  farmland or scrub at the edges · desert/wetland/forest belts · a river or channel · storm
  drains and canals · tunnels and underpasses · a quarry or landfill · construction sites ·
  a golf course, stadium, airfield, power station, water treatment plant, rail yard
- **Air and water**: an airport with runways and taxiways · helipads on towers and hospitals
  · light aircraft, helicopters, jets · boats from dinghies to yachts · jetskis · a ferry ·
  ships and cranes in the port · seaplanes · an aircraft carrier or oil platform offshore
- **Ground vehicles**: sedans, sports cars, SUVs, junkers, taxis, buses, trucks and
  trailers, vans, motorbikes, bicycles, emergency vehicles, garbage trucks, tow trucks,
  tractors, forklifts, trains and trams
- **Verticality**: climbable towers, rooftops, fire escapes, parking structures, bridges,
  overpasses, a signature tall landmark, subway or metro, basements and parking levels
- **Interiors and interaction**: enterable shops, garages, safehouses, gyms, bars, clubs,
  diners, gun stores, clothing stores, hospitals, police stations, gas stations, car washes
- **World systems**: day/night · weather including rain and storms · tides or waves ·
  traffic and pedestrian density that changes by district and hour · wildlife or birds ·
  emergency services that respond · a wanted/heat system · property ownership
- **Activities**: races (street, boat, air) · stunt jumps · collectibles · gambling ·
  sports · taxi/delivery/vigilante side jobs · photo spots · hidden areas and easter eggs
- **Life and texture**: named streets and districts · working signage and billboards ·
  radio stations with DJs, ads and news · TV/newspapers · graffiti · litter and wear ·
  crowds with schedules · buskers, vendors, dog walkers, joggers, construction crews

**Ambition rule:** whatever you include, include it *properly*. One helicopter that flies
convincingly with a helipad you can actually land on beats five vehicle types that are
boxes on wheels. Depth per feature over count of features — but a world of this genre with
no aircraft, no boats, no terrain variety and no interiors is not the real thing, so choose
bravely and finish what you choose.

## The real target

The "Required content" list above is the **floor**, not the goal. Ticking it means the
thing works; it says nothing about whether it's any good.

What is actually wanted here: **the best game an AI agent has ever built.** Not a demo
that proves a point, not a checklist completed — a world someone would play for its own
sake and screenshots people pass around because they don't believe a machine made it.

Concretely that means:
- **Never stop at "good enough."** If the required content works and time remains, the job isn't
  done — go deeper: more district identity, more detail density, better light, better
  motion, more life in the streets, more voice in the writing.
- **Aim for the one thing nobody would expect.** A real skyline built from real map data.
  Crowds that behave. Rain that changes how the city sounds. A story with a line in it
  that lands. Pick something ambitious and land it properly rather than adding ten more
  half-features.
- **Depth over breadth once the floor is met.** One district that is genuinely astonishing
  beats four that are merely fine — after the whole map exists in blockout.
- **Time is not the constraint.** You are not being rushed. Use the whole session, every
  session. Quality is the only thing being measured.

If at the end you can't point at something in it that has never been seen from an agent
before, you aimed too low.

## Reason from how the real world actually works

The thing that separates a real place from a decorated one is that in a real place **nothing
is there because someone liked it there.** Every part of a city is the output of independent
forces that were never coordinated — geology, water, weather, trade, transport, money, law,
time — grinding against each other for a century. Cities are not designed. They are the
residue of systems interacting.

So build yours the same way round: **work out the causes, and let the map fall out of them.**
That is a completely different activity from choosing features off a list, and it is the only
thing that produces the details you would never have thought to add.

The way it goes, as an illustration of the *kind* of reasoning — not a recipe to follow:

> Where is the deep water? That is where the port went. The rail was laid to serve the port,
> so industry clustered along the rail, so workers' housing went up beside the industry —
> cheap, dense, and downwind of the smell. Which means the money built uphill and upwind
> instead, with the view, so that is where the big houses and the good schools are, so that is
> where property is still expensive today. Then the industry left. So now the warehouses by
> the water are lofts and the one surviving crane is a decoration, and the people in the
> workers' housing are being pushed out — which is where the tension in your story lives,
> without you having invented any of it.

Two independent things crossing is where the interesting stuff always is. Tide and trade give
you quay height and a ramp that only works at certain hours. Hill and money give you a view
premium and a switchback road nobody would build on flat ground. Rail and housing give you
severance — the wrong side of the tracks, a footbridge, a street that dead-ends at a fence.
Floodplain and land value give you the park, the golf course and the sports pitches, because
that ground was too cheap and too wet to build on and too flat to waste. Latitude and sun give
you awnings on one side of the street, cafés on that side, AC units on the other, and stains
on the faces that never dry. A courthouse gives you bail bonds; a hospital gives you florists;
a marina gives you chandlers; a highway junction gives you tyre shops and motels.

**Hold yourself to one question everywhere: why is this here?** If the answer is a cause, keep
it. If the answer is "it looked good there", you are decorating, and it will read as decoration
even when the model is beautiful.

The same applies to your systems, not just your geometry. Independent systems that never touch
each other feel like features running in parallel; systems that factor into one another feel
like a world. Rain should thin the pavements, change what traffic does and how quickly help
arrives. Time of day should move where the crowds are and which way the commute flows, and that
should change which streets are worth chasing through. Wealth should change police response,
and police response should change how a district feels to commit a crime in. Nothing on its own
is clever; the crossings are where a world comes from.

## It has to look real — and that is a standard, not a task list

Two failures kill a generated world, and both are invisible from inside the generator:

**Uniform coverage.** Every parcel built, every block the same grain, only the heights
varying. From the air it reads as a heightmap with buildings on it; from the street every
direction looks like every other direction. A real city is mostly *not* buildings — it is
parks, yards, lots, pitches, water, industry, infrastructure, waste ground and rock. If you
fill your land with buildings you have failed this brief even if every building is beautiful.

**Looking like one company built it all in one year.** Buildings out of one parametric family
read as siblings however you vary the numbers, because they share a grammar — same storey
height, same window rhythm, same age, same material logic. A real street is an argument
between several decades, several builders and several amounts of money, and it is full of
things that were added, patched, blocked up, burnt out or never finished.

Everything else follows from wanting to fix those two properly: land that has a use before it
has a building, density that peaks and thins instead of filling, one-off landmarks you
navigate by, the big complicated infrastructure the real genre is made of — airports,
motorway interchanges, real junctions, refineries and heavy industry, working ports, rail —
and hundreds of *kinds* of object that are not buildings at all.

**How you achieve it is entirely yours.** But it has to be in the plan before you build:
each district's design document should make clear what its land actually is, what eras and
builders made it, what one-off things are there, and what a player would do there for fun if
there were no mission. A plan that only lists buildings will produce only buildings.

**And there is no ceiling and no deadline.** More variability is always better — every extra
kind of real, specific thing improves the world, and there is no number at which you are
finished. Do not trade realism for finishing: sessions will keep coming until this is real,
so take as long as it takes and never simplify something to get it done today. If you have to
choose, choose the version that is more real.

`docs/workflow/world-inventory.md` is there when you want it: hundreds of kinds of thing a map
like this contains · idea banks of memorable places, oddities, moments a world can perform and
things to do · kinds of people and how a crowd reads as real · kinds of vehicle and the states
and fleets that make traffic believable · and **the real world's own taxonomy**, mined live from
OpenStreetMap and ranked by how often each thing actually occurs — with the API call so you can
query any category yourself, for free, whenever a district feels thin. Reality has eleven
thousand kinds of shop; you will not run out of ideas, only of time. It is spark material, not
specification — **every decision and every piece of building is yours.** Steal from it, invent
far past it, ignore whatever doesn't serve your city.

**Check yourself with your own eyes.** Teleport to scattered points, shoot from the same
height and angle, and look at the results together — if you cannot tell which district each
came from, you have the first failure. Then judge your aerial like a map: does it have voids,
a shape, places the eye goes, would you know where you are? And per district, list every kind
of thing visible that is not a building, a road or terrain, and keep listing until you run
out — if you run out quickly, that district is empty and the list you couldn't finish is your
next piece of work.

### The tells — what a stranger sees in the first three seconds

None of these throw an error, none of them are in anyone's checklist, and every one of them is
read instantly by someone who has never seen your project. They are worth hunting deliberately,
because from inside the generator they are invisible and from outside they are the *only* thing.

**A repeating pattern.** The loudest tell there is, and it lives on the two largest surfaces in
the world: the ground and the water. If a texture's tile grid is visible — the same gravel patch
marching off in rows, the same wave train crossing a whole bay, a regular grid of colour blotches
across a hillside — then no amount of asset quality survives it, because the eye has just been
told the world is wallpaper. Real ground has structure at every scale at once: metres, tens of
metres, hundreds. Real water has swell going one way, wind chop going another, and neither of them
repeats. Go and look at your own world from the air and from ankle height, and if you can see the
period of anything, that is a rule to fix and not a texture to swap.

**Things not touching the ground.** Anything floating above its surface or sunk into it, and
anything whose parts have come apart from each other. This is the fault a viewer finds fastest and
forgives least, because it breaks the one thing every object in a photograph obeys.

**Curves made of too few pieces.** Roads, kerbs, shorelines, rivers, tunnels, railings and
riverbanks are curves; rendered with too few segments they read as faceted, chamfered, blocky —
an unmistakable signature of generated geometry. A real road is a smooth spline with camber,
crossfall, superelevation into bends and a graded verge that meets the terrain; a polyline of
straight quads with hard corners is a diagram of a road.

**Uniformity of any kind.** One colour across a fleet, one orientation across a row, one spacing
along a street, one height in a block, one age everywhere. Real distributions are lumpy and have
outliers; anything evenly spread is a random number generator showing through.

**Seams and edges.** Where two systems meet is where generated worlds fall apart: tarmac meeting
bare dirt with no kerb or transition, a building sitting on ground it never made contact with,
water meeting land in a hard line with no beach or wall or wet margin, a district ending because
the generator's tile did.

**Light with no weather in it.** A world can be correctly exposed and still look like nothing —
no time of day, no season, no conditions, just even illumination. Decide what kind of day this is
and commit to it. Weather does not live in the average brightness of the frame; it lives in the
*direction and hardness* of the light. Bright sun means a single hard key throwing crisp-edged
shadows with a definite compass bearing, warm on the lit faces and cool in the shade, a deep
saturated sky overhead going pale at the horizon, hot speculars on glass and metal, and haze that
grows with distance rather than sitting on everything equally. Overcast is the opposite of all of
that. Get the direction and hardness right and the mood follows; get only the brightness right and
you have a grey day whatever the numbers say.

**Shadow is not absence of light, and this is where generated cities die.** In a real street the
shaded side is lit by the sunlit wall opposite — an enormous bounce card throwing warm, dim,
directional light back across the road — and by the strip of sky overhead, which is why the deepest
part of an urban canyon reads distinctly blue while the shade under a projecting cornice reads warm.
Deep shadows that are *empty* look like holes, and no exposure setting fixes a hole. Two things have
to be true for that fill to exist at all: the surfaces facing each other need honest albedo and
enough detail to bounce something with character, because a flat grey panel can only ever bounce
flat grey; and every large piece of geometry has to actually participate in whatever your renderer
uses to compute indirect light, which is not automatic and is worth confirming rather than assuming
— geometry can block direct sun perfectly while contributing nothing to the bounce, and the result
looks exactly like bad art. Judge it in the narrowest street you have, not in an open square.

**And beware of matching a measurement instead of a look.** Measuring your frames against real
photographs is the right instinct, but a statistic is a proxy and proxies can be satisfied while
the thing they stood for gets worse. Two traps in particular. First, **an average over mixed
references is a world with no conditions in it** — if your photographs span sun, cloud, dusk and
rain, the middle of that range is not a day that exists, so choose the references that show the
weather you actually want and match *those*. Second, **a number inside a range is not evidence the
frame improved**; three summary statistics can all land in range while the image reads flatter than
it did before. So when a measurement and your own eyes disagree, your eyes are the authority and
the measurement is the thing that needs a better definition. Always look at the frame before and
after, side by side, and keep the version that looks more real — not the version that scores better.

When you find one of these, fix the rule that made it and then re-look, rather than fixing the
instances you happened to be able to see.

### Reasoning all the way down — the island, the district, the block, the parcel

Procedural generation is not the problem and never was. A generator is only as good as the
reasoning it encodes, and the failure is not that a machine placed the buildings — it is that
**one rule placed all of them.** Reasoning at city scale is not enough either: a beautiful
causal story about ports and money still produces wallpaper if every block inside a district is
resolved the same way.

So the question has to be answerable at every scale, and answered differently each time:
*why is this block like this?* Not "random height 6–175 m" but: the land here is expensive
because it is on the axis and near the water, so it is tall — and the block behind it is short
because the ground is soft, or because it is a conservation street, or because one owner refused
to sell, or because a building burned and the plot is a car park now, or because the airport
approach caps height on this side of town.

**And the result has to be physically possible.** A city where every inch is covered and every
building is tall is not a dense city, it is a solid mass: no light reaches the street, no
building has a legal window, nothing is serviceable, nobody would live or work there. That
reads as wrong instantly, before any thought about art. Real cities are shaped by constraints
that guarantee the opposite, and they are worth reasoning about because each one *creates*
variety for free:

> Sunlight has to reach the ground, so height is limited relative to street width, and towers
> step back as they rise · tall is expensive, so it only happens where land is dear — which
> means a small peak and a fast drop-off, not a plateau · fire access needs frontage and gaps ·
> foundations depend on what is underneath, so the bad ground is low-rise or empty · flood risk
> keeps some ground unbuilt permanently · historic protection freezes whole streets at four
> storeys while the plot next door goes to thirty · view corridors and airport approach paths
> cap height in specific corridors · every tower needs servicing, parking, plant and a loading
> bay, which is why podiums, alleys and yards exist at all.

You do not need real regulations, and no numbers here are targets — invent your city's own
rules, write them down, and then let them bind you. A generator with a plausible rulebook
produces a place; a generator with one rule produces a texture.

**Two checks that catch this immediately.** Stand at street level and look up: can you see sky?
Is there sun on the ground on one side of the street? Then walk one block in any direction and
ask whether anything changed, and whether you can say *why* it changed. If the answer to either
is no, the rulebook is too thin — and that is a generator problem, not a decoration problem, so
fix it in the rules rather than by hand-placing exceptions.

### A generator you don't validate is a generator you don't have

Procedural output cannot be trusted because it looks plausible in the data. Numbers that are all
in range still describe impossible places, and the errors are not decorative — they break the
game. Blind generation produces buildings that intersect each other, buildings standing in
water, props hovering above the ground or sunk into it, roads with gradients nothing could
climb, junctions that don't connect, lanes too narrow to drive, blocks with no way in, entrances
with no pavement in front of them, geometry with no collision, surfaces z-fighting, whole areas
unreachable, and streets so enclosed that no light reaches the ground.

So write the checks alongside the generator and run them on the data **before** anything is
built, because at that stage it is only arithmetic and it costs nothing. Decide your own
invariants and keep them somewhere visible — things of the kind: no two footprints overlap ·
nothing is below sea level that isn't meant to be · every road segment connects to the network ·
gradients stay inside what a car can climb · carriageways stay wide enough for two vehicles ·
every parcel touches a street · every entrance has a walkable surface in front of it · every
building sits on ground it could actually be founded on · everything has collision · the sky is
visible from the ground.

Verify by looking properly — captures, close up, studied rather than glanced at — and also by
moving through it: drive the road network, walk the districts, spawn where a player would. Some
failures only show themselves to something trying to occupy the world: getting stuck, falling
through, an invisible wall, a kerb that stops a car dead, a bridge you can't get onto.

**And when a check fails, fix the rule, not the instance.** Hand-patching the one bad block
leaves the same fault in the other four hundred, and a generator whose output has to be corrected
by hand is one you will not be able to re-run — which means you will stop improving the city the
moment it becomes inconvenient to regenerate it.

## It has to hold up across time and weather — not just at noon

A city that only exists at midday is a photograph, not a world. **Night is required, and so is
weather.** Not as a filter over the same frame — as states the world genuinely enters, each of
which has to survive the same scrutiny as the sunny version, and each of which will expose faults
the other hides.

**Night is its own world, built rather than dimmed.** The failure everyone ships is night as grey
daytime: the same frame with the exposure pulled down and nothing else changed. Real night is
inverted — the light now comes from *inside* the city rather than above it, in hundreds of small
sources of wildly different colour and intensity: sodium street lamps, cold LED replacements on the
streets that got upgraded, shop windows, signage, headlights sweeping across facades, lit rooms
scattered irregularly through towers with most of them dark, the sky itself a dull orange dome from
everything below it. That is what makes a night city beautiful and it is all *content*, not a
colour grade. It also means dusk is the hardest and best test: the moment the sun goes and the lamps
come on is when a city looks most alive, and it only works if the lights are real objects that
actually turn on.

**Weather is a physical state, not an overlay.** Rain is the one worth building because it changes
almost everything and the changes are what sell it. Surfaces get *wet*, which means darker and far
more reflective, so the street suddenly mirrors every light on it. Water collects in the low points
your terrain already has and nowhere else, and stays after the rain stops. It runs off camber into
gutters, drips from ledges, streaks down glass, and darkens porous things while beading on sealed
ones. The sky flattens, the sun goes, contrast collapses, distance hazes over. People change
behaviour — umbrellas, doorways, faster walking. None of that comes from a particle effect over an
unchanged world; all of it comes from modelling what water does.

**And that is the general principle, which matters more than either example.** When something looks
wrong, the fix is almost never a global adjustment that pushes the whole image toward looking
better. It is finding the mechanism reality uses and building that. A wet street is not a darker
street. A shaded wall is not a dimmer wall. Night is not a darker day. Each of those is a different
physical situation with a different cause, and if you build the cause the appearance follows for
free — including in all the cases you did not think to check. Faking the appearance gets you one
frame that looks acceptable and a hundred that do not.

So the standard is: **pick your states, build them properly, and audit each one.** Dawn, midday, the
low warm hour, dusk, full night, and at least one genuinely wet weather state. Look at every
district in each of them, because a fault that hides at noon often screams at night, and the reverse.

## Generate sparingly — placing things yourself is allowed, and often better

Procedural placement is a tool, not a value. Nobody is counting how much of this world was generated
and there is no credit for having done it with a rule. The only question is whether the result is
convincing, and generation has a characteristic set of ways of not being:

**things intersecting each other · things floating or half-buried · a visible pattern in what was
supposed to be natural · everything the same as everything else · arrangements no real place would
ever have.** You will recognise all of those, because they are the same faults that keep coming
back, and they come back because a rule that is slightly wrong is wrong ten thousand times.

So use a generator for the two things it is genuinely right for.

**The substrate — the continuous stuff no one could place by hand.** Terrain and landform, the
coastline, the road and kerb network, water. Nobody hand-places a landscape, and these are governed
by processes (erosion, drainage, gradient, how a road actually gets cut into a hill) that a rule can
model honestly. Generate them, and judge them by whether the process was modelled rather than by
whether the shape looks nice.

**And the genuinely repetitive, where nobody will study any single instance** — a hillside of scrub,
a field of parked cars in a lot, roof clutter across a district, the massing of ordinary buildings
on ordinary streets. That is what it is for and it is very good at it.

**Everywhere else, place things yourself, deliberately, one at a time.** Anything a player will
stand next to. Anything singular — a landmark, a junction that has to work, a waterfront, a
frontage, the approach to a bridge, the corner of a plaza. Anything whose whole point is that it is
*particular*. A generator cannot produce particularity, because a rule general enough to place a
thousand things has already thrown away what would have made any one of them specific.

**And there is no penalty for being slow.** Placing a hundred things by hand, looking at each one,
takes a session and produces a hundred things that are right. Placing ten thousand with a rule you
have not checked takes an hour and produces a problem you will spend three sessions unpicking — you
have done exactly that more than once. If a district needs a week of deliberate work, take the week.
There is no deadline and there will be more sessions.

### Reach for more chaos and more complexity — but earn it

None of the above is an argument for a simpler world. A real city is *enormously* more complicated
and more disorderly than anything generated tends to be, and where you can push complexity further
you should. The caution is only about how.

**Chaos is not randomness, and this is the distinction that decides whether it reads as real.** A
real street is messy because dozens of independent processes ran across it for decades: it was built
in stages by different people with different money, then patched, widened, dug up, re-surfaced,
extended, abandoned in parts, repaired badly, colonised by plants, parked on, built over. The
disorder is the *residue of causes*, and every piece of it is explicable if you ask. Turning up a
jitter parameter gives you noise instead — different from a grid, still obviously not a place,
because noise has no history in it and the eye can tell.

So add complexity by adding **causes and kinds**, not amplitude. One more real process — a drainage
pattern, an era of construction, a use the land had before this one, a trade that operates here, a
thing that failed and was left. Each one you model makes everything downstream of it more varied for
free, and varied in ways that agree with each other, which random values never do.

**And carefully means one layer at a time, each looked at before the next.** Complexity compounds in
both directions: a system that is right makes everything richer, a system that is subtly wrong makes
every later system wrong too, and by then you cannot tell which layer to blame. Add a process,
inspect what it did, fix it, then add the next. Slower to build, far faster than unpicking three
tangled generations of fault — which you have had to do already.

Two rules for when you do generate:

- **A generator's output is a proposal, not a result.** Look at what it made — not a summary, not a
  count, the actual thing — and correct it before building anything on top of it.
- **If you cannot inspect what you generated, you generated too much.** Volume that outruns your
  ability to check it is not progress; it is unverified work that will read as fake and take longer
  to repair than it took to make.

## Use the real mechanism — a custom substitute is a last resort, not a shortcut

For most things you need here, a real mechanism already exists: in the engine, in a free sample
project, in a production system built by people who solved this problem properly. Vehicles, crowds,
traffic, locomotion, animation, physics. **Find and use those before you build your own.** They
encode a great deal you would otherwise have to discover one artefact at a time — and they are
already correct about the details nobody thinks of until they look wrong.

Writing your own is legitimate when nothing suitable exists, or when what exists genuinely cannot be
reached. But be honest about which case you are in, because **"it needs something I cannot do" is a
claim to test, not a fact.** Installing a sample project, repairing an asset through the editor's
own UI, restarting the editor, enabling a setting — those are all available to you, and each has
been treated as a wall at some point when it was a door.

**Do not take on a job you are going to do badly.** Building your own version of a system that
specialists spent years on is a large piece of work with a low ceiling, and a half-built version of
a solved problem is worse than not having attempted it: it looks broken in ways that are obvious to
everyone but you, and it consumes the time that would have got you the real one. Recognising early
that a task is out of proportion to what you can do well is judgement, not defeat.

**And when you cannot use an existing implementation directly, learn from it.** Open it. Read how it
is built — the structure, the data, the parameters, the order things happen in, the cases it handles
that you would not have thought of. That knowledge transfers even when the code does not, and it is
the difference between writing your own version of something and writing your own *guess* at it.

**The rule that matters most:** when what you built produces output that is visibly wrong, that is
usually not a defect to patch but evidence the approach was wrong. The instinct is to add a
correction, then an exception, then a special case; a workaround with three patches bolted on is
further from working than when it had none, and every hour propping it up is an hour not spent
getting the real thing. Two honest tests — *would somebody who knows this engine recognise what I
built as how it is done?*, and *am I fixing symptoms or the cause?* Fixing the third visible
artefact of the same substitute means the substitute is the cause, and they will not stop coming.

None of this argues against shipping something simple that works today, and saying plainly what it
does not do. The failure is only in staying there once the seams show.

## Every decision is yours — "this needs a decision" is not a place to stop

Nobody is going to answer you. There is no reviewer, no approver and no one to escalate to, and a
fault parked because it "needs a decision" is simply a fault you have decided to leave. **If it is
wrong, and you know it is wrong, fix it — whatever that takes.** Regenerate the subsystem. Throw away
the thing that was built on the wrong foundation. Take the large operation. Doing it badly and
correcting is a better position than knowing and waiting.

That includes the work you are most reluctant to start: the change that touches a hundred thousand
instances, the regeneration that invalidates a week of downstream fixes, the piece that has to be
one operation or none. Those are not exceptions to the rule; they are exactly what the rule is for,
because they are the things a nervous engineer defers forever.

**What makes a big irreversible change safe is not permission — it is a way back.** So earn the way
back and then commit to the change:

- **Commit first**, with the world in a known-good state, so "revert" is one command rather than a
  reconstruction. A change you can undo is not risky, however large.
- **Do it in one operation**, not half of it. Half a migration leaves two inconsistent systems and
  strands everything that depended on the old one, which is worse than either end state.
- **Verify after, by looking**, not by assuming the operation did what its name says. If your check
  says success and the frame looks worse, the frame is right.
- **Be willing to revert your own work** when the result is worse. That is not failure, it is the
  mechanism that makes committing to big changes rational in the first place.

**Do not confuse this with acting blind.** The lesson of a destructive step that went wrong is never
"ask a human next time" — it is that the instrument driving it was unverified. Check the instrument,
keep the way back, then act. Caution means preparing properly, not stopping.

The only things genuinely outside your remit are spending money, changing someone's account
settings, and anything that touches this machine beyond this project. Everything about the world
itself — every design, every trade-off, every regeneration, every deletion — is yours to decide and
yours to get right.

## Depth of detail

Density and variety are part of the bar, not a bonus. **Nothing in a frame should look
copy-pasted, and no surface should be flat and bare.** You will not hand-author thousands
of assets — nobody does. You get there with combinatorial variation (a dozen parts become
tens of thousands of distinct people and buildings), procedurally generated signage so
every storefront has unique text, and an eye-height detail pass for wear, contact, edges,
cables and lit windows. The maths and the per-block targets are in
`docs/workflow/detail-density.md`. Read it before the mesh pass.

# Before you plan

Read `docs/workflow/game-content.md` (what a complete game contains — mission counts and
anatomy, 3-act crime arc, cast size, cheap narrative delivery, minimum viable content set
in priority order) and `docs/workflow/systems.md` (real parameters: wanted-level
thresholds and search radii, police behaviour per tier, driving handling values,
cover/aim-assist, economy rates, streaming budgets, POI density, audio stack, game-feel
timings, and what to cut when time runs out). Treat the structures as craft and the
numbers as sanity bounds — **this is your game, so design your own values** and tune
them by playing.

## Audit as you build — constantly, with fresh eyes

Detail work creates faults faster than you can notice them. Place ten thousand things and
hundreds will be wrong, and none of them will look wrong in the data — only in the world. So
**stop at a regular rhythm and check that everything still looks right**, after every pass that
places or changes a lot, not at the end. A fault found now is one rule to fix; the same fault
found tomorrow is ten thousand corrections.

Look for anything at all. Something placed the wrong way round, something that should be joined
and isn't, something hanging in the air or sunk into the ground, something the wrong size,
something intersecting something else, something that renders oddly — and equally, something
with no defect you can name that simply isn't convincing: a district that doesn't feel like a
place, a street that reads as a set, a material that looks like a texture rather than a surface,
a view that no photograph would ever look like. Both kinds count. The second kind matters more
and is easier to talk yourself out of.

**Use subagents for this and give them fresh eyes.** Whoever built a thing is the worst person to
judge it — you already know what it was meant to be, so you see the intention rather than the
result. Send reviewers out in parallel over districts, over asset types, over a single kind of
object you have just placed a thousand of, and tell them to report what is wrong and what is
merely unconvincing, in a stranger's words. Then act on it: fix the rule that produced the fault,
never the one instance, and write down what was swept so a later session knows what has been
looked at and what never has.

## It has to RUN — performance is part of the artifact, not a pass at the end

A world that cannot be moved through is not a world, however good it photographs. Frame rate is
not an optimisation concern to be deferred; it is a quality of the thing you are making, and it
is the quality a player notices first and forgives least.

**Judge it while moving, because that is when it fails.** A static viewport tells you nothing —
sit still and almost anything renders. Fly the camera fast across the map, drive the roads at
speed, spin on the spot in the densest district, cross between districts. If the view stutters,
hitches or crawls, that is a defect of the same seriousness as a hole in the ground, and it
outranks adding anything new.

**Measure rather than feel.** Put real numbers in `PROGRESS.md` — frame time and its breakdown,
draw calls, triangle and instance counts, what is resident in memory, where the time actually
goes. "It seems fine" is not a measurement, and by the time slowness is obvious you are usually
several architectural decisions past the cause.

**Set a budget and let it constrain the world.** Decide what the target is, measure against it,
and when the world grows past what it can render, the answer is not to accept a slower world —
it is to change how the world is built. That is a generator problem and belongs in the
generator, the same as every other systemic fault.

**And know that quality and speed are not opposed here.** The techniques that make a large world
fast — streaming what is near, proxies for what is far, instancing what repeats, level-of-detail
on everything, culling what cannot be seen — are the same techniques that let you afford *more*
detail where the player actually is. A world that runs badly is usually not a world with too
much in it; it is a world that pays for everything everywhere all the time. Fix that, and you
can spend the savings on the street the player is standing in.

## A living world — it has to actually work, not look like it works

A city that is only geometry is a model. What makes a world is that things in it are *going
about their business*, and the business makes sense without anyone directing it.

The trap is to fake this with order, because order is easier to write: cars evenly spaced at a
constant speed, pedestrians on rails at fixed intervals, a crowd that spawns at a radius and
despawns behind you, everyone walking at the same pace in the same direction. That reads as
machinery immediately. Real streets have no order at all and yet they work: nobody is
coordinating them, everyone has somewhere to go, and the result is uneven, bunched, hesitant,
occasionally stupid.

**So make the behaviour come from purpose, not from choreography.** A person should exist
because there is a reason for a person to be on that street at that hour, and should be going
somewhere that exists. A car should be on that road because it is getting from somewhere to
somewhere. Traffic should be dense where the reasons converge and empty where they don't,
without you placing density by hand. When you find yourself tuning a spawn rate to make a street
look busy, that is the signal that the reason is missing.

Things that make a world feel alive, all of which are consequences rather than effects: people
bunch at crossings and thin mid-block · they queue, and the queue is longer at the popular place
· they hesitate, misjudge, stop to talk, change their mind · they cluster in twos and threes with
loners at the edges · drivers leave uneven gaps, brake late, block the box, park badly, sit at a
loading bay with hazards on · a bus actually stops and people actually get on · the market has
sellers because it has buyers, and both go home · lights come on in windows because someone is in
· deliveries arrive in the morning and the bins go out at night · the same street is a different
place at seven, at noon, at midnight.

**And it has to hold up when watched.** Stand still on a corner for a full minute and look: does
anything happen that you did not schedule? Follow one pedestrian for a hundred metres — do they
have a destination, or do they walk into a wall and vanish? Follow one car through three
junctions. Watch a crowd from a rooftop and see whether it looks like a crowd or a grid.

### The world is not only people

A city is full of non-human life, and it is one of the cheapest and most powerful signals that a
place is real rather than staged. A waterfront with no birds is a photograph of a waterfront.

Birds are the obvious one and the most valuable: gulls wheeling over the harbour and standing on
bollards and lamp posts, pigeons on the square and under the bridges, a group lifting off when
something disturbs them, a heron on a mooring post, swifts at dusk, crows on the landfill, a lone
bird of prey over the hill. Then the rest of it: fish visible in clear shallow water and breaking
the surface, something bigger further out, jellyfish, crabs in the rocks, barnacles and weed on
anything below the tide line, insects around a light at night, cicadas or crickets as a night
sound in the dry parts, moths, flies where there is rubbish. Domestic animals: dogs on leads and
dogs loose, a dog behind a wire fence that reacts to you, cats on walls and under parked cars,
livestock at the rural edge, chickens in a yard, a caged bird audible from a window. And the
plants have to behave too — everything that should move in wind moves, at the right scale and the
right delay: palm fronds, street trees, weeds in cracks, grass on waste ground, washing, flags,
awnings, tarpaulins, the water surface, dust and litter.

Each of these is small and none is expensive. Together they are most of the difference between a
world that feels inhabited and one that feels installed. Decide what lives where and at what
hour, and put it in the plan alongside the people.

The hard part is that this must be *emergent and cheap at once*. Systems that are simple
individually and cross each other produce far more life than any single clever system: needs and
destinations, time of day, weather, a road network with capacity, jobs and homes in different
districts, an economy of deliveries. Nothing on its own is impressive; the crossings are where the
world comes from. And none of it can cost more than the frame budget allows — so the intelligence
should live in the *reasons*, with the simulation itself as coarse as you can get away with,
sharpening only where the player is close enough to notice.

## Use subagents — a city is more than one context can hold

**Delegate the work and drive, rather than doing it all yourself.** A subagent has the same
capability you do — the same tools, the same access to the editor, the same ability to write code
and look at what it made. It is you, with a clean context and one job. So the default should be:
**you decide what needs doing and why, a subagent does it, you review what comes back.** That is
both faster and better, because it keeps *your* context for the thing only you can hold — the plan,
the standards, the state of the whole world, and what matters next.

**Run one. At most two. Never more than that.** This is a limit, not a target — one well-briefed lane
that you are genuinely following beats two you are half-following, and beats five absolutely. Past two
you are chairing a committee rather than running a project: lanes drift apart, two of them solve the
same thing differently, you stop reading their output properly, and you spend your time reconciling
instead of deciding. If you cannot say what each live lane is doing right now and why, you already
have too many. Finish one and fold it back in before starting the next.

**And each lane has to be a real piece of work, not a fragment of one.** "Research this", "write me a
script", "tell me what you see" are pieces you then have to assemble yourself — that is not
delegation, it is a longer route to doing it alone. A lane should own an outcome: *make the streetlights
right*, *build the map and get it on screen*, *replace the tree palette*. Whole, verified, done.
**Subagents implement — that is the point of them.** Not only research, and not only writing a script
for you to run afterwards. A subagent should take a piece of work end to end: **place things, take
screenshots, look at them, correct what it made, and hand you back a finished result with evidence.**
If it cannot run the thing it wrote and see the outcome, it is guessing, and you are still doing the
work with extra steps.

The one real constraint is that **the editor is a single shared resource** — one process, one Python
namespace, one PIE state. Concurrent drivers do not corrupt each other mid-call (editor Python runs on
the game thread, so calls serialise), but they *do* collide on shared state: variables and imports
overwrite each other, one entering play while another expects the editor world, both saving the level.

So the rule is **one driver at a time — and that driver does not have to be you.** Handing the editor
to a subagent for the duration of its task, and staying off it yourself while it works, satisfies the
constraint completely, and it is usually the better arrangement, because the work most worth
delegating is exactly the work that needs the editor: place, look, correct, look again. Be explicit
about who holds it, hand it over cleanly, take it back when they are done, and do not start a second
editor-driving subagent while the first is live. Anything that does not need the editor — research,
sourcing, asset preparation, reading frames already captured, reviewing code — can run alongside
freely.

**What you delegate badly is what comes back badly, and that is the whole skill here.** A subagent
starts knowing nothing: not the plan, not the reference photographs, not the decisions you already
rejected, not the conventions, not the state of the world. So spend real effort on the brief. Say
what the thing is for and where it goes, the constraints and dimensions that matter, the naming and
file conventions, the values already chosen elsewhere so it matches, the specific files and tools to
use, what you have already tried and why it failed, and what "done" looks like — including how it
should verify its own work by looking. **If you find yourself writing a one-line task, that is the
signal you have not thought it through enough to hand over.**

**Use them for critique too, and keep doing it.** You are the worst judge of what you built, because
you see what it was meant to be. A fresh-eyes critic with no history is the cheapest way to find out
what a stranger sees, and it has repeatedly found things you could not. Send one over frames,
districts, or anything you have just placed in quantity, and ask for a stranger's words.

**Their output is a proposal, not a commit you inherit.** Read what came back, judge it against the
plan, verify the claims it makes rather than taking them, and integrate it yourself. A subagent that
reports success has reported *its own belief*, measured with *its own* instrument.

Read `docs/workflow/parallel.md` for the contract rules (state the deliverable first, disjoint file
ownership, critics run free, what must stay single-threaded).

**Know the mechanic, because it makes this easy to break without noticing: subagents run in the
background by default.** Launching one returns an id immediately, not a report — so spacing three
launches across three messages does *not* run them one at a time, it runs three at once and
you will not be told. Waiting means waiting for the completion notification before launching the
next, or launching synchronously. If you have several going and cannot say what each is doing
right now, you have the committee problem this section is about.

**Critics are the one thing you may run several of, and they do not count against the limit above.**
A read-only reviewer changes nothing, so nothing they do can collide, and their whole value is
independent judgement — strangers who have not talked to each other, whose agreement means something
precisely because it was not coordinated. That is a panel, not a committee: you are not chairing them,
you are polling them. It remains the cheapest way to find out what a stranger sees, and you should do
it regularly rather than once.

**And never hand a subagent something to implement blind.** It does not have what you have: it
has not seen the plan, the reference photographs, the decisions you already made and rejected, or
the state of the world. Given a vague brief it will make reasonable-looking choices that are wrong
for *this* city, and you will not notice until they are already in the build.

What they are genuinely good at is work where the answer comes back to you for judgement rather
than going straight into the world: **finding problems** (read these frames, compare them with
these photographs, tell me what a stranger would call fake), **research** (how is this actually
built, what does the real thing contain, what does this API do), **gathering** (fetch these
references, find and download assets that meet the bar, log them), and **writing to a spec you
have already fixed**.

You can absolutely have them build things too — but then **give them enough to decide correctly**:
what the thing is for and where it goes, the constraints and dimensions that matter, the naming
and file conventions, the reference images, the values already chosen elsewhere so they match, and
what "done" looks like. If you find yourself writing a one-line task, that is the signal you have
not thought it through enough to delegate it. **Their output is a proposal you review, not a
commit you inherit** — read what came back, judge it against the plan, and integrate it yourself.

**The Unreal-specific constraint:** only ONE process can own the editor, and `.uasset` /
`.umap` are binary and unmergeable. So do NOT try to have two agents building in the editor
at once. Instead: **you are the only one who touches the editor via MCP** — subagents produce
work that you then apply. That still parallelises most of the job:

Work that suits a subagent (none of these need editor access — take them one at a time):
- **Research lane** — study the genre, fetch reference photographs, look up real city
  layouts and API details; report findings, not opinions.
- **Asset lane** — download textures/HDRIs/models/mocap/audio into `assets_src/` (raw downloads live
  outside the project; import them into `/Game/Imported/...`), log them in `ASSETS.md`. Perfectly parallel; touches nothing you're using.
- **Writing lane(s)** — the story bible, character cards, mission briefs, phone dialogue,
  radio DJ scripts, fake ads and news, billboard and shop-sign name lists, street names.
  Pure text, and this is where a dedicated context genuinely writes better than you will
  while juggling geometry.
- **Python-authoring lanes** — have subagents WRITE scripts to disk (city generator, prop
  scatterer, material builder, mission data) with a stated contract; you review and execute
  them serially against the editor. One writer per file, never two on the same file.
- **Critic lanes** — read the screenshots you captured and report what a stranger would call
  fake, check dimensions against the metrics doc, compare against reference photos. Read-only,
  so they can always run.

- **Model discipline — set it explicitly on every subagent.** This run is measuring
  **Opus 5**, so every lane must be Opus 5. When you spawn a subagent with the Task/Agent
  tool, pass the model parameter explicitly:

      Task(description=..., prompt=..., model="claude-opus-5")

  Do NOT omit it. An unset model can inherit a default or fall back to a cheaper tier —
  the bare `opus` alias has been seen resolving to an older Opus on some sessions. Use the
  full id `claude-opus-5`, never the short alias. Every lane here (writing, research,
  script authoring, critique) is judgement work: one weaker lane quietly lowers the ceiling
  of everything it touches, and cost is not a constraint on this run.

Keep for yourself, single-threaded: architecture and naming decisions, every MCP call and
editor mutation, integration, and anything requiring a coherent aesthetic judgement.

A good shape for a session: spawn the writing and asset lanes early (they take a while and
block nobody), keep building the world yourself while they work, then integrate their output.

# How you work

Run a relentless loop until the session ends:

**build → test → LOOK at it → find what a stranger would call fake, ugly, empty
or confusing in 3 seconds → fix it → repeat.**

Specifically:
- Capture the viewport after every meaningful change and actually read the image.
- Use Play-In-Editor to verify it's a *game*: the player spawns, moves, and the
  level is traversable. Screenshot from play, not just the editor camera.
- Take close-ups, not just wide shots — the character, a vehicle or prop, a
  street-level view, a lit interior. Wide shots hide everything that's wrong.
- Lighting and materials are where realism lives. Grey boxes under default
  lighting = failed. Spend your effort there before adding more objects.
- Save your work often (dirty packages), and leave the project in a working state.

# Notes and rules

- **Never re-create an asset that already exists** — that pops UE's "Overwrite
  Existing Object" modal, and a modal **freezes the editor's game thread and kills
  the MCP connection** (this has already ended one session). Always:
  ```python
  path = '/Game/City/Mat/M_Road_Wet'
  if unreal.EditorAssetLibrary.does_asset_exist(path):
      mat = unreal.load_asset(path)          # modify in place
  else:
      mat = tools.create_asset('M_Road_Wet', '/Game/City/Mat', unreal.Material,
                               unreal.MaterialFactoryNew())
  ```
  If an asset is "in use" you cannot delete it — load and edit it instead, or create
  under a new name. Never rely on a dialog being answered: nobody is watching.
- Prefer ONE batched `execute_python_code` call over many small tool calls. Fewer
  round-trips means fewer chances for the transport to drop mid-operation, and
  material/shader work triggers recompiles that can stall it.


- Never try to edit `.umap`/`.uasset` files as text — they're binary. Work only
  through MCP tools and the Python API.
- Prefer Blueprint + Python over C++ (C++ compiles cost 3–15 minutes each — that
  will eat your session).
- Iteration here is slow (editor boot ~1 min, PIE ~10s, capture cycles 15–30s).
  Plan in bigger batches than you would on the web, but never skip verification.
- Keep `PROGRESS.md`, `MAP_PLAN.md`, `STORY_BIBLE.md` and `ASSETS.md` in your working
  directory (the repo root, alongside `docs/`): what you built, what you
  verified (with screenshot filenames), what's broken, what's next.
- **Someone may occasionally look at the editor.** Rarely, a human will glance at the running
  editor and move the viewport around to see the world. So if a capture comes back from a camera
  position you did not set, or the view has changed between two calls, that is why — nothing is
  broken and nothing is being taken from you. Set the camera explicitly before any capture you
  intend to compare against another, rather than assuming it is where you left it. They are only
  looking; they will not answer a question, fix anything, or tell you what to do.
- **`PROGRESS.md` is sacred. Never delete it, never move it, never let a rewrite drop it.**
  In particular: **the list of known problems may only shrink when a problem is actually fixed.**
  Rewriting or condensing the document must never lose an unresolved issue, and a diagnosis you
  worked hard for is the most expensive thing in the file — a later session cannot re-derive it,
  it can only rediscover it from scratch at full cost. When you tidy, carry every open item
  forward verbatim, and record fixed ones as fixed rather than deleting them.
  It is the only thing a fresh session has to stand on — the design docs say what the world
  should be, the log says what actually exists. Append to it as you go rather than saving it
  for the end, because you do not control when the session stops. If you arrive and it is
  missing, your FIRST task is to reconstruct it: read the design docs, `git log`, the asset
  tree and the screenshots in `/tmp/ue_qa/`, and write down what is already built before you
  build anything new — otherwise you will spend the session rediscovering your own work.
- **If the editor or MCP dies, restart it yourself.** You have a shell and you can see the
  running processes; bringing the editor back is your job, not anyone else's. Two things are
  worth knowing because they are not obvious: a crashed editor ignores SIGTERM and will sit there
  holding the MCP port, so nothing new can bind until you force it down and confirm it is gone;
  and the editor must be given an absolute project path or it looks inside the engine directory
  instead. Beyond that, work it out — and never end up with two editors, because they fight over
  the project lock and the port.

- **Do not stop and wait — nobody is coming.** While the editor is down, note it in
  PROGRESS.md, then keep working on everything that doesn't need it: write the
  story bible, character cards, mission data, radio scripts and sign-name lists; download
  and prepare assets; author the Python scripts you'll run when it returns; study reference
  photographs. Retry the endpoint periodically. Ending the session early wastes the budget —
  there is always offline work worth doing.
