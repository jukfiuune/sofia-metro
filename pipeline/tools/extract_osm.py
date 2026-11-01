#!/usr/bin/env python3
"""Cut what the build needs out of a Geofabrik OpenStreetMap extract, writing the
same files tools/fetch_osm_roads.py fetches from Overpass (data/osm/):

  roads-all.json   drivable roads, tram and light rail tracks (map matching, walking)
  walk-all.json    footpaths, steps, platforms, the nodes where people cross roads, metro entrances
  routes.json      bus, trolleybus and tram route relations
  depots.json      depot areas and bus stations

Needs pyosmium; use the project's virtual environment:

    python3 -m venv .venv && .venv/bin/pip install osmium
    curl -L -o data/osm/bulgaria-latest.osm.pbf https://download.geofabrik.de/europe/bulgaria-latest.osm.pbf
    .venv/bin/python pipeline/tools/extract_osm.py [data/osm/bulgaria-latest.osm.pbf]
"""
import json
import re
import sys
from pathlib import Path

import osmium

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "osm"
# Sofia with the villages its suburban lines reach (fetch_osm_roads.py's city tiles and outer strips).
SOUTH, WEST, NORTH, EAST = 42.47, 23.06, 42.87, 23.62

ROADS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
         "tertiary", "tertiary_link", "unclassified", "residential", "service", "living_street", "busway", "bus_guideway", "road"}
WALKWAYS = {"footway", "path", "pedestrian", "steps", "cycleway", "track", "corridor", "bridleway", "platform"}
CROSS_NODE = re.compile(r"^(crossing|traffic_signals)$")
RAIL_CROSS = {"crossing", "tram_crossing", "tram_level_crossing", "level_crossing"}
DEPOT_NAME = re.compile(r"[Дд]епо|[Аа]втобусен парк|[Тт]рамваен парк|[Тт]ролейбусен парк")


def inside(lat, lon):
    return SOUTH <= lat <= NORTH and WEST <= lon <= EAST


class Extract(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.roads, self.walk, self.routes, self.depots = [], [], [], []

    def node(self, n):
        if not n.tags or not n.location.valid() or not inside(n.location.lat, n.location.lon):
            return
        t = dict(n.tags)
        el = {"type": "node", "id": n.id, "lat": n.location.lat, "lon": n.location.lon, "tags": t}
        if CROSS_NODE.match(t.get("highway", "")) or t.get("railway") in RAIL_CROSS or t.get("railway") == "subway_entrance":
            self.walk.append(el)
        if self.is_depot(t):
            self.depots.append(el)

    def way(self, w):
        t = dict(w.tags)
        hw, rw = t.get("highway"), t.get("railway")
        road = hw in ROADS or rw in ("tram", "light_rail")
        walk = hw in WALKWAYS and t.get("access") not in ("private", "no") and t.get("foot") not in ("no", "private")
        depot = self.is_depot(t)
        if not (road or walk or depot):
            return
        try:
            pts = [(nd.ref, nd.location.lat, nd.location.lon) for nd in w.nodes]
        except osmium.InvalidLocationError:
            pts = [(nd.ref, nd.location.lat, nd.location.lon) for nd in w.nodes if nd.location.valid()]
        if len(pts) < 2 or not any(inside(la, lo) for _, la, lo in pts):
            return
        el = {"type": "way", "id": w.id, "nodes": [p[0] for p in pts],
              "geometry": [{"lat": round(la, 7), "lon": round(lo, 7)} for _, la, lo in pts], "tags": t}
        if road:
            self.roads.append(el)
        elif walk:
            self.walk.append(el)
        if depot:
            lats, lons = [p[1] for p in pts], [p[2] for p in pts]
            self.depots.append({"type": "way", "id": w.id, "center": {"lat": (min(lats) + max(lats)) / 2, "lon": (min(lons) + max(lons)) / 2}, "tags": t})

    def relation(self, r):
        t = dict(r.tags)
        if t.get("type") == "route" and t.get("route") in ("bus", "trolleybus", "tram"):
            if t.get("network", "").startswith("Градски транспорт София") or "Sofia" in t.get("network", "") or "София" in t.get("network", ""):
                kinds = {"n": "node", "w": "way", "r": "relation"}
                self.routes.append({"type": "relation", "id": r.id, "tags": t,
                                    "members": [{"type": kinds[m.type], "ref": m.ref, "role": m.role} for m in r.members]})
        elif self.is_depot(t):
            self.depots.append({"type": "relation", "id": r.id, "tags": t})

    @staticmethod
    def is_depot(t):
        return (t.get("landuse") == "depot" or t.get("railway") == "depot" or t.get("amenity") == "bus_station"
                or bool(DEPOT_NAME.search(t.get("name", ""))))


def main():
    pbf = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT / "bulgaria-latest.osm.pbf"
    h = Extract()
    h.apply_file(str(pbf), locations=True, idx="flex_mem")
    for name, els in (("roads-all", h.roads), ("walk-all", h.walk), ("routes", h.routes), ("depots", h.depots)):
        path = OUT / f"{name}.json"
        path.write_text(json.dumps({"elements": els}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"{name}: {len(els)} elements, {path.stat().st_size // 1024} KB")
    # The Overpass tiles hold the same data; move them aside so nothing is read twice.
    old = OUT / "overpass"
    for f in list(OUT.glob("roads-*-*.json")) + list(OUT.glob("outer-*.json")) + list(OUT.glob("walk-*-*.json")):
        old.mkdir(exist_ok=True)
        f.rename(old / f.name)


if __name__ == "__main__":
    main()
