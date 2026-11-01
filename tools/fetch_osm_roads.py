#!/usr/bin/env python3
"""Download what map-matching and depots need from OpenStreetMap, for Sofia:
drivable roads (with one-way and bus/trolleybus exemptions), tram tracks, depot
areas and public-transport route relations.

Public Overpass servers are often slow, so the area is fetched in tiles, one at
a time, with retries over several mirrors; each tile is saved as soon as it
arrives (data/osm/), so an interrupted download resumes where it stopped.

    python3 tools/fetch_osm_roads.py
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "osm"
MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
UA = {"User-Agent": "sofia-transport/1.0 (github.com/jukfiuune/sofia-metro)"}
SOUTH, WEST, NORTH, EAST = 42.57, 23.12, 42.81, 23.58
ROWS, COLS = 2, 3
HIGHWAYS = ("motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|"
            "tertiary_link|unclassified|residential|service|living_street|busway|bus_guideway|road")

QUERIES = {
    "depots": f"""[out:json][timeout:300];
(nwr["landuse"="depot"]({SOUTH},{WEST},{NORTH},{EAST});
 nwr["railway"="depot"]({SOUTH},{WEST},{NORTH},{EAST});
 nwr["amenity"="bus_station"]({SOUTH},{WEST},{NORTH},{EAST});
 nwr["name"~"[Дд]епо|[Аа]втобусен парк|[Тт]рамваен парк|[Тт]ролейбусен парк"]({SOUTH},{WEST},{NORTH},{EAST}););
out tags center;""",
    "routes": f"""[out:json][timeout:600];
relation["type"="route"]["route"~"^(bus|trolleybus|tram)$"]({SOUTH},{WEST},{NORTH},{EAST});
out body;""",
}


def tile_query(south, west, north, east):
    return f"""[out:json][timeout:600];
(way["highway"~"^({HIGHWAYS})$"]({south},{west},{north},{east});
 way["railway"~"^(tram|light_rail)$"]({south},{west},{north},{east}););
out geom;"""


def walk_query(south, west, north, east):
    """Paths only people use (pavements, footpaths, steps, squares) and the nodes where
    they may cross a road: marked crossings and traffic lights."""
    return f"""[out:json][timeout:600];
(way["highway"~"^(footway|path|pedestrian|steps|cycleway|track|corridor|bridleway|platform)$"]["access"!~"^(private|no)$"]["foot"!~"^(no|private)$"]({south},{west},{north},{east});
 node["highway"~"^(crossing|traffic_signals)$"]({south},{west},{north},{east});
 node["railway"~"^(crossing|tram_crossing|tram_level_crossing|level_crossing)$"]({south},{west},{north},{east}););
out geom;"""


def fetch(query, name):
    path = OUT / f"{name}.json"
    if path.exists():
        return "cached"
    data = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(8):
        url = MIRRORS[attempt % len(MIRRORS)]
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=660) as r:
                raw = r.read()
            if not raw.startswith(b"{"):
                raise ValueError(raw[:120])
            json.loads(raw)                               # complete and valid
            path.write_bytes(raw)
            return f"{len(raw) // 1024} KB from {url.split('/')[2]}"
        except Exception as e:                           # busy server: try the next mirror
            print(f"  {name}: {url.split('/')[2]} failed ({str(e)[:80]}), retrying", flush=True)
            time.sleep(min(60, 10 * (attempt + 1)))
    raise SystemExit(f"Could not download {name}")


# Suburban lines reach villages outside the city tiles: strips around them.
OUTER = {"outer-south": (42.47, 23.06, SOUTH, 23.62), "outer-north": (NORTH, 23.06, 42.87, 23.62),
         "outer-west": (SOUTH, 23.06, NORTH, WEST), "outer-east": (SOUTH, EAST, NORTH, 23.62)}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (s, w, n, e) in OUTER.items():
        print(f"{name}: {fetch(tile_query(s, w, n, e), name)}", flush=True)
    for name, q in QUERIES.items():
        print(f"{name}: {fetch(q, name)}", flush=True)
    dlat, dlon = (NORTH - SOUTH) / ROWS, (EAST - WEST) / COLS
    for r in range(ROWS):
        for c in range(COLS):
            s, w = SOUTH + r * dlat, WEST + c * dlon
            name = f"roads-{r}-{c}"
            print(f"{name}: {fetch(tile_query(s, w, s + dlat, w + dlon), name)}", flush=True)
            name = f"walk-{r}-{c}"
            print(f"{name}: {fetch(walk_query(s, w, s + dlat, w + dlon), name)}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
