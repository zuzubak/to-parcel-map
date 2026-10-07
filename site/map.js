/* Toronto parcel map.
 *
 * MapLibre GL JS reading two PMTiles archives over HTTP range requests, so the browser only
 * ever downloads the tiles on screen. The parcels are ~413k polygons and the footprints ~428k;
 * as GeoJSON that is hundreds of megabytes, which is why this is tiled.
 *
 * Unlike to-multiplex-map, which deliberately avoids WebGL, this needs it -- nothing else will
 * draw this many polygons interactively. WebGL support was verified on the target machine
 * before this was built.
 */
(function () {
  "use strict";

  const TORONTO = [-79.3832, 43.6532];
  const PARCEL_MINZOOM = 11;

  // Categorical, for zone. Chosen to stay distinguishable for the most common
  // red-green colour blindness rather than to look like a planning map.
  const ZONE_COLOURS = {
    RD: "#4e79a7",   // detached
    R:  "#59a14f",   // residential (old City of Toronto)
    RM: "#b07aa1",   // multiple
    RS: "#f28e2b",   // semi-detached
    RT: "#edc948",   // townhouse
  };
  const NO_DATA = "#d9d9d9";

  // Sequential ramp, matching the one used across the other maps on the site.
  const RAMP = ["#cde2fb", "#9ec5f4", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];

  // Breaks are explicit rather than computed: they should stay put as the data is rebuilt,
  // so two people comparing screenshots are looking at the same thing.
  const SCALES = {
    area_m2:           { label: "Lot area",          unit: "m²", breaks: [200, 300, 400, 550, 800] },
    frontage_m:        { label: "Frontage",          unit: "m",  breaks: [6, 9, 12, 15, 18] },
    buildable_width_m: { label: "Buildable width",   unit: "m",  breaks: [4, 6, 8, 11, 14] },
    max_coverage_pct:  { label: "Max lot coverage",  unit: "%",  breaks: [30, 33, 35, 40, 45] },
    max_buildable_footprint_sqft:
                       { label: "Buildable footprint", unit: "sq ft",
                         breaks: [400, 700, 950, 1200, 1399] },
    n_units:           { label: "Units",             unit: "",   breaks: [1, 4, 5] },
  };

  let map, columns = {}, selectedId = null;

  // ---------------------------------------------------------------- styling expressions

  function zoneExpression() {
    const m = ["match", ["get", "zone"]];
    for (const [z, c] of Object.entries(ZONE_COLOURS)) m.push(z, c);
    m.push(NO_DATA);
    return m;
  }

  function stepExpression(field) {
    const s = SCALES[field];
    const e = ["step", ["to-number", ["get", field], -1], NO_DATA];
    s.breaks.forEach((b, i) => e.push(b, RAMP[i + 1] || RAMP[RAMP.length - 1]));
    // anything below the first break but still a real number
    e[2] = RAMP[0];
    return e;
  }

  function colourFor(field) {
    return field === "zone" ? zoneExpression() : stepExpression(field);
  }

  // ---------------------------------------------------------------- legend

  function renderLegend(field) {
    const el = document.getElementById("legend");
    el.innerHTML = "";
    const row = (colour, text) => {
      const d = document.createElement("div");
      d.className = "legend-row";
      d.innerHTML = `<span class="sw" style="background:${colour}"></span><span>${text}</span>`;
      el.appendChild(d);
    };
    if (field === "zone") {
      const names = { RD: "RD detached", R: "R residential", RM: "RM multiple",
                      RS: "RS semi-detached", RT: "RT townhouse" };
      for (const [z, c] of Object.entries(ZONE_COLOURS)) row(c, names[z]);
      row(NO_DATA, "No zone");
      return;
    }
    const s = SCALES[field];
    const b = s.breaks;
    row(RAMP[0], `under ${b[0]} ${s.unit}`);
    for (let i = 0; i < b.length - 1; i++) {
      row(RAMP[i + 1], `${b[i]}–${b[i + 1]} ${s.unit}`);
    }
    row(RAMP[b.length] || RAMP[RAMP.length - 1], `${b[b.length - 1]} ${s.unit} and over`);
    // max_coverage_pct is null on roughly half of all parcels -- the by-law says no coverage
    // limit applies there, which is a real finding and must not read as missing data
    row(NO_DATA, field === "max_coverage_pct" ? "No coverage limit applies" : "No data");
  }

  // ---------------------------------------------------------------- detail panel

  const FMT = {
    corner_lot: v => (Number(v) ? "Yes" : "No"),
    lane_access: v => (Number(v) ? "Yes" : "No"),
    on_major_street: v => (Number(v) ? "Yes" : "No"),
  };
  const PANEL_FIELDS = [
    ["zone", "Zone"],
    ["frontage_m", "Frontage (m)"],
    ["depth_m", "Depth (m)"],
    ["area_m2", "Lot area (m²)"],
    ["front_setback_m", "Front setback (m)"],
    ["side_setback_m", "Side setback (m)"],
    ["rear_setback_m", "Rear setback (m)"],
    ["buildable_width_m", "Buildable width (m)"],
    ["depth_available_m", "Depth available (m)"],
    ["max_coverage_pct", "Max coverage (%)"],
    ["coverage_cap_m2", "Coverage cap (m²)"],
    ["building_depth_m", "Building depth (m)"],
    ["max_buildable_footprint_sqft", "Max footprint (sq ft)"],
    ["unit_type", "Unit type"],
    ["rear_remaining_m", "Rear space left (m)"],
    ["garden_suite_storeys", "Garden suite storeys"],
    ["n_units", "Units"],
    ["corner_lot", "Corner lot"],
    ["lane_access", "Lane access"],
    ["on_major_street", "On major street"],
  ];

  function showPanel(props) {
    document.getElementById("panel-title").textContent = props.address || "(no address)";
    document.getElementById("panel-sub").textContent = "Parcel " + props.parcel_id;
    const dl = document.getElementById("panel-body");
    dl.innerHTML = "";
    for (const [key, label] of PANEL_FIELDS) {
      const raw = props[key];
      let v;
      if (raw === undefined || raw === null || raw === "") {
        v = key === "max_coverage_pct" || key === "coverage_cap_m2" ? "no limit" : "—";
      } else {
        v = FMT[key] ? FMT[key](raw) : raw;
      }
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = v;
      if (v === "—" || v === "no limit") dd.className = "muted";
      const desc = columns[key] && columns[key].desc;
      if (desc) dt.title = desc;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    document.getElementById("panel").hidden = false;
  }

  function clearSelection() {
    if (selectedId !== null) {
      map.setFeatureState({ source: "parcels", sourceLayer: "parcels", id: selectedId },
                          { selected: false });
      selectedId = null;
    }
    document.getElementById("panel").hidden = true;
  }

  // ---------------------------------------------------------------- basemap

  function basemapStyle() {
    // CARTO retired its keyless endpoint, so use the key when CI has written config.js and
    // fall back to plain OSM raster rather than CARTO's "API KEY REQUIRED" watermark.
    const key = window.CARTO_API_KEY;
    const tiles = key
      ? [`https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?api_key=${key}`]
      : ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"];
    const attribution = key
      ? '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>'
      : '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    return {
      version: 8,
      sources: { basemap: { type: "raster", tiles, tileSize: 256, attribution } },
      layers: [{ id: "basemap", type: "raster", source: "basemap",
                 paint: { "raster-opacity": 0.55 } }],
    };
  }

  // ---------------------------------------------------------------- init

  async function init() {
    try {
      columns = await (await fetch("data/columns.json")).json();
    } catch (e) { /* labels fall back to the hardcoded ones */ }

    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    const base = location.href.replace(/[^/]*$/, "");
    map = new maplibregl.Map({
      container: "map",
      style: basemapStyle(),
      center: TORONTO,
      zoom: 11,
      maxZoom: 18,
      hash: true,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }));

    map.on("load", () => {
      map.addSource("parcels", {
        type: "vector",
        url: "pmtiles://" + base + "data/parcels.pmtiles",
        promoteId: "parcel_id",
      });
      map.addSource("footprints", {
        type: "vector",
        url: "pmtiles://" + base + "data/footprints.pmtiles",
      });

      map.addLayer({
        id: "parcels-fill",
        type: "fill",
        source: "parcels",
        "source-layer": "parcels",
        minzoom: PARCEL_MINZOOM,
        paint: {
          "fill-color": colourFor("zone"),
          "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.95, 0.6],
        },
      });
      map.addLayer({
        id: "parcels-line",
        type: "line",
        source: "parcels",
        "source-layer": "parcels",
        minzoom: 15,
        paint: { "line-color": "#5c5c5c", "line-width": 0.4, "line-opacity": 0.6 },
      });
      map.addLayer({
        id: "parcels-selected",
        type: "line",
        source: "parcels",
        "source-layer": "parcels",
        minzoom: PARCEL_MINZOOM,
        paint: { "line-color": "#111", "line-width": 2 },
        filter: ["==", ["get", "parcel_id"], ""],
      });
      map.addLayer({
        id: "footprints-fill",
        type: "fill",
        source: "footprints",
        "source-layer": "footprints",
        minzoom: 13,
        paint: { "fill-color": "#3a3a3a", "fill-opacity": 0.45 },
      });

      renderLegend("zone");
      updateZoomNote();
    });

    map.on("zoomend", updateZoomNote);

    map.on("click", "parcels-fill", (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      clearSelection();
      selectedId = f.id;
      if (selectedId !== undefined && selectedId !== null) {
        map.setFeatureState({ source: "parcels", sourceLayer: "parcels", id: selectedId },
                            { selected: true });
      }
      map.setFilter("parcels-selected", ["==", ["get", "parcel_id"], f.properties.parcel_id]);
      showPanel(f.properties);
    });
    map.on("mouseenter", "parcels-fill", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "parcels-fill", () => { map.getCanvas().style.cursor = ""; });

    document.getElementById("colour-by").addEventListener("change", (e) => {
      const field = e.target.value;
      map.setPaintProperty("parcels-fill", "fill-color", colourFor(field));
      renderLegend(field);
    });
    document.getElementById("show-footprints").addEventListener("change", (e) => {
      map.setLayoutProperty("footprints-fill", "visibility",
                            e.target.checked ? "visible" : "none");
    });
    document.getElementById("panel-close").addEventListener("click", () => {
      clearSelection();
      map.setFilter("parcels-selected", ["==", ["get", "parcel_id"], ""]);
    });
  }

  function updateZoomNote() {
    const note = document.getElementById("zoom-note");
    note.hidden = map.getZoom() >= PARCEL_MINZOOM;
  }

  init();
})();
