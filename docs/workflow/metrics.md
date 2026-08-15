# Real-world metrics — lock these before building

three.js convention: **1 unit = 1 metre**. (UE uses 1 unit = 1 cm; if you read UE
docs, divide by 100.) Wrong scale is the #1 reason a city "feels off" even when
every asset is good.

## Character
| | value |
|---|---|
| height | 1.8 m |
| eye/camera height | 1.5–1.6 m (deliberately below anatomical eye level) |
| collision radius | 0.3 m (0.6 m wide) |
| crouch height | 0.9–1.0 m |
| walk speed | 3 m/s |
| run/sprint | 6 m/s |
| jump height | 1.0–1.5 m |

## Architecture
| | value |
|---|---|
| floor-to-floor | 3.0–4.0 m |
| wall thickness | 0.2 m |
| door | 1.1–1.4 m wide × 2.1–2.3 m tall |
| stair step | 0.15 m rise / 0.30 m run |
| corridor (min / comfortable) | 1.5 m / 2.0–2.4 m |
| grid sizes | 2 m fine · 4 m standard · 8 m coarse |

## Street and city
| | value |
|---|---|
| traffic lane | 3.5–3.75 m |
| two-lane road | 7.0–7.5 m |
| sidewalk (min / comfortable) | 1.5–1.8 m / 2.5–3.0 m |
| alley (navigable) | 2.0–2.5 m |
| city block | ~80–130 m per side |
| building setback | 0–2 m in dense urban |

## Cover (must be visually unambiguous)
low 0.6–0.8 m (hides crouched) · medium 1.0–1.2 m · high 1.5–1.8 m (hides
standing) · vaultable 0.9–1.1 m.

## Camera
third-person action: 60–75° FOV, +5–10° kick at sprint/high speed · chase cam
~8 m back, ~4 m up, look-ahead ~4 m in front of the vehicle · damp with
`1 - exp(-k*dt)` (k≈4), never a raw per-frame lerp.

## Engagement / sight distances
close ≤ 3 m · medium ≤ 10 m · long ≈ 20–25 m · landmarks should stay readable at
200–500 m to anchor orientation — give them unique silhouettes.

## Vehicles (arcade feel)
top speed ~50 m/s · accel 12–18 m/s² · braking ~25 m/s² · wheelbase 2.7 m ·
steering lock 35° at rest shrinking to ~8° at top speed · body roll ≤ 5–7°,
pitch 3–5° under accel/brake.

Put these in a `config.js` and reference them everywhere. Never hardcode a
dimension twice.
