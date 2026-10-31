#!/usr/bin/env python3
"""Map-match every GTFS route shape onto OpenStreetMap roads or tram tracks, so
vehicles, route lines and bodies sit on the streets the map draws.

Hidden-Markov map matching (Newson & Krumm): the shape is resampled every STEP
metres; each sample's candidates are the OSM edges within RADIUS (roads for
buses and trolleybuses in their legal direction, tram tracks for trams); the
chosen path balances closeness to the shape against the driven distance between
samples matching the distance along the shape, so it does not cut through side
streets. The matched geometry is the OSM nodes along that path.

Where the line has an OSM route relation, its member ways are preferred (cheaper
to drive and a closeness bonus): relations are often more detailed than GTFS (exact
lanes, tracks, terminal loops), but can be out of date, so the GTFS shape still
decides where the line goes and the relation only wins inside its corridor.

A shape is kept as GTFS drew it when the match is doubtful (length off by more
than MAX_LEN_DIFF or less than MIN_MATCHED of it matched). Output:
data/osm_shapes.json {shape_id: [[lat, lon], ...]} and a report.

    python3 tools/match_shapes.py [--shapes A4231 TM5 ...]
"""
import argparse
import heapq
import json
import math
import sys
import zipfile
import csv
import io
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OSM = ROOT / "data" / "osm"
OUT = ROOT / "data" / "osm_shapes.json"
LAT0, LON0 = 42.69, 23.32
KX, KY = 111320 * math.cos(math.radians(LAT0)), 111320.0
STEP, RADIUS, SIGMA, BETA = 40.0, 40.0, 10.0, 15.0
PREFER_COST, PREFER_BONUS = 0.6, 1.5      # relation ways: cost factor, emission log-bonus
MAX_CAND = 6
MAX_LEN_DIFF, MIN_MATCHED = 0.15, 0.85
CELL = 60.0
ROAD = set(("motorway motorway_link trunk trunk_link primary primary_link secondary secondary_link tertiary "
            "tertiary_link unclassified residential service living_street busway bus_guideway road").split())


def xy(lat, lon):
    return (lon - LON0) * KX, (lat - LAT0) * KY


def ll(x, y):
    return LAT0 + y / KY, LON0 + x / KX


