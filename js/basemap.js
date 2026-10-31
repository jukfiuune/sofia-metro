/* Base map: OpenFreeMap vector tiles (OpenMapTiles schema) drawn by MapLibre inside
 * Leaflet, in a muted style so the coloured lines and vehicles stand out. Falls back
 * to OpenStreetMap raster tiles where WebGL is unavailable. */
(function () {
  "use strict";

  const PALETTE = {
    light: {
      bg: "#e9edf2", park: "#cfe8d6", wood: "#c4e1cc", grass: "#d9ecd9", residential: "#e3e7ec",
      industrial: "#e1e2e6", water: "#bcd8ee", waterLine: "#a9cbe6", building: "#d7dbe2", buildingLine: "#c9ced7",
      road: "#ffffff", roadCasing: "#cbd2dc", major: "#ffffff", majorCasing: "#b9c3d0", motorway: "#fdfdfd",
      rail: "#aab3bf", path: "#d5dbe3", label: "#4a5260", labelHalo: "#ffffff", placeLabel: "#2f3540",
      waterLabel: "#5c86ad", boundary: "#b3b9c4", aeroway: "#dfe3e9",
    },
    dark: {
      bg: "#16191e", park: "#1b2a22", wood: "#1a2820", grass: "#1c2721", residential: "#1b1f25",
      industrial: "#1d2026", water: "#14273a", waterLine: "#1b3550", building: "#252a32", buildingLine: "#2d333c",
      road: "#2c323b", roadCasing: "#1f242b", major: "#39414c", majorCasing: "#262c34", motorway: "#46505d",
      rail: "#4a525e", path: "#2a3038", label: "#a9b1bd", labelHalo: "#16191e", placeLabel: "#d3d8df",
      waterLabel: "#6f95bb", boundary: "#4a515c", aeroway: "#22272e",
    },
  };

  const MINOR = ["minor", "service", "track"];
  const MAJOR = ["primary", "secondary", "tertiary", "trunk"];

  function nameExpr(lang) {
    return lang === "bg"
      ? ["coalesce", ["get", "name:bg"], ["get", "name"]]
      : ["coalesce", ["get", "name:en"], ["get", "name:latin"], ["get", "name"]];
  }

  function buildStyle(theme, lang) {
    const c = PALETTE[theme];
    const name = nameExpr(lang);
    const width = (base, stops) => ["interpolate", ["exponential", 1.5], ["zoom"], ...stops.flatMap(([z, w]) => [z, w * base])];
    const src = "ofm";
    return {
      version: 8,
      sources: { [src]: { type: "vector", url: "https://tiles.openfreemap.org/planet" } },
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      layers: [
        { id: "bg", type: "background", paint: { "background-color": c.bg } },
        { id: "landuse-res", type: "fill", source: src, "source-layer": "landuse",
          filter: ["in", ["get", "class"], ["literal", ["residential", "suburb", "neighbourhood"]]],
          paint: { "fill-color": c.residential, "fill-opacity": 0.7 } },
        { id: "landuse-ind", type: "fill", source: src, "source-layer": "landuse",
          filter: ["in", ["get", "class"], ["literal", ["industrial", "commercial", "railway", "retail"]]],
          paint: { "fill-color": c.industrial, "fill-opacity": 0.8 } },
        { id: "landcover-wood", type: "fill", source: src, "source-layer": "landcover",
          filter: ["==", ["get", "class"], "wood"], paint: { "fill-color": c.wood } },
        { id: "landcover-grass", type: "fill", source: src, "source-layer": "landcover",
          filter: ["in", ["get", "class"], ["literal", ["grass", "farmland", "wetland"]]],
          paint: { "fill-color": c.grass, "fill-opacity": 0.8 } },
        { id: "park", type: "fill", source: src, "source-layer": "park", paint: { "fill-color": c.park } },
        { id: "landuse-green", type: "fill", source: src, "source-layer": "landuse",
          filter: ["in", ["get", "class"], ["literal", ["cemetery", "pitch", "stadium", "garden", "playground"]]],
          paint: { "fill-color": c.park, "fill-opacity": 0.7 } },
        { id: "water", type: "fill", source: src, "source-layer": "water", paint: { "fill-color": c.water } },
        { id: "waterway", type: "line", source: src, "source-layer": "waterway",
          paint: { "line-color": c.waterLine, "line-width": width(1, [[10, 0.6], [16, 3]]) } },
        { id: "aeroway", type: "fill", source: src, "source-layer": "aeroway", filter: ["==", ["geometry-type"], "Polygon"],
          paint: { "fill-color": c.aeroway } },
        { id: "building", type: "fill", source: src, "source-layer": "building", minzoom: 14,
          paint: { "fill-color": c.building, "fill-outline-color": c.buildingLine,
                   "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 1] } },
        { id: "path", type: "line", source: src, "source-layer": "transportation", minzoom: 15,
          filter: ["==", ["get", "class"], "path"],
          paint: { "line-color": c.path, "line-width": width(1, [[15, 0.8], [18, 2]]), "line-dasharray": [2, 1] } },
        { id: "minor-casing", type: "line", source: src, "source-layer": "transportation", minzoom: 13,
          filter: ["in", ["get", "class"], ["literal", MINOR]], layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": c.roadCasing, "line-width": width(1, [[13, 1.2], [16, 6], [19, 20]]) } },
        { id: "major-casing", type: "line", source: src, "source-layer": "transportation", minzoom: 10,
          filter: ["in", ["get", "class"], ["literal", MAJOR]], layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": c.majorCasing, "line-width": width(1, [[10, 1], [14, 5], [18, 28]]) } },
        { id: "motorway-casing", type: "line", source: src, "source-layer": "transportation", minzoom: 8,
          filter: ["==", ["get", "class"], "motorway"], layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": c.majorCasing, "line-width": width(1, [[8, 1], [14, 7], [18, 32]]) } },
        { id: "minor", type: "line", source: src, "source-layer": "transportation", minzoom: 13,
          filter: ["in", ["get", "class"], ["literal", MINOR]], layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": c.road, "line-width": width(1, [[13, 0.6], [16, 4.5], [19, 17]]) } },
        { id: "major", type: "line", source: src, "source-layer": "transportation", minzoom: 10,
          filter: ["in", ["get", "class"], ["literal", MAJOR]], layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": c.major, "line-width": width(1, [[10, 0.6], [14, 3.5], [18, 24]]) } },
        { id: "motorway", type: "line", source: src, "source-layer": "transportation", minzoom: 8,
          filter: ["==", ["get", "class"], "motorway"], layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": c.motorway, "line-width": width(1, [[8, 0.6], [14, 5], [18, 28]]) } },
        { id: "rail", type: "line", source: src, "source-layer": "transportation", minzoom: 11,
          filter: ["all", ["in", ["get", "class"], ["literal", ["rail", "transit"]]], ["!=", ["get", "brunnel"], "tunnel"]],
          paint: { "line-color": c.rail, "line-width": width(1, [[11, 0.6], [16, 2]]) } },
        { id: "boundary", type: "line", source: src, "source-layer": "boundary",
          filter: ["<=", ["get", "admin_level"], 4],
          paint: { "line-color": c.boundary, "line-width": 1, "line-dasharray": [3, 2] } },
        { id: "water-name", type: "symbol", source: src, "source-layer": "water_name", minzoom: 13,
          layout: { "text-field": name, "text-font": ["Noto Sans Italic"], "text-size": 12 },
          paint: { "text-color": c.waterLabel, "text-halo-color": c.labelHalo, "text-halo-width": 1.2 } },
        { id: "road-name", type: "symbol", source: src, "source-layer": "transportation_name", minzoom: 14,
          layout: { "symbol-placement": "line", "text-field": name, "text-font": ["Noto Sans Regular"],
                    "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 13], "text-max-angle": 30 },
          paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.5 } },
        { id: "place-minor", type: "symbol", source: src, "source-layer": "place", minzoom: 12,
          filter: ["in", ["get", "class"], ["literal", ["suburb", "quarter", "neighbourhood", "village", "hamlet"]]],
          layout: { "text-field": name, "text-font": ["Noto Sans Regular"], "text-transform": "uppercase",
                    "text-letter-spacing": 0.08, "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 16, 13], "text-max-width": 8 },
          paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.5, "text-opacity": 0.8 } },
        { id: "place-town", type: "symbol", source: src, "source-layer": "place", minzoom: 8, maxzoom: 14,
          filter: ["in", ["get", "class"], ["literal", ["town", "city"]]],
          layout: { "text-field": name, "text-font": ["Noto Sans Bold"], "text-size": ["interpolate", ["linear"], ["zoom"], 8, 12, 13, 18] },
          paint: { "text-color": c.placeLabel, "text-halo-color": c.labelHalo, "text-halo-width": 2 } },
      ],
    };
  }

  // MapLibre (~250 KB) is only downloaded when the vector style is actually used.
  const MAPLIBRE = [
    ["link", "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css"],
    ["script", "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js"],
    ["script", "https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js"],
  ];
  let loading = null;
  function loadMapLibre() {
    if (window.maplibregl && L.maplibreGL) return Promise.resolve();
    if (loading) return loading;
    loading = MAPLIBRE.reduce((p, [tag, url]) => p.then(() => new Promise((res, rej) => {
      const el = document.createElement(tag);
      if (tag === "link") { el.rel = "stylesheet"; el.href = url; res(); } else { el.src = url; el.onload = res; el.onerror = rej; }
      document.head.appendChild(el);
    })), Promise.resolve());
    return loading;
  }

  function webglAvailable() {
    try {
      const canvas = document.createElement("canvas");
      return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
    } catch (e) { return false; }
  }

  /** Adds the base layer to a Leaflet map. style: "vector" | "osm". Returns a controller. */
  function createBasemap(map, { style, theme, lang }) {
    let layer = null, current = null, wanted = null, failed = false;
    const canVector = webglAvailable();
    const attribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    function apply(opts) {
      wanted = opts;
      let s = opts.style === "vector" && canVector && !failed ? "vector" : "osm";
      if (s === "vector" && !(window.maplibregl && L.maplibreGL)) {
        loadMapLibre().then(() => { if (wanted === opts) apply(opts); }, () => { failed = true; apply(opts); });
        if (layer) return "vector";
        s = "osm";                      // show raster tiles until MapLibre has loaded
      }
      const key = `${s}|${opts.theme}|${opts.lang}`;
      if (key === current) return s;
      if (layer && current && current.startsWith("vector") && s === "vector") {
        layer.getMaplibreMap().setStyle(buildStyle(opts.theme, opts.lang));
        current = key;
        return s;
      }
      if (layer) map.removeLayer(layer);
      if (s === "vector") {
        layer = L.maplibreGL({
          style: buildStyle(opts.theme, opts.lang), interactive: false,
          attribution: attribution + ' · <a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a>',
        });
      } else {
        layer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, className: "base-tiles", attribution });
      }
      layer.addTo(map);
      current = key;
      return s;
    }
    apply({ style, theme, lang });
    return { apply, canVector };
  }

  window.createBasemap = createBasemap;
})();
