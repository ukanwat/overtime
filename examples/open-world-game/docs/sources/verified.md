# Verified sources — tested live, with the login walls named

Every entry below was checked by fetching it. Where a key or login is needed it says so, because
that is the difference between a source you can use and one you cannot.

## Keys in your environment

Check what you already have before assuming a source is closed to you:

```bash
env | grep -E "FREESOUND|SKETCHFAB|OPENTOPO|HF_TOKEN"
```

`FREESOUND_API_KEY` opens 700K sounds — search with
`freesound.org/apiv2/apply/search/text/?query=...&filter=license:"Creative Commons 0"&token=$FREESOUND_API_KEY`
and the `previews` field gives you fetchable HQ mp3s with the key alone (full-quality originals
need an OAuth step). `SKETCHFAB_API_TOKEN` opens programmatic CC0 model download via
`Authorization: Token $SKETCHFAB_API_TOKEN`. Keys may be added while you are working — check
again rather than assuming.

## Fab (via the launcher GUI) — the best photoreal source you have

The Epic Games Launcher is installed and signed in, and its **Fab** tab has a large free catalogue
of professional-grade content: Megascans scans, environment kits, props, vehicles, characters,
animation sets, materials. There is no public API for the library, so reach it through the GUI
with `tools/appui.py` (see `tech/capabilities.md`) — filter to free, add to library, install into the
project. Prefer this over hand-modelling or scraping when you need something to look real.

## 3D models

- **Objaverse / Objaverse-XL** — installed (`import objaverse`). No login. The LVIS subset (~46K
  items) is category-tagged, which is what makes it usable: `objaverse.load_lvis_annotations()`
  returns a dict keyed by category name ("car", "truck", "fire_hydrant", "bench", "trash_can"),
  and `objaverse.load_objects(uids)` pulls `.glb` files. Corpus is ODC-By; individual items carry
  their own licence, so check per item. Objaverse-XL reaches 10M+ objects.
- **Poly Haven** — no login: `api.polyhaven.com/assets?t=textures` returns **788 CC0 textures**,
  plus 521 models and 981 HDRIs. `api.polyhaven.com/files/{slug}` returns every channel
  (diffuse, normal GL/DX, roughness, AO, ARM, displacement) at 1K–8K in JPG/PNG/EXR.
- **ambientCG** — no login, CC0 PBR sets: `ambientcg.com/api/v2/full_json`.
- **Smithsonian Open Access** — 2,000+ public-domain scans, reachable without credentials via
  `aws s3 ls s3://smithsonian-open-access/media/3d/ --no-sign-request`.
- **ABO (Amazon Berkeley Objects)** — ~8,000 artist-made PBR household objects in glTF, open S3.
- **NASA 3D Resources** — 257 GLB files, enumerate through the GitHub tree API. Public domain.
- **Sketchfab** — search is open (`api.sketchfab.com/v3/models?license=cc0&downloadable=true`),
  but **download needs a free account token** (`sketchfab.com/settings#api`). Worth the one-time
  registration: it is the largest pool of downloadable CC0 models.
- Dead ends: ShapeNet (registration + non-commercial), Poly Pizza (key required, low-poly only),
  BlenderKit (addon only, no REST API), 3D-FUTURE / OmniObject3D (non-commercial).

## Humans and animation — the hardest gap

- **MPFB2** (MakeHuman for Blender) — no login, fully headless through
  `blender --background --python`. Parametric humans with auto-rigging; CC0 output. Good for
  background crowd, not for photoreal faces.
- **100STYLE** — no login, CC BY 4.0. 4M+ frames across **100 locomotion styles** (skulking,
  limping, dramatic…). BVH, so it needs retargeting to the UE mannequin.
- **CMU mocap** — no login, large and free.
- **Mixamo** — 2,000+ animations and an auto-rigger, free for commercial use once downloaded, but
  it needs **one Adobe login** to seed a session; after that community scripts run headless.
