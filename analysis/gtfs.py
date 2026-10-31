"""Static timetable for one service day, shared by the fake-data generator and the
analysis scripts: lines, stops, route shapes (projected to metres) with each
trip's stops placed along its shape, and vehicle duties (GTFS block_id).

Parsing the feed takes ~20 s, so the result is cached per (feed, date).
"""
import csv
import hashlib
import json
import io
import math
import pickle
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from build_transit import project_stops  # noqa: E402

KINDS = {"0": "tram", "3": "bus", "11": "trolley"}
LAT0, LON0 = 42.69, 23.32
KX, KY = 111320 * math.cos(math.radians(LAT0)), 111320.0
CACHE = ROOT / "analysis" / ".cache"


def to_xy(lat, lon):
    return (lon - LON0) * KX, (lat - LAT0) * KY


def to_ll(x, y):
    return LAT0 + y / KY, LON0 + x / KX


def secs(hms):
    h, m, s = (int(x) for x in hms.split(":"))
    return h * 3600 + m * 60 + s


class Shape:
    """Route shape in local metres with cumulative distance."""

    def __init__(self, pts):
        self.ll = pts
        self.xy = [to_xy(*p) for p in pts]
        self.cum = [0.0]
        for a, b in zip(self.xy, self.xy[1:]):
            self.cum.append(self.cum[-1] + math.dist(a, b))
        self.len = self.cum[-1]

    def at(self, s):
        """(x, y, heading in degrees) at distance s."""
        s = max(0.0, min(self.len, s))
        lo, hi = 0, len(self.cum) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if self.cum[mid] <= s:
                lo = mid
            else:
                hi = mid
        seg = self.cum[hi] - self.cum[lo] or 1.0
        f = (s - self.cum[lo]) / seg
        (x1, y1), (x2, y2) = self.xy[lo], self.xy[hi]
        return x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, math.degrees(math.atan2(x2 - x1, y2 - y1))

    def project(self, x, y, lo=0.0, hi=math.inf):
        """(distance along, error in m) of the nearest point with lo <= s <= hi."""
        best, best_s = math.inf, 0.0
        for k in range(len(self.xy) - 1):
            if self.cum[k + 1] < lo or self.cum[k] > hi:
                continue
            (x1, y1), (x2, y2) = self.xy[k], self.xy[k + 1]
            dx, dy = x2 - x1, y2 - y1
            L2 = dx * dx + dy * dy
            f = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
            e = math.hypot(x - x1 - dx * f, y - y1 - dy * f)
            if e < best:
                best, best_s = e, self.cum[k] + math.sqrt(L2) * f
        return best_s, best


def _read(zf, name):
    with zf.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def load_day(zip_path, date):
    """date: 'YYYYMMDD'. Returns a dict with routes, stops, shapes, trips, blocks."""
    zip_path = Path(zip_path)
    mf = ROOT / "data" / "osm_shapes.json"
    mstamp = int(mf.stat().st_mtime) if mf.exists() else 0
    key = hashlib.sha256(f"{zip_path.resolve()}|{zip_path.stat().st_size}|{date}|{mstamp}|v3".encode()).hexdigest()[:16]
    CACHE.mkdir(parents=True, exist_ok=True)
    cache = CACHE / f"day-{date}-{key}.pickle"
    if cache.exists():
        return pickle.loads(cache.read_bytes())

    zf = zipfile.ZipFile(zip_path)
    routes = {}
    for r in _read(zf, "routes.txt"):
        if r["route_type"] in KINDS:
            routes[r["route_id"]] = {"name": r["route_short_name"], "kind": KINDS[r["route_type"]],
                                     "night": r["route_color"].upper() == "000000"}
    services = {c["service_id"] for c in _read(zf, "calendar_dates.txt") if c["date"] == date and c["exception_type"] == "1"}
    trips = {t["trip_id"]: t for t in _read(zf, "trips.txt") if t["route_id"] in routes and t["service_id"] in services}
    stops = {s["stop_id"]: (float(s["stop_lat"]), float(s["stop_lon"]), s["stop_name"]) for s in _read(zf, "stops.txt")}
    st = defaultdict(list)
    for r in _read(zf, "stop_times.txt"):
        if r["trip_id"] in trips:
            st[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"], secs(r["arrival_time"]), secs(r["departure_time"])))
    shape_ids = {t["shape_id"] for t in trips.values()}
    pts = defaultdict(list)
    for p in _read(zf, "shapes.txt"):
        if p["shape_id"] in shape_ids:
            pts[p["shape_id"]].append((int(p["shape_pt_sequence"]), float(p["shape_pt_lat"]), float(p["shape_pt_lon"])))
    shapes = {sid: Shape([(la, lo) for _, la, lo in sorted(v)]) for sid, v in pts.items() if len(v) > 1}
    # Prefer the shapes map-matched onto OSM (tools/match_shapes.py), as the app does.
    matched_file = ROOT / "data" / "osm_shapes.json"
    if matched_file.exists():
        for sid, mp in json.loads(matched_file.read_text(encoding="utf-8")).items():
            if sid in shapes and len(mp) > 1:
                shapes[sid] = Shape([tuple(p) for p in mp])

    # Stop positions along each shape, computed once per (shape, stop list).
    placed = {}
    out_trips = {}
    for tid, t in trips.items():
        seq = sorted(st[tid])
        if len(seq) < 2 or t["shape_id"] not in shapes:
            continue
        stop_list = tuple(s for _, s, _, _ in seq)
        pk = (t["shape_id"], stop_list)
        if pk not in placed:
            sh = shapes[t["shape_id"]]
            placed[pk] = project_stops(sh.xy, sh.cum, [to_xy(*stops[s][:2]) for s in stop_list])
        # Some trips have no block_id; their run number (3rd field of the trip_id) identifies the vehicle.
        block = t["block_id"] or f"{t['route_id']}-run{tid.split('-')[2]}"
        out_trips[tid] = {"route": t["route_id"], "shape": t["shape_id"], "block": block, "head": t["trip_headsign"],
                          "stops": list(stop_list), "d": placed[pk],
                          "arr": [a for _, _, a, _ in seq], "dep": [d for _, _, _, d in seq]}
    blocks = defaultdict(list)
    for tid, t in out_trips.items():
        blocks[t["block"]].append(tid)
    for b in blocks.values():
        b.sort(key=lambda tid: out_trips[tid]["dep"][0])
    day = {"date": date, "routes": routes, "stops": stops, "shapes": shapes, "trips": out_trips, "blocks": dict(blocks)}
    cache.write_bytes(pickle.dumps(day, protocol=pickle.HIGHEST_PROTOCOL))
    return day


def latest_gtfs(recordings):
    zips = sorted((Path(recordings) / "gtfs").glob("*.zip"))
    if not zips:
        raise SystemExit(f"No timetable in {recordings}/gtfs (the recorder saves one when it starts)")
    return zips[-1]
