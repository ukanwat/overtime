# Real-world map data — build the ACTUAL city

The cheapest path to urban truth: don't invent a grid, use the real one.

## Streets, buildings, heights (OpenStreetMap / Overpass — verified live)
```
curl -G 'https://overpass-api.de/api/interpreter' --data-urlencode \
 'data=[out:json][timeout:60];(way["building"](25.76,-80.20,25.79,-80.17););out geom;'
```
- Roads: `way["highway"~"motorway|primary|secondary|tertiary|residential"]`
- Land use: `way["landuse"]`
- Downtown has `building:levels`/`height` tags → extrude for a real skyline.
- Keep bboxes to a few km². Mirror: `overpass.kumi.systems/api/interpreter`.
- Bulk: `https://download.geofabrik.de/` (.osm.pbf)
- Water/coastline: `https://osmdata.openstreetmap.de/download/simplified-water-polygons-split-3857.zip`
- Credit "© OpenStreetMap contributors" in-game. That's the whole cost.

## Aerial imagery (public domain) — real ground textures with real road markings
- NAIP via Microsoft Planetary Computer's **anonymous** token:
  `curl https://planetarycomputer.microsoft.com/api/sas/v1/token/naip`, then STAC search
  (`.../api/stac/v1/search`, collection `naip`, your bbox) → COG GeoTIFF URLs.
- 3–6 inch county/state orthos via login-free ArcGIS REST `exportImage` endpoints
  (county open-data hubs, state DEP image servers).

## Elevation / massing
- USGS 3DEP lidar, anonymous S3 bucket `usgs-lidar-public` (Entwine format) — real terrain
  and real building massing to correct OSM height guesses.
- Terrain tiles, no auth: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`

## Street-level reference
Mapillary needs a token (skip). KartaView is anonymous:
`https://api.openstreetcam.org/2.0/photo/?lat=<lat>&lng=<lng>&radius=500` — CC-BY-SA,
good for reference/grunge, mind share-alike.
