"""Build the vector tiles the map reads, from the TRREB project's derived data.

Two PMTiles archives plus a small column dictionary:

  site/data/parcels.pmtiles     413k Toronto parcels in the R/RD/RS/RT/RM zones, carrying the
                                model inputs the map colours by and shows on click
  site/data/footprints.pmtiles  428k building footprints, geometry and height only
  site/data/columns.json        field labels and units, read straight from the TRREB column
                                dictionary so the two cannot drift

Why tiles at all: the parcels are ~492k polygons and the footprints ~428k. A GeoJSON of the
parcels alone comes out at 773 MB, which no browser will load. Tiled and served as PMTiles the
same data is tens of megabytes and the browser fetches only the tiles on screen, over HTTP
range requests.

Usage:  python export/build_tiles.py [--trreb DIR] [--out DIR]
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

import geopandas as gpd
import pandas as pd

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRREB = os.path.expanduser("~/projects/TRREB")

# Carried into the parcel tiles. Everything here is either coloured by or shown on click;
# anything else is dead weight in every tile the browser downloads.
PARCEL_FIELDS = [
    "parcel_id", "address", "zone",
    "frontage_m", "depth_m", "area_m2",
    "front_setback_m", "side_setback_m", "rear_setback_m",
    "buildable_width_m", "depth_available_m",
    "max_coverage_pct", "coverage_cap_m2",
    "corner_lot", "lane_access", "on_major_street",
    "attached",
    # capacity. build_path, new_build_viable and side_yards_counted are deliberately out:
    # they are hidden from the panel and the file is 1 MiB under GitHub's 100 MiB limit.
    # max_buildable_footprint_sqft (identical to ground_floor_sqft), total_gfa_sqft,
    # garden_suite_sqft and existing_footprint_sqft are all left out and rebuilt in the
    # browser: each numeric field costs about 4 MiB across six zoom levels, and the file
    # has to stay under GitHub's 100 MiB.
    "building_depth_m", "rear_remaining_m",
    "ground_floor_sqft",
    "garden_suite_storeys", "sixplex_eligible", "unit_type", "n_units",
]
# Every numeric field rides as an integer. A double costs 8 bytes in every tile a feature
# appears in, across six zoom levels and half a million parcels; a small varint costs one or
# two. TENTHS fields are multiplied by 10 first, so 18.6 m travels as 186 and the browser
# divides it back -- no precision is lost, because these were already rounded to 1dp.
# site/map.js has the matching TENTHS list; the two must stay in step.
TENTHS = ["frontage_m", "depth_m", "front_setback_m", "side_setback_m", "rear_setback_m",
          "buildable_width_m", "depth_available_m", "building_depth_m", "rear_remaining_m",
          "max_coverage_pct"]   # 42.5% is a real value on three parcels
WHOLE = ["area_m2", "coverage_cap_m2", "ground_floor_sqft",
         "garden_suite_storeys", "n_units"]
BOOLS = ["corner_lot", "lane_access", "on_major_street", "attached", "sixplex_eligible"]


def log(m):
    print(m, file=sys.stderr, flush=True)


def tippecanoe(src, out, layer, minzoom, maxzoom, extra=()):
    cmd = ["tippecanoe", "-o", out, "-l", layer, "-Z", str(minzoom), "-z", str(maxzoom),
           "--drop-densest-as-needed", "--extend-zooms-if-still-dropping",
           "--force", *extra, src]
    log("  " + " ".join(cmd[:9]) + " ...")
    subprocess.run(cmd, check=True)
    log(f"  -> {out}  {os.path.getsize(out) / 1e6:.0f} MB")


def as_int(col):
    """Round to a Python int, keeping nulls as None so they are written as JSON null and
    tippecanoe omits the attribute. Object dtype is deliberate: fiona will not serialise
    pandas' nullable Int64, and a float column would be written as 186.0 and read back as a
    double, which is the cost we are trying to avoid."""
    v = pd.to_numeric(col, errors="coerce").round()
    return [None if pd.isna(x) else int(x) for x in v]


def write_ndjson(gdf, path):
    """Newline-delimited GeoJSON: tippecanoe reads it streaming, so neither side holds the
    whole layer in memory."""
    gdf.to_file(path, driver="GeoJSONSeq")
    return path


def build_parcels(trreb, tmp, out_dir):
    log("parcels")
    attrs = pd.read_csv(os.path.join(trreb, "data/derived/toronto_model_inputs.csv"),
                        low_memory=False)
    log(f"  {len(attrs):,} modelled parcels in the attribute table")

    geom = gpd.read_file(os.path.join(trreb, "data/derived/lots/toronto.gpkg"))
    geom = geom[geom.geometry.notna()][["PARCELI2", "geometry"]].rename(
        columns={"PARCELI2": "parcel_id"})
    log(f"  {len(geom):,} parcel geometries")

    g = geom.merge(attrs[PARCEL_FIELDS], on="parcel_id", how="inner")
    log(f"  {len(g):,} joined")

    for c in TENTHS:
        g[c] = as_int(g[c] * 10)
    for c in WHOLE:
        g[c] = as_int(g[c])
    # booleans ride as plain 0/1 ints -- fiona cannot serialise pandas' nullable Int8,
    # and "True"/"False" strings would bloat every tile
    for c in BOOLS:
        g[c] = g[c].fillna(False).astype(bool).astype("int32")

    src = write_ndjson(g.to_crs(4326), os.path.join(tmp, "parcels.geojsonl"))
    # GitHub refuses a file over 100 MiB and the parcels land close to it, so the zooms below
    # 16 are simplified harder than tippecanoe's default of 1. A parcel edge is well under a
    # pixel at z13, so this is invisible; z16, where the boundaries are actually read, keeps
    # full detail.
    tippecanoe(src, os.path.join(out_dir, "parcels.pmtiles"), "parcels", 11, 16,
               "--simplification=6")


def build_footprints(trreb, tmp, out_dir):
    log("footprints")
    f = gpd.read_file(os.path.join(
        trreb, "data/raw/footprints/toronto_footprints_3dmassing_2025.gpkg"))
    f = f[f.geometry.notna()]
    keep = ["AVG_HEIGHT"] if "AVG_HEIGHT" in f.columns else []
    f = f[keep + ["geometry"]].rename(columns={"AVG_HEIGHT": "height_m"})
    if "height_m" in f.columns:
        f["height_m"] = pd.to_numeric(f.height_m, errors="coerce").round(1)
    log(f"  {len(f):,} footprints")

    src = write_ndjson(f.to_crs(4326), os.path.join(tmp, "footprints.geojsonl"))
    tippecanoe(src, os.path.join(out_dir, "footprints.pmtiles"), "footprints", 13, 16)


def build_columns(trreb, out_dir):
    """Field labels for the detail panel, lifted from the TRREB dictionary so the map and the
    data documentation stay in step."""
    sys.path.insert(0, os.path.join(trreb, "scripts"))
    from columns import COLUMNS  # noqa: E402

    by_name = {n: {"label": n, "unit": u, "desc": d} for n, _, u, d, _ in COLUMNS}
    # the fields the browser reconstructs are not in the tiles but are in the panel, so
    # they still need their labels and descriptions
    DERIVED_IN_PANEL = ["total_gfa_sqft", "garden_suite_sqft"]
    out = {c: by_name.get(c, {"label": c, "unit": "", "desc": ""})
           for c in list(PARCEL_FIELDS) + DERIVED_IN_PANEL}
    p = os.path.join(out_dir, "columns.json")
    json.dump(out, open(p, "w"), indent=1)
    log(f"columns.json -> {len(out)} fields")


def main(trreb, out_dir):
    if not shutil.which("tippecanoe"):
        sys.exit("tippecanoe not found: brew install tippecanoe")
    os.makedirs(out_dir, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        build_parcels(trreb, tmp, out_dir)
        build_footprints(trreb, tmp, out_dir)
    build_columns(trreb, out_dir)
    for f in sorted(os.listdir(out_dir)):
        log(f"  {os.path.getsize(os.path.join(out_dir, f)) / 1e6:8.1f} MB  {f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--trreb", default=TRREB)
    ap.add_argument("--out", default=os.path.join(HERE, "site", "data"))
    a = ap.parse_args()
    main(a.trreb, a.out)