- **Rokoko free packs** — 263 professional clips, free account required.
- **Epic Game Animation Sample** — 500+ AAA animations with a working Motion Matching setup.
  Needs an Epic login once (see `docs/setup.md`). This is the highest-value animation source there is,
  and `PoseSearch` is enabled with nothing to search until it exists.
- Dead ends for a published artefact: AMASS, LAFAN1, SMPL/SMPL-X (registration and/or
  non-commercial). Ready Player Me's public APIs shut down in January 2026.

## Real-world data

- **Geofabrik** — no login, 555 daily-updated OSM `.pbf` regions; index at
  `download.geofabrik.de/index-v1.json`.
- **Overture Maps** — installed (`overturemaps download --bbox=W,S,E,N -f geojson --type=building`).
  No login, CDLA Permissive. **Carries building heights and floor counts**, which is exactly what
  raw OSM usually lacks.
- **Microsoft Global Building Footprints** — no login, 1.4 billion footprints with height
  estimates for US/EU; index CSV at `minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv`.
- **osmnx** — installed. Python queries for street graphs and building features.
- **USGS 3DEP point elevation** — no login, single points:
  `epqs.nationalmap.gov/v1/json?x=<lon>&y=<lat>&wkid=4326`.
- **OpenTopography** — free key, no card (`portal.opentopography.org`). Copernicus GLO-30,
  SRTMGL1 and USGS 3DEP GeoTIFFs; 50 calls/day on the free tier.
- **GSHHG coastlines** — no login, shapefiles at five resolutions.
- **Copernicus Dataspace (Sentinel-2)** — free registration, then headless. 10 m imagery.

## Sound

- **Sonniss GDC Game Audio bundles** — the best free professional library in existence: ten years
  of bundles, 200 GB+, royalty-free, no attribution. The official links sit behind Cloudflare and
  refuse headless curl, but the **archive.org mirror works**:
  `archive.org/details/sonniss.com-gdc-gameaudio-bundles` → download via
  `archive.org/download/{identifier}/{filename}`.
- **Freesound** — 700K sounds and the best coverage of city ambience, traffic, footfall, doors,
  machinery, crowd walla, sirens. Needs a **free API key** (`freesound.org/apiv2/apply`), then
  filter to CC0 with `filter=license:"Creative Commons 0"`.
- **OpenGameArt** — no login, CC0 filter available, direct downloads.
- **EchoThief** — no login. **115 impulse responses recorded in real spaces**, CC0. Feed these to
  MetaSounds convolution reverb and interiors, tunnels and stairwells stop sounding like presets.
- **Free Music Archive / ccMixter / Jamendo** — CC-BY music for radio stations.
  `api.jamendo.com/v3.0/tracks/` works with a public client id.
- **What you do not need to source:** MetaSounds synthesises oscillators, FM and subtractive
  synthesis, filter chains, audio-rate modulation, Doppler for passing vehicles, engine drone
  from an RPM parameter, wind, rain and electrical hum. Source the things synthesis cannot fake —
  gunshots, specific engine recordings, crowd walla, music.
- Not usable: BBC Sound Effects (RemArc licence is personal/educational only).

## Reference photography

- **Wikimedia Commons** search and **geosearch** (photos near a coordinate) — no login.
- **KartaView** — no login, street-level photography by coordinate: your exact game camera.
- **Openverse** — no login; keep queries to two or three words, terms are ANDed.

## Tools installed here

`blender` · `ffmpeg` · `sox` · `imagemagick` · `assimp` (FBX/OBJ/DAE → GLB, needed for Mixamo and
Rokoko output) · `gltf-transform` (Draco compression, LODs) · `objaverse` · `overturemaps` ·
`osmnx` · `shapely` · `trimesh` · `scipy` · `opencv` · `scikit-image` · `pyproj` ·
`mapbox_earcut` · `noise` · `pygltflib`
