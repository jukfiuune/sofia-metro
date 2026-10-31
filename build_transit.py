#!/usr/bin/env python3
"""Build data/transit.js and data/shapes.js (buses, trams, trolleybuses) from the
official Sofia GTFS feed. The metro is built separately by build_data.py.

Live vehicle positions come straight from the GTFS-realtime feed in the browser;
this static part gives the lines, stops and route shapes they are drawn on.
A realtime trip_id is "<route>-<shape>-<run>-<seq>-<service>", so a vehicle's
shape (and with it its stop pattern and destination) is known from its trip_id.

Usage:
    python3 build_transit.py                 # download the feed and build
    python3 build_transit.py path/to/gtfs.zip
"""
import io
import json
import math
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from build_data import FEED_URL, read_csv

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data" / "transit.js"
OUT_SHAPES = ROOT / "data" / "shapes.js"
KINDS = {"0": "tram", "3": "bus", "11": "trolley"}
SIMPLIFY = 1.5           # m, Douglas-Peucker tolerance for shapes


def encode(points):
    """Google encoded polyline (precision 5)."""
    out, plat, plon = [], 0, 0
    for lat, lon in points:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def simplify(xy, tol):
    """Douglas-Peucker on projected points; returns kept indices."""
    keep = [False] * len(xy)
    keep[0] = keep[-1] = True
    stack = [(0, len(xy) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = xy[a], xy[b]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy)
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            x, y = xy[i]
            d = abs(dy * (x - x1) - dx * (y - y1)) / L if L > 0 else math.hypot(x - x1, y - y1)
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [i for i, k in enumerate(keep) if k]


def project_stops(xy, cum, stop_xy):
    """Distance along the shape of each stop, in order, never going backwards."""
    out, start = [], 0
    for sx, sy in stop_xy:
        best, best_d, best_i = float("inf"), 0.0, start
        for i in range(start, len(xy) - 1):
            (x1, y1), (x2, y2) = xy[i], xy[i + 1]
            dx, dy = x2 - x1, y2 - y1
            L2 = dx * dx + dy * dy
            t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((sx - x1) * dx + (sy - y1) * dy) / L2))
            px, py = x1 + dx * t, y1 + dy * t
            e = math.hypot(sx - px, sy - py)
            if e < best - 1e-6:
                best, best_d, best_i = e, cum[i] + math.sqrt(L2) * t, i
            # Once well past a good match, stop: the shape may come back near this stop later.
            if best < 30 and cum[i] - best_d > 400:
                break
        out.append(round(best_d, 1))
        start = best_i
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if args:
        raw = Path(args[0]).read_bytes()
    else:
        print(f"Downloading {FEED_URL} ...")
        with urllib.request.urlopen(FEED_URL, timeout=180) as r:
            raw = r.read()
    zf = zipfile.ZipFile(io.BytesIO(raw))

    routes = {}
    for r in read_csv(zf, "routes.txt"):
        kind = KINDS.get(r["route_type"])
        if not kind:
            continue
        night = r["route_color"].upper() == "000000"
        routes[r["route_id"]] = {
            "name": r["route_short_name"], "kind": kind, "night": night,
            "color": "#" + (r["route_color"] or "888888"), "text": "#" + (r["route_text_color"] or "FFFFFF"),
            "long": r["route_long_name"],
        }

    en = {}
    for t in read_csv(zf, "translations.txt"):
        if t["table_name"] == "stops" and t["field_name"] == "stop_name" and t["language"] == "en":
            en[t["field_value"]] = t["translation"]

    stops = {s["stop_id"]: s for s in read_csv(zf, "stops.txt") if s["location_type"] in ("", "0")}
    lat0 = sum(float(s["stop_lat"]) for s in stops.values()) / len(stops)
    KX, KY = 111320 * math.cos(math.radians(lat0)), 111320.0
    to_xy = lambda lat, lon: ((lon - 23.32) * KX, (lat - lat0) * KY)

    # One representative trip per shape: its route, headsign and stop list.
    by_shape = defaultdict(Counter)
    trip_shape, trip_route = {}, {}
    for t in read_csv(zf, "trips.txt"):
        if t["route_id"] in routes:
            trip_shape[t["trip_id"]] = t["shape_id"]
            trip_route[t["trip_id"]] = (t["route_id"], t["trip_headsign"])
    seqs = defaultdict(list)
    for st in read_csv(zf, "stop_times.txt"):
        if st["trip_id"] in trip_shape:
            seqs[st["trip_id"]].append((int(st["stop_sequence"]), st["stop_id"]))
    for tid, seq in seqs.items():
        seq.sort()
        by_shape[trip_shape[tid]][(trip_route[tid], tuple(s for _, s in seq))] += 1

    shape_pts = defaultdict(list)
    for p in read_csv(zf, "shapes.txt"):
        if p["shape_id"] in by_shape:
            shape_pts[p["shape_id"]].append((int(p["shape_pt_sequence"]), float(p["shape_pt_lat"]), float(p["shape_pt_lon"])))

    stop_ids, stop_index = [], {}
    def sidx(sid):
        if sid not in stop_index:
            stop_index[sid] = len(stop_ids)
            stop_ids.append(sid)
        return stop_index[sid]

    patterns, shapes_out = {}, {}
    stop_routes = defaultdict(set)
    total_pts = 0
    for shape_id, counter in sorted(by_shape.items()):
        ((route_id, headsign), stop_list), _ = counter.most_common(1)[0]
        pts = [(la, lo) for _, la, lo in sorted(shape_pts[shape_id])]
        if len(pts) < 2:
            continue
        xy = [to_xy(*p) for p in pts]
        keep = simplify(xy, SIMPLIFY)
        pts, xy = [pts[i] for i in keep], [xy[i] for i in keep]
        cum = [0.0]
        for a, b in zip(xy, xy[1:]):
            cum.append(cum[-1] + math.dist(a, b))
        stop_xy = [to_xy(float(stops[s]["stop_lat"]), float(stops[s]["stop_lon"])) for s in stop_list]
        pd = project_stops(xy, cum, stop_xy)
        patterns[shape_id] = {"r": route_id, "h": headsign, "s": [sidx(s) for s in stop_list], "d": pd}
        shapes_out[shape_id] = encode(pts)
        total_pts += len(pts)
        for s in stop_list:
            stop_routes[s].add(route_id)

    stops_out = []
    for sid in stop_ids:
        s = stops[sid]
        stops_out.append([sid, s["stop_code"], s["stop_name"], en.get(s["stop_name"], ""),
                          round(float(s["stop_lat"]), 6), round(float(s["stop_lon"]), 6),
                          sorted(stop_routes[sid])])

    feed = {}
    if "feed_info.txt" in zf.namelist():
        fi = next(read_csv(zf, "feed_info.txt"))
        feed = {"start": fi.get("feed_start_date", ""), "end": fi.get("feed_end_date", "")}

    data = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "feed": feed,
        "routes": routes,
        "stops": stops_out,                 # [id, code, name, nameEn, lat, lon, routeIds]
        "patterns": patterns,               # shapeId -> {r: route, h: headsign, s: stop indices, d: stop distances (m)}
    }
    OUT.write_text("window.TRANSIT_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    OUT_SHAPES.write_text("window.TRANSIT_SHAPES = " + json.dumps(shapes_out, separators=(",", ":")) + ";\n", encoding="utf-8")
    kinds = Counter(r["kind"] for r in routes.values())
    print(f"{len(routes)} lines {dict(kinds)}, {len(stops_out)} stops, {len(patterns)} shapes ({total_pts} points)")
    print(f"Wrote {OUT} ({OUT.stat().st_size // 1024} KB) and {OUT_SHAPES} ({OUT_SHAPES.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
