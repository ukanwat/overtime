# What a complete game contains

Scope calibration, not a spec to copy. "A game" is not a level — it's a content set,
and these are the sizes shipped games chose. **The story, the city, the cast, the
missions and the systems are yours to invent** — what's useful here is the shape and
the order of magnitude, so you neither ship one street nor plan 200 missions you can't
finish.

## Story mission counts, shipped
GTA III ~50 · Vice City ~58 · San Andreas 101 (86 mandatory) · GTA IV 88 ·
GTA V 74 in a playthrough (83 across branches) · Mafia DE 20 chapters ·
Sleeping Dogs ~30 · Yakuza LAD 15 chapters + 52 substories · RDR2 105.

**Target 12–15 missions minimum for a complete arc; 40–60 is "a full game."**
Each mission 8–20 minutes. Hard ceiling ~25 min — beyond that players won't retry.

## Mission anatomy (from a 2,191-mission study)
Missions decompose into action blocks: traversal · social · combat · stealth ·
puzzle/investigation · environmental interaction · special ability · ranged ·
collection. Main quests average **15.7 blocks**, side quests **11.7**, POIs **8.8**.

A 12-minute mission that works:
0–2 min briefing (social) → 2–5 drive there (traversal, banter plays here — free
narrative) → 5–8 approach (stealth/combat) → 8–11 the conflict (peak) →
11–12 escape + hook for next.

Alternate intensity: drive = valley, fight = peak, escape = second peak, debrief =
release. Never repeat the same verb chain twice in a row.

## Mission types, cheapest first
chase · delivery · race · ambush · territory-hold (all reuse existing systems) →
assassination · infiltration · escort · investigation (medium) → **heist** (expensive,
and the genre's set piece: identify → recon → 2–4 prep missions → execution with
branching approach → hot escape).

## Technical authoring (the GTA SCM pattern)
- One script per mission, launched by the world script; `MISSION_START` → setup →
  phase loop → cleanup → `MISSION_END`.
- **Single `mission_phase` integer switched each frame** — never deep nested conditionals.
- Globals for story flags/money/wanted; locals for timers/handles.
- **Reference named entities, not coordinates** (`npc_FIXER_01`, `trigger_WAREHOUSE`) so
  art and mission logic can change independently. Store spawns as data, not code.
- Checkpoint at every phase transition (every 3–5 min). Never immediately before a
  cutscene. On fail: restore checkpoint, keep player health/ammo, offer instant retry —
  friction after failure is what makes players quit.
- Only death is a mandatory fail state; most other failures should escalate the
  situation, not restart it.

## Story structure that works
(A pattern, not a plot. Your characters, city, factions and ending are yours to write —
this is just the load-bearing shape crime stories tend to have.)
- **Act 1 (~25%)**: broke protagonist, 3–4 small-time employers, ends in BETRAYAL #1
  (loses money/safehouse/ally).
- **Act 2 (~50%)**: new district, bigger employers, mid-act loyalty choice, ends in
  BETRAYAL #2 (the mentor turns; protagonist alone).
- **Act 3 (~25%)**: revenge/reckoning, 2–3 prep missions, then the finale.
- Give the protagonist **one person they care about who is at risk** — every escalation
  threatens them. That's what makes act 3 personal instead of transactional.
- Endings that land: escape-with-cost, or pyrrhic victory. Never "everyone wins."
- One unifying goal. GTA V's lesson: three disconnected protagonist arcs read as five
  storylines with no causal link.

## Narrative delivery, cheap to expensive
Radio (17 stations/400+ songs in GTA V) · phone-call briefings (~30% of GTA V missions) ·
text messages · NPC barks (50–100 lines per archetype) · environmental props/graffiti/
news · loading-screen fake ads — all near-free.
Reserve full cutscenes for: first meeting a character, betrayals, deaths, the finale.
**Deliver briefings by phone while the player drives** — narrative in dead travel time.

## Cast
10–15 named speaking characters is a complete crime game (GTA III shipped ~15).
Composition: protagonist · 3–4 employers (one betrays in act 1) · antagonist · mentor
(dies/turns at act 2) · confidant at risk · 2–3 associates · 1 cop adversary.
NPCs: 6–12 archetype buckets, individualised by silhouette + 2–3 verbal tics + one
dominant trait. Animations: ambient ped 12–15 clips; combat NPC 30–50; named character
+15–25 gesture/idle clips on top.

## Minimum viable content set (priority order)
1. 12–15 missions forming a complete 3-act arc
2. **Wanted system** — the genre identity marker; without it the world is a corridor
3. Ambient crowd with flee/witness reactions (3 archetypes + day/night)
4. **Radio** — one station with a DJ commenting on the city; highest narrative ROI
5. One complete heist (setup → execution → escape)
6. 3 distinct districts · 7. 10–15 random ambient events · 8. Phone system ·
9. Property income · 10. Vehicle variety (3 car classes + bike + boat/heli)
Then: substories, one progression system, one minigame, environmental storytelling,
story-gated district unlocks.

## What players notice first (and complain about)
Alive city > core verb feel > something to do in eyesight > NPCs reacting > protagonist
having a reason. Complaints, in order: feature creep over depth · empty geography
between activities · repetitive mission structure after ~10h · world that doesn't react
to story progress · losing 15 minutes to a missing checkpoint · no reason to revisit
completed districts.
