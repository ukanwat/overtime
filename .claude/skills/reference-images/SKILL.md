---
name: reference-images
description: Find and actually LOOK at real photographs — keyless image-search APIs, downloaded to disk so they render as images. Use before building any place, material, vehicle, sky or lighting condition, and again when judging your own screenshots.
---

# Looking at real photographs

`WebSearch` returns text and `WebFetch` returns markdown — **neither gives you an
image**. To see a photo you must download it and Read the file:

```bash
mkdir -p ref/strand
# 1. SEARCH — Openverse: CC-licensed, no API key. KEEP QUERIES TO 2–3 WORDS.
#    Every term is ANDed, so "miami south beach art deco dusk" returns ZERO results.
curl -s -A "agent/1.0" \
  "https://api.openverse.org/v1/images/?q=art+deco+hotel&page_size=8" \
  | python3 -c "import json,sys; [print(r['url']) for r in json.load(sys.stdin)['results']]"

# 2. DOWNLOAD
curl -sL -A "agent/1.0" -o ref/strand/deco1.jpg "<url from above>"

# 3. LOOK at it — Read the local file; images render for you.
```

Then read your own screenshot of the same subject and **name the gap out loud**: "real
facades have setbacks, AC units and stained concrete; mine are flat", "the real kerb has a
ramp, a drain and a meter every third car; mine is a clean extrusion", "real asphalt is
bluer, patched, and the lane paint is worn through in the wheel tracks", "the real light is
warmer and lower and the shadows are longer". A named gap is a work item; "make it better"
is not.

## Sources that need no key (all verified working)

- **Openverse** — keyword photo search, direct image URLs. The everyday default.
  `https://api.openverse.org/v1/images/?q=<2-3+words>&page_size=10`
  Trap: multi-word queries are ANDed. Two or three words, or you get nothing.
- **Wikimedia Commons search** — landmarks, aerials, named buildings.
  `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=<query>&gsrnamespace=6&gsrlimit=5&prop=imageinfo&iiprop=url&iiurlwidth=1600&format=json`
  Send a User-Agent. `gsrnamespace=6` is required. Do NOT add `filetype:bitmap` — it
  breaks the query and no `query` key comes back. Read `imageinfo[0].thumburl`.
- **Wikimedia geosearch** — every photo taken near a real coordinate. This is how you
  study a real *place* rather than a word.
  `https://commons.wikimedia.org/w/api.php?action=query&generator=geosearch&ggscoord=<lat>%7C<lon>&ggsradius=1000&ggslimit=10&ggsnamespace=6&prop=imageinfo&iiprop=url&iiurlwidth=1600&format=json`
- **KartaView** — street-level photography from a car windscreen, at any coordinate.
  `https://api.openstreetcam.org/2.0/photo/?lat=<lat>&lng=<lng>&radius=400`
  Read `result.data[].fileurlProc`. **The most valuable source you have**: it is your exact
  game camera — driver eye height, kerb to kerb, real parked-car spacing, real pole and
  cable spans, real sky. One of these tells you more about how a street reads than an hour
  of guessing.
- Aerial/satellite imagery of a real city: see the map-data source doc.

## Use it for far more than "the city"

Vehicle proportions, paint and glass tint, wheels, plates. Road markings and their wear.
Kerbs, drains, ramps. Traffic signals and how they're mounted. Street-lighting colour by
era. Overhead cables. Palm and street-tree shapes. Awnings and their frames. Shopfront
signage typography. Roof clutter, aerials, dishes, laundry, bins, pallets. Tide lines and
beach litter. Wet asphalt at night, neon reflections, dusk sky gradients. Crowd density and
how people actually cluster on a pavement.

**Anything you are about to guess at, fetch three photos instead.**

Keep what you download. A handful of images in `ref/<subject>/`, linked from the design
document that used them with a line on what you took from each — so a later session's
answer to "why is this district this colour" is a photograph, not a vibe.

The tell of a generic build is what memory leaves out: nothing is stained, nothing is
repaired, nothing sags, nothing is bolted on afterwards, nothing is worn where feet and
tyres go. Photographs are full of exactly that, and it is most of what makes an image read
as real.
