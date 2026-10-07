# Toronto parcel map

An unlisted map of Toronto's residential parcels for the TRREB missing-middle study: lot
dimensions, derived setbacks and buildable envelope for the 413,489 parcels in the R, RD, RS,
RT and RM zones, with building footprints over the top.

This visualises **model inputs, not capacity**. The study still needs built-form parameters
from the architect — building depth, unit-size bands, the garden-suite trigger — before a unit
count exists. Adding capacity later is another colour-by option, not a rebuild.

Lives at `malcolmkennedy.com/to-parcel-map/`. Not linked from the site index, excluded from the
sitemap and marked `noindex` — it is a working tool for the project team, not a public piece.

## Why vector tiles

There are ~413k parcel polygons and ~428k footprints. Writing the parcels to GeoJSON produces a
773 MB file that no browser will open. Tiled into PMTiles the same data is tens of megabytes,
and the browser fetches only the tiles on screen using HTTP range requests — which GitHub Pages
supports, so there is no tile server to run.

This needs WebGL, unlike [`to-multiplex-map`](../to-multiplex-map), which deliberately avoids
it. Nothing else draws this many polygons interactively. WebGL was verified on the target
machine before the map was built on this assumption.

## Layout

```
export/build_tiles.py   joins TRREB's model inputs onto parcel geometry, builds both
                        PMTiles archives and the field dictionary
site/                   MapLibre GL JS map, published to Pages by .github/workflows/deploy.yml
site/data/              the built tiles -- committed, since the data is a static snapshot
```

## Rebuilding the tiles

Requires the TRREB project checked out at `~/projects/TRREB` with its derived data present
(`data/derived/toronto_model_inputs.csv` and `data/derived/lots/toronto.gpkg`), plus
`brew install tippecanoe`.

```
python export/build_tiles.py            # ~10 min, writes site/data/*.pmtiles
git add site/data && git commit && git push   # the push deploys
```

Both archives must stay under GitHub's 100 MB per-file limit. If a rebuild pushes one over,
the levers in order are: raise the parcel minzoom from 11 to 12, drop `address` from the tiles
and look it up on click, then `--simplification`. If it still will not fit, move the tiles to
object storage and change only the PMTiles URL in `site/map.js`.

## Running locally

```
cd site && python -m http.server 8000
```

Then open `http://localhost:8000`. Without a `config.js` the basemap falls back to plain
OpenStreetMap raster tiles; CARTO's keyless endpoint now returns an "API KEY REQUIRED"
watermark, so CI writes `config.js` from the `CARTO_API_KEY` secret at deploy time.

## Data and licensing

Both layers are City of Toronto Open Data under the
[Open Government Licence – Toronto](https://open.toronto.ca/open-data-license/), so they can be
published with attribution:

- [Property Boundaries](https://open.toronto.ca/dataset/property-boundaries/)
- [3D Massing](https://open.toronto.ca/dataset/3d-massing/) (building footprints, 2025)

Setbacks are derived from Zoning By-law 569-2013 rather than published as data; see the TRREB
project's `METHOD.md` for how, and `COLUMNS.md` for what each field means.

**Toronto is the only municipality in the study whose parcels are openly licensed.** Every
other one is unlicensed working data. Do not add them to this map — see the TRREB project's
`SOURCES.md`.