class Graph:
    """Directed graph per mode: 'road' or 'tram'. Edges carry a cost multiplier."""

    def __init__(self):
        self.pos = {}                                   # node id -> (x, y)
        self.adj = {"road": defaultdict(list), "tram": defaultdict(list)}
        self.edges = {"road": [], "tram": []}           # (u, v, cost factor)
        self.grid = {"road": defaultdict(list), "tram": defaultdict(list)}

    def add_way(self, way):
        t = way.get("tags", {})
        nodes, geom = way.get("nodes"), way.get("geometry")
        if not nodes or not geom or len(nodes) != len(geom):
            return
        for n, g in zip(nodes, geom):
            self.pos.setdefault(n, xy(g["lat"], g["lon"]))
        if t.get("railway") in ("tram", "light_rail"):
            mode, fwd, back, factor = "tram", True, True, 1.0
        elif t.get("highway") in ROAD:
            mode, factor = "road", 1.0
            oneway = t.get("oneway", "no")
            if t.get("junction") in ("roundabout", "circular") and oneway == "no":
                oneway = "yes"
            exempt = t.get("oneway:bus") == "no" or t.get("oneway:psv") == "no" or t.get("busway") == "opposite_lane" \
                or t.get("busway:left") == "opposite_lane" or "lanes:bus:backward" in t or "lanes:psv:backward" in t
            fwd = oneway != "-1"
            back = oneway in ("no", "false", "0") or exempt
            if t.get("highway") == "service":
                factor = 1.25 if t.get("service") not in ("parking_aisle", "driveway") else 2.0
            if t.get("access") in ("no", "private") and t.get("bus") not in ("yes", "designated") and t.get("psv") not in ("yes", "designated"):
                factor *= 3.0
        else:
            return
        for a, b in zip(nodes, nodes[1:]):
            for u, v, ok in ((a, b, fwd), (b, a, back)):
                if not ok or u == v:
                    continue
                e = len(self.edges[mode])
                self.edges[mode].append((u, v, factor, way["id"]))
                self.adj[mode][u].append(e)
                (x1, y1), (x2, y2) = self.pos[u], self.pos[v]
                for cx in range(int(min(x1, x2) // CELL), int(max(x1, x2) // CELL) + 1):
                    for cy in range(int(min(y1, y2) // CELL), int(max(y1, y2) // CELL) + 1):
                        self.grid[mode][(cx, cy)].append(e)

    def length(self, mode, e):
        u, v = self.edges[mode][e][:2]
        return math.dist(self.pos[u], self.pos[v])

    def candidates(self, mode, x, y):
        """[(dist, edge, offset along edge)] of edges within RADIUS, nearest first."""
        seen, out = set(), []
        r = int(RADIUS // CELL) + 1
        cx, cy = int(x // CELL), int(y // CELL)
        for i in range(cx - r, cx + r + 1):
            for j in range(cy - r, cy + r + 1):
                for e in self.grid[mode].get((i, j), ()):
                    if e in seen:
                        continue
                    seen.add(e)
                    u, v = self.edges[mode][e][:2]
                    (x1, y1), (x2, y2) = self.pos[u], self.pos[v]
                    dx, dy = x2 - x1, y2 - y1
                    L2 = dx * dx + dy * dy
                    f = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
                    d = math.hypot(x - x1 - dx * f, y - y1 - dy * f)
                    if d <= RADIUS:
                        out.append((d, e, f * math.sqrt(L2)))
        out.sort()
        # One candidate per edge pair (the two directions of a two-way street are separate
        # edges with the same geometry; keep both, they have different successors).
        return out[:MAX_CAND]

    def route(self, mode, a, b_set, limit, prefer=frozenset()):
        """Shortest costs from candidate a = (edge, offset) to every candidate in b_set
        within `limit` metres. Returns {cand: (cost, metres, node path)}."""
        ea, oa = a
        ua, va, fa, wa = self.edges[mode][ea]
        fa *= PREFER_COST if wa in prefer else 1.0
        out = {}
        la = self.length(mode, ea)
        for b in b_set:                                 # same edge, moving forward
            eb, ob = b
            if eb == ea and ob >= oa - 1:
                out[b] = ((ob - oa) * fa, ob - oa, [])
        targets = defaultdict(list)
        for b in b_set:
            targets[self.edges[mode][b[0]][0]].append(b)
        start = (la - oa) * fa
        dist = {va: (start, la - oa)}
        prev = {va: None}
        heap = [(start, la - oa, va)]
        while heap:
            c, m, n = heapq.heappop(heap)
            if c > dist[n][0] + 1e-9:
                continue
            if m > limit:
                break
            for b in targets.get(n, ()):
                eb, ob = b
                _, _, fb, wb = self.edges[mode][eb]
                fb *= PREFER_COST if wb in prefer else 1.0
                tot = (c + ob * fb, m + ob)
                if b not in out or tot[0] < out[b][0]:
                    path, k = [], n
                    while k is not None:
                        path.append(k)
                        k = prev[k]
                    out[b] = (*tot, path[::-1])
            for e in self.adj[mode].get(n, ()):
                _, v, f, w = self.edges[mode][e]
                if w in prefer:
                    f *= PREFER_COST
                L = self.length(mode, e)
                nc, nm = c + L * f, m + L
                if v not in dist or nc < dist[v][0]:
                    dist[v] = (nc, nm)
                    prev[v] = n
                    heapq.heappush(heap, (nc, nm, v))
        return out


def resample(pts, step):
    out = [pts[0]]
    carry = 0.0
    for a, b in zip(pts, pts[1:]):
        seg = math.dist(a, b)
        d = step - carry
        while d <= seg:
            f = d / seg
            out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
            d += step
        carry = seg - (d - step)
    if math.dist(out[-1], pts[-1]) > 1:
        out.append(pts[-1])
    return out


def match(g, mode, pts, prefer=frozenset()):
    """Matched geometry [(x, y)] and the fraction of samples matched."""
    samples = resample(pts, STEP)
    cands = [g.candidates(mode, x, y) for x, y in samples]
    bonus = lambda e: PREFER_BONUS if g.edges[mode][e][3] in prefer else 0.0
    # Viterbi over samples; chains restart where no candidate or no transition exists.
    best = [{} for _ in samples]          # i -> {cand: (logp, prev cand)}
    for c in cands[0]:
        best[0][(c[1], c[2])] = (-0.5 * (c[0] / SIGMA) ** 2 + bonus(c[1]), None)
    routes = {}
    for i in range(1, len(samples)):
        gap = math.dist(samples[i - 1], samples[i])
        nxt = {(c[1], c[2]): c[0] for c in cands[i]}
        for a, (lp, _) in best[i - 1].items():
            res = g.route(mode, a, list(nxt), gap * 3 + 60, prefer)
            for b, (cost, metres, path) in res.items():
                # Compare driven metres (not the discounted cost) with the shape's gap.
                p = lp - 0.5 * (nxt[b] / SIGMA) ** 2 + bonus(b[0]) - abs(metres - gap) / BETA
                if b not in best[i] or p > best[i][b][0]:
                    best[i][b] = (p, a)
                    routes[(i, a, b)] = path
        if not best[i]:                                   # break: restart from emissions
            for b, d in nxt.items():
                best[i][b] = (-0.5 * (d / SIGMA) ** 2 - 50, None)
    # Back-track, collecting matched runs.
    out, matched = [], 0
    i = len(samples) - 1
    while i >= 0 and not best[i]:
        i -= 1
    cur = max(best[i], key=lambda c: best[i][c][0]) if i >= 0 else None
    seq = []
    while i >= 0 and cur is not None:
        seq.append((i, cur))
        _, prev = best[i][cur]
        if prev is None:
            i -= 1
            while i >= 0 and not best[i]:
                i -= 1
            cur = max(best[i], key=lambda c: best[i][c][0]) if i >= 0 else None
            seq.append(None)                               # chain break
            continue
        cur, i = prev, i - 1
    seq.reverse()
    point = lambda c: (lambda u, v, *_: (g.pos[u][0] + (g.pos[v][0] - g.pos[u][0]) * c[1] / max(1e-9, g.length(mode, c[0])),
                                     g.pos[u][1] + (g.pos[v][1] - g.pos[u][1]) * c[1] / max(1e-9, g.length(mode, c[0]))))(*g.edges[mode][c[0]][:2])
    last = None
    for item in seq:
        if item is None:
            last = None
            continue
        i, c = item
        matched += 1
        if last is not None:
            for n in routes.get((i, last, c), []):
                out.append(g.pos[n])
        out.append(point(c))
        last = c
    dedup = [out[0]] if out else []
    for p in out[1:]:
        if math.dist(p, dedup[-1]) > 0.5:
            dedup.append(p)
    return remove_spikes(dedup), matched / max(1, len(samples))


def remove_spikes(pts):
    """Drop back-and-forth spikes: a matched path can start on the wrong-direction
    lane and U-turn, or briefly overshoot a junction. A point where the path turns by
    more than 150 degrees and comes back within SPIKE metres is removed (repeatedly)."""
    SPIKE = 120.0
    changed = True
    while changed and len(pts) > 2:
        changed = False
        out = [pts[0]]
        i = 1
        while i < len(pts) - 1:
            a, b, c = out[-1], pts[i], pts[i + 1]
            v1, v2 = (b[0] - a[0], b[1] - a[1]), (c[0] - b[0], c[1] - b[1])
            n1, n2 = math.hypot(*v1), math.hypot(*v2)
            if n1 > 0 and n2 > 0:
                cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)
                if cos < -0.866 and min(n1, n2) < SPIKE:     # sharper than 150 degrees: a reversal
                    changed = True
                    i += 1
                    continue
            out.append(b)
            i += 1
        out.append(pts[-1])
        pts = out
    return pts


def length(pts):
    return sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gtfs", help="static GTFS zip (default: newest in recordings*/gtfs)")
    ap.add_argument("--shapes", nargs="*", help="only these shape ids (testing)")
    args = ap.parse_args()
    gz = Path(args.gtfs) if args.gtfs else sorted(ROOT.glob("recordings*/gtfs/*.zip"))[-1]

    g = Graph()
    for f in sorted(list(OSM.glob("roads-*.json")) + list(OSM.glob("outer-*.json"))):
        for el in json.loads(f.read_text(encoding="utf-8"))["elements"]:
            if el["type"] == "way":
                g.add_way(el)
    print(f"OSM: {len(g.pos)} nodes, {len(g.edges['road'])} road edges, {len(g.edges['tram'])} tram edges", flush=True)

    # OSM route relations: (mode, line number) -> member way ids. Non-tram lines are
    # matched by number only: GTFS calls the electric bus lines trolleybuses.
    prefer_ways = defaultdict(set)
    rel_file = OSM / "routes.json"
    if rel_file.exists():
        for el in json.loads(rel_file.read_text(encoding="utf-8"))["elements"]:
            t = el.get("tags", {})
            if el["type"] != "relation" or not t.get("ref"):
                continue
            mode = "tram" if t.get("route") == "tram" else "road"
            for mbr in el.get("members", []):
                if mbr["type"] == "way" and mbr.get("role", "") in ("", "forward", "backward"):
                    prefer_ways[(mode, t["ref"].strip().upper())].add(mbr["ref"])

    zf = zipfile.ZipFile(gz)
    rd = lambda n: csv.DictReader(io.TextIOWrapper(zf.open(n), encoding="utf-8-sig"))
    kinds = {"0": "tram", "3": "road", "11": "road"}
    route_mode, route_ref = {}, {}
    for r in rd("routes.txt"):
        if r["route_type"] in kinds:
            route_mode[r["route_id"]] = kinds[r["route_type"]]
            route_ref[r["route_id"]] = r["route_short_name"].strip().upper()
    shape_mode, shape_ref = {}, {}
    for t in rd("trips.txt"):
        if t["route_id"] in route_mode:
            shape_mode[t["shape_id"]] = route_mode[t["route_id"]]
            shape_ref[t["shape_id"]] = route_ref[t["route_id"]]
    pts = defaultdict(list)
    for p in rd("shapes.txt"):
        if p["shape_id"] in shape_mode and (not args.shapes or p["shape_id"] in args.shapes):
            pts[p["shape_id"]].append((int(p["shape_pt_sequence"]), float(p["shape_pt_lat"]), float(p["shape_pt_lon"])))

    result = json.loads(OUT.read_text()) if OUT.exists() and args.shapes else {}
    report = {"kept": [], "matched": 0, "with_relation": 0}
    for k, (sid, raw) in enumerate(sorted(pts.items())):
        orig = [xy(la, lo) for _, la, lo in sorted(raw)]
        prefer = frozenset(prefer_ways.get((shape_mode[sid], shape_ref[sid]), ()))
        geom, frac = match(g, shape_mode[sid], orig, prefer)
        lo, lm = length(orig), length(geom) if len(geom) > 1 else 0
        diff = abs(lm - lo) / lo if lo else 1
        if frac >= MIN_MATCHED and diff <= MAX_LEN_DIFF:
            result[sid] = [[round(a, 6), round(b, 6)] for a, b in (ll(x, y) for x, y in geom)]
            report["matched"] += 1
            report["with_relation"] += bool(prefer)
        else:
            result.pop(sid, None)
            report["kept"].append([sid, round(frac, 2), round(diff, 2)])
        if (k + 1) % 50 == 0:
            print(f"  {k + 1}/{len(pts)} shapes", flush=True)
    OUT.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    print(f"{report['matched']} of {len(pts)} shapes matched to OSM ({report['with_relation']} guided by a route relation); "
          f"kept as GTFS: {len(report['kept'])}")
    for sid, frac, diff in report["kept"][:20]:
        print(f"  {sid}: matched {frac:.0%}, length differs {diff:.0%}")


if __name__ == "__main__":
    main()
