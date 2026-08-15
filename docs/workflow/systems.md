# Genre systems — structure to understand, numbers to argue with

**Read this the right way.** The *structures* below are craft: a wanted system has
escalation tiers, per-unit vision cones, and a decay timer that only runs while you're
unseen — that's how the mechanic works, and knowing it saves you rediscovering it.

The *numbers* are one shipped game's answers, not the answers. **This is your game —
design your own values.** Use these only as sanity bounds so you don't ship something
absurd (a 5-minute day cycle, a 90-minute mission, a 400-metre-wide street). If your
design reasons its way to different numbers, take yours; note the reasoning in
PROGRESS.md and tune by playing, which is what the values below came from anyway.

What you should NOT do is copy a shipped game's tuning table wholesale. It was tuned
for their vehicles, their map scale, their camera. Yours are different.


## Wanted / heat (GTA V dispatch.meta)
| Star | Crime points | Search radius | Evasion timer |
|---|---|---|---|
| ★ | 50 | 145 u | 30 s |
| ★★ | 180 | 227 u | 45 s |
| ★★★ | 550 | 340 u | 60 s |
| ★★★★ | 1200 | 510 u | 75 s |
| ★★★★★ | 3800 | 850 u | 82 s |

Triggers: ★ hit-and-run/weapon in public/car theft · ★★ resisting arrest, robbery ·
★★★ killing police · ★★★★ restricted area · ★★★★★ sustained escalation.
One workable architecture: crime-point accumulator → tier thresholds → dispatch spawner → per-unit
LoS cones (foot ~60°/30 m, car ~90°, heli ~120° elevated). **The evasion timer only
counts down while the player is unseen by every cone** — that's the whole cat-and-mouse.

Police per tier: 1–2 cars → +armour, PIT manoeuvres, helicopter → roadblocks with spike
strips on pre-tagged road nodes + sharpshooter heli → tactical SUVs, rappelling → full
saturation. Below ★★★, holstering and standing still should trigger arrest, not death.

## Driving (GTA V handling.meta, typical → sports)
mass 1300 → 1200 · driveForce 0.22–0.32 → 0.45–0.6 · steeringLock ~40° → ~50°
(>75° spins out) · tractionCurveMax 1.4–1.7 → 2.2–2.5 · tractionCurveMin 1.0–1.2 →
1.3 · driveBiasFront 0.0 (RWD, needed for drift) · brakeForce 0.7–0.95 ·
topSpeed 120–160 → 200–240 kph · centreOfMass Z −0.2 → −0.35 (lower = stable) ·
negative camberStiffness = oversteer.
Traffic: spawn on-screen ~80 m, off-screen ~120 m, draw ~200 m, ped cap 80–200,
~15–20 vehicles nearby at density 1.0. Keep a "recently near" cache so nothing pops in
when the camera turns. Damage: smoke at ~40% engine health, stall at ~10%.

## Combat
Cover generated procedurally from collision geometry (Mafia III): 1 m-wide positions,
protection direction as a 32-bit mask from half-metre raycasts, neighbour links for
lateral movement, auto-disable when a dynamic object blocks them.
Enemy AI states: unaware → curious → search → combat → flee/surrender, with a
recognition timer weighted by distance, angle, lighting, motion.
Aim assist (Insomniac): rotational friction 0.3–0.6 when the crosshair overlaps the
target capsule · assisted tracking adds target angular velocity · ADS snap within
10–15° of arc · optional bullet magnetism. Damage zones: head 1.5–2.5×, torso 1.0×,
limbs 0.5–0.7×; grunt 100–200 HP, armoured 300–500; limb hits cause a 0.15–0.3 s flinch.

## Economy
Sources: missions $5K–250K · ambient crime $200–2K repeatable · side activities
$500–50K · property income $1K–10K per in-game day · heists as the big beat.
Sinks: ammo/weapons $50–5K (frequent) · vehicle upgrades $10K–150K · safehouses
$30K–500K · cosmetics · hospital/arrest fees $500–5K.
Pace so the next tier of gear is affordable every 2–3 hours of play.

