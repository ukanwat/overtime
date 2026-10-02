# Login-free sources that work for UE

## Textures and HDRIs
- **Poly Haven** (CC0) — API needs a unique `User-Agent` header, no key:
  `https://api.polyhaven.com/assets?type=hdris|textures|models`, exact URLs from
  `https://api.polyhaven.com/files/<id>`. HDRI pattern:
  `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/<res>/<id>_<res>.hdr` (1k–24k).
  Models come as glb/fbx/blend/usd — prefer **glb** (self-contained).
  **Use `nor_dx` normal maps for UE**, not `nor_gl`. Their packed `arm` map is
  AO/Rough/Metal in RGB, which matches UE's ORM order — import as a Mask texture.
- **ambientCG** (CC0, ~3000 sets) — `https://ambientcg.com/get?file=<ID>_<RES>-PNG.zip`;
  search `https://ambientcg.com/api/v2/full_json?include=downloadData&category=Asphalt`.
  Ships separate maps (Color/NormalGL/Roughness/AO/Displacement) — plug in separately
  or pack ORM yourself.

## Real human motion (no login)
- **CMU mocap**, all 2,548 motions as BVH: `http://codewelt.com/cmumocap`
- **"Huge FBX Mocap Library"** on archive.org — pre-converted **FBX**, bone naming
  closer to UE conventions, direct download. Usually the faster route than BVH.
- UE 5.8 has **no native BVH importer**. Either use the FBX library above, or
  convert: `blender --background --python bvh_to_fbx.py` → import FBX → retarget
  with the IK Retargeter Python API (see [importing.md](importing.md)).
- Pipeline that fully works: mocap FBX → import onto `SK_Mannequin` → retarget onto
  your character's rig → AnimBP.

## Models
- Khronos glTF samples:
  `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/<Name>/glTF-Binary/<Name>.glb`
  (pipeline validation, not city content)
- Smithsonian Open Access (CC0) — 2,500+ museum scans, OBJ/glTF; props and
  monuments, not architecture.
- MakeHuman / MPFB (Blender addon) — generate a human, export FBX with UE-compatible
  bone names, import, retarget from the Mannequin.

## Real city geometry
- **OSM** via Overpass (no auth):
  `curl "https://overpass-api.de/api/map?bbox=<w>,<s>,<e>,<n>" > city.osm`
  or bulk extracts from `https://download.geofabrik.de/`.
- **StreetMap plugin** (`github.com/ue4plugins/StreetMap`, UE5 forks exist) turns an
  `.osm` drop into road splines + building footprint meshes. Import is drag-and-drop
  (not scriptable) — do it once, save the asset, then drive it headlessly.
- Or parse the OSM yourself in Python and spawn spline actors / extruded meshes via
  `EditorLevelLibrary` — fully scriptable, more work.
- CityGML (LOD1/LOD2 city models from many municipal open-data portals) via a free
  import plugin is another route to real massing.
- Credit "© OpenStreetMap contributors" if you use OSM data.

## The order that wastes least time
1. Download (pure Python: Poly Haven, ambientCG, mocap, OSM) — no engine needed.
2. Convert (Blender for BVH→FBX; `ffmpeg -acodec pcm_s16le` for audio; pack ORM).
3. Import in ONE full-editor Python run (`-ExecutePythonScript`), then save all
   dirty packages and quit.