## World
Streaming: UE5 World Partition 128 m cells, loading range 2–4× cell (3–4× for
vehicles), ≤2 cells + ≤10 actors spawned per frame. Sunset Overdrive shipped 110 m hex
chunks, 7 loaded at once, 1.6 s per chunk load, ~2000 actors per chunk, actor init
time-sliced to 3 ms/frame — that time-slicing is the lesson.
POI spacing: 60–120 s of travel between meaningful points. Mix: 25% combat, 20%
exploration, 15% story vignette, 15% caches, 10% vistas, 10% NPC encounters, 5% hazards.
District differentiation axes: architecture palette · colour grading LUT · NPC archetype
mix · audio bed · vehicle fleet · default radio station.
Density by district: downtown 80–100% of ped cap in daytime, residential 30–50%,
industrial 10–20%, beach 60–80%. Time bands: 6–12 workers, 12–18 shoppers,
18–24 nightlife, 0–6 sparse + police.
Day length: shipped games cluster at 24–48 real minutes per 24 in-game hours. Pick what
suits your city; just don't make it so fast that dusk never lands.
Weather as a Markov chain re-evaluated every 30–60 in-game minutes; rain drives wet-road
shaders and lower traction.

## Audio
Bus tree: Master → Music / SFX (vehicles, weapons, characters, environment) / Dialogue /
Ambience (district beds, point sources, weather). Duck ambience −6 to −12 dB under
dialogue, −3 dB in combat; vehicle interiors occlude −8 to −15 dB.
Radio: a station is a linear broadcast — songs + DJ monologue + fake ads every 2–4 songs
+ news items tagged to game state + 2–4 s station stingers. One dev built 1h18m of
station content (13 songs, 16 ads, 4 DJ segments) for ~$800.
Engine audio: either 3–8 RPM loops crossfaded by an RPM parameter, or granular
resynthesis. Drive with RPM (pitch/blend), throttle (>0.7 adds crackle), load, gear
(neutral-drop click), speed (wind/tyre).
Footsteps: 4–6 surface types × 4–8 randomised samples. Reverb: plaza RT60 0.8–1.2 s,
street canyon 1.5–2.5 s, garage 3–5 s, highway 0.3–0.5 s.

## Game feel — ranked by impact per effort
(These timings are perceptual, not stylistic — human reaction limits, so they travel
between games better than tuning values do.)
1. **Hit stop**: freeze 2–6 frames (33–100 ms) on impact; explosions 8–12.
2. **Camera shake** (Perlin, not random): weak 2–3 px/0.1 s, strong 8–10 px/0.15–0.2 s,
   explosion 15–25 px/0.3–0.5 s; drop to 50% intensity after 10 consecutive shakes.
3. **Sound within 12 ms of the action** — beyond ~15 ms the brain decouples it. Randomise
   impact pitch ±15%; rise in pitch through a combo.
4. Input buffering 80–120 ms · 5. coyote time ~100 ms · 6. hit flash 50–100 ms ·
7. particles 20–30 per hit (>50 reads as noise) · 8. rumble 0.08–0.2 s within 12 ms ·
9. FOV kick +3–5° over 0.1–0.2 s · 10. blend times: turns 0.05–0.1 s, equip 0.15–0.25 s.
Feedback staging that reads as one event: 0 ms rumble+sound → 20 ms flash →
50 ms particles → 100 ms damage number.

## QA and triage
P0 blocker (crash, softlock, save corruption) — never ship. P1 critical (severe, has a
workaround) — deliberate risk. P2 major — ship documented. P3 cosmetic — ship.
Severity ≠ priority. Playable = critical path completable with workarounds; shippable =
P0 clear, every player-facing interaction either works or fails gracefully.
Automated bots (Ubisoft's approach) catch performance regressions, spawn failures,
collision holes, state deadlocks, leaks — never "feels bad", which needs a human.

## When time runs out, cut in this order
multiplayer → extra vehicle classes beyond 3–4 → mission-type variety beyond 3–5 →
radio stations beyond 2 → weather beyond 3 states. **Never cut**: movement, wanted
system, driving, combat. Those are the game.
