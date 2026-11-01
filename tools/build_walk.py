#!/usr/bin/env python3
"""Write data/walk.js: the pedestrian network of Sofia for the trip planner, from the
OpenStreetMap extracts of tools/fetch_osm_roads.py (roads-*, outer-*, walk-*).

People walk along footpaths, minor streets and the pavements of main roads. A main
road (trunk, primary, secondary, or a wide or one-way tertiary) has two sides: each
of its nodes is split into corners, one per sector between the main roads that meet
there, and walking along the road keeps to one side. Crossing a main road links two
corners of a node and is one of:

  - signal: at traffic lights,
  - marked: at a pedestrian crossing,
  - jaywalk: anywhere else (a choice in the planner), offered every ~50 m and at junctions.

Pavements mapped as separate footways replace walking along the road on that side.
Chains of nodes with two edges are merged into one edge with its shape kept.

    python3 tools/build_walk.py
"""
import glob
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OSM = ROOT / "data" / "osm"
LAT0, LON0 = 42.69, 23.32
KX, KY = 111320 * math.cos(math.radians(LAT0)), 111320.0

MAJOR = {"trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link"}
TERTIARY = {"tertiary", "tertiary_link"}
SKIP = {"motorway", "motorway_link", "construction", "proposed", "raceway", "bus_guideway", "busway", "abandoned", "platform_edge"}
FOOT_OK = {"yes", "designated", "permissive"}
WIDTH = {"trunk": 18, "trunk_link": 8, "primary": 15, "primary_link": 8, "secondary": 12, "secondary_link": 7, "tertiary": 10, "tertiary_link": 7}
JAYWALK_EVERY = 50          # m between offered mid-block crossings
STEPS = 1.6                 # steps take this many times as long as level walking
WAIT = {"signal": 25, "marked": 4, "jaywalk": 12}
F_STEPS, F_SIGNAL, F_MARKED, F_JAYWALK, F_ROADSIDE = 1, 2, 4, 8, 16


def xy(lat, lon):
    return ((lon - LON0) * KX, (lat - LAT0) * KY)


def main():
    pos, ways, crossing = {}, {}, {}
    for f in sorted(glob.glob(str(OSM / "roads-*.json")) + glob.glob(str(OSM / "outer-*.json")) + glob.glob(str(OSM / "walk-*.json"))):
        for e in json.loads(Path(f).read_text(encoding="utf-8"))["elements"]:
            t = e.get("tags", {})
            if e["type"] == "node":
                hw, cr = t.get("highway"), t.get("crossing", "")
                if cr == "no":
                    continue
                kind = ("signal" if hw == "traffic_signals" or cr == "traffic_signals" or t.get("crossing:signals") == "yes"
                        else "jaywalk" if cr == "unmarked" else "marked" if hw == "crossing" or cr else None)
                if kind:
                    crossing[e["id"]] = kind
                pos[e["id"]] = xy(e["lat"], e["lon"])
            elif e["type"] == "way" and "geometry" in e:
                for nid, g in zip(e["nodes"], e["geometry"]):
                    if g:
                        pos[nid] = xy(g["lat"], g["lon"])
                ways[e["id"]] = (e["nodes"], t)

    # Classify ways; a footway=crossing way marks its road node as a crossing.
    walk = []                                   # (nodes, cls, width, sides walkable (left, right), steps)
    for nodes, t in ways.values():
        hw = t.get("highway")
        if not hw or hw in SKIP or t.get("area") == "yes" and hw not in ("pedestrian", "footway"):
            continue
        if t.get("foot") in ("no", "private") or (t.get("access") in ("private", "no") and t.get("foot") not in FOOT_OK):
            continue
        if any(n not in pos for n in nodes):
            nodes = [n for n in nodes if n in pos]
            if len(nodes) < 2:
                continue
        if t.get("footway") == "crossing" or t.get("highway") == "footway" and t.get("crossing"):
            cr = t.get("crossing", "marked")
            kind = "signal" if cr == "traffic_signals" or t.get("crossing:signals") == "yes" else "jaywalk" if cr == "unmarked" else "marked"
            for n in nodes[1:-1]:
                crossing.setdefault(n, kind)
        try:
            lanes = int(str(t.get("lanes", "0")).split(";")[0])
        except ValueError:
            lanes = 0
        major = hw in MAJOR or (hw in TERTIARY and (lanes >= 4 or t.get("oneway") == "yes"))
        if major:
            width = max(WIDTH.get(hw, 10) * (0.55 if t.get("oneway") == "yes" else 1), lanes * 3.2 if lanes else 0)
            sw = t.get("sidewalk", "")
            both = t.get("sidewalk:both", "")
            side = lambda s: t.get(f"sidewalk:{s}") or (both or ("separate" if sw == "separate" else
                                                                   "no" if sw in ("no", "none") else
                                                                   "yes" if sw in ("both", s) else "no" if sw in ("left", "right") else ""))
            walk.append((nodes, "major", width, (side("left"), side("right")), False))
        else:
            walk.append((nodes, "minor", 0, None, hw == "steps"))

    # Incident directions per node.
    inc = defaultdict(list)                     # node -> [(angle, way index, position in way, towards node)]
    for wi, (nodes, cls, *_rest) in enumerate(walk):
        for k, n in enumerate(nodes):
            for m in (k - 1, k + 1):
                if 0 <= m < len(nodes) and nodes[m] != n:
                    a, b = pos[n], pos[nodes[m]]
                    inc[n].append((math.atan2(b[1] - a[1], b[0] - a[0]), wi, k, m))

    # Corners: sectors between the main roads meeting at each node.
    def majors_at(n):
        return sorted(x for x in inc[n] if walk[x[1]][1] == "major")

    out_nodes, corner_id = [], {}
    corner_info = {}

    def corner(n, j):
        key = (n, j)
        if key not in corner_id:
            corner_id[key] = len(out_nodes)
            ms = majors_at(n)
            x, y = pos[n]
            if len(ms) >= 2:
                a0, a1 = ms[j][0], ms[(j + 1) % len(ms)][0]
                span = (a1 - a0) % (2 * math.pi) or 2 * math.pi
                mid = a0 + span / 2
                half = max(walk[ms[j][1]][2], walk[ms[(j + 1) % len(ms)][1]][2]) / 2
                d = min(2 * half, half / max(0.2, math.sin(min(span, math.pi) / 2)))
                x, y = x + d * math.cos(mid), y + d * math.sin(mid)
            out_nodes.append((x, y))
        return corner_id[key]

    def sector(n, angle):
        ms = majors_at(n)
        if len(ms) < 2:
            return 0
        for j in range(len(ms)):
            a0, a1 = ms[j][0], ms[(j + 1) % len(ms)][0]
            if (angle - a0) % (2 * math.pi) < ((a1 - a0) % (2 * math.pi) or 2 * math.pi):
                return j
        return 0

    def major_index(n, wi, m):
        ms = majors_at(n)
        for j, x in enumerate(ms):
            if x[1] == wi and x[3] == m:
                return j, len(ms)
        return 0, len(ms)

    edges = []                                  # [a, b, length, wait, flags]

    def add(a, b, length, wait=0, flags=0):
        if a != b:
            edges.append([a, b, length, wait, flags])

    for wi, (nodes, cls, width, sides, steps) in enumerate(walk):
        for k in range(len(nodes) - 1):
            u, v = nodes[k], nodes[k + 1]
            if u == v:
                continue
            L = math.dist(pos[u], pos[v])
            if cls == "minor":
                a, b = pos[u], pos[v]
                cu = corner(u, sector(u, math.atan2(b[1] - a[1], b[0] - a[0])))
                cv = corner(v, sector(v, math.atan2(a[1] - b[1], a[0] - b[0])))
                add(cu, cv, L * (STEPS if steps else 1), 0, F_STEPS if steps else 0)
                continue
            ju, ku = major_index(u, wi, k + 1)
            jv, kv = major_index(v, wi, k)
            left, right = sides
            # Left of u->v: the sector after the edge at u, before it at v.
            for s, (cu, cv) in ((left, (ju % ku if ku >= 2 else 0, (jv - 1) % kv if kv >= 2 else 0)),
                                (right, ((ju - 1) % ku if ku >= 2 else 0, jv % kv if kv >= 2 else 0))):
                if s == "separate":
                    continue
                add(corner(u, cu), corner(v, cv), L * (1.4 if s == "no" else 1), 0, F_ROADSIDE if s == "no" else 0)

    # Crossings of main roads at nodes.
    for wi, (nodes, cls, width, *_r) in enumerate(walk):
        if cls != "major":
            continue
        since = JAYWALK_EVERY
        for k, n in enumerate(nodes):
            if k:
                since += math.dist(pos[nodes[k - 1]], pos[n])
            ms = majors_at(n)
            if len(ms) < 2:
                continue
            kind = crossing.get(n)
            junction = len(inc[n]) > 2
            if not kind:
                if since < JAYWALK_EVERY and not junction:
                    continue
                kind = "jaywalk"
            since = 0
            for m in (k - 1, k + 1):
                if not 0 <= m < len(nodes):
                    continue
                j, cnt = major_index(n, wi, m)
                a, b = corner(n, (j - 1) % cnt), corner(n, j)
                flag = {"signal": F_SIGNAL, "marked": F_MARKED, "jaywalk": F_JAYWALK}[kind]
                add(a, b, width, WAIT[kind], flag)

    # Merge duplicate edges, keep the cheapest.
    best = {}
    for a, b, L, w, f in edges:
        key = (min(a, b), max(a, b), f & (F_JAYWALK | F_SIGNAL | F_MARKED))
        if key not in best or L + w * 1.3 < best[key][2] + best[key][3] * 1.3:
            best[key] = [a, b, L, w, f]
    edges = list(best.values())

    # Merge chains of two-edge nodes.
    adj = defaultdict(list)
    for i, e in enumerate(edges):
        adj[e[0]].append(i)
        adj[e[1]].append(i)
    dead = set()
    shape = {i: [] for i in range(len(edges))}     # intermediate node ids, from e[0] to e[1]
    for n in range(len(out_nodes)):
        live = [i for i in adj[n] if i not in dead]
        if len(live) != 2 or live[0] == live[1]:
            continue
        i, j = live
        ei, ej = edges[i], edges[j]
        if (ei[4] ^ ej[4]) & (F_JAYWALK | F_SIGNAL | F_MARKED):
            continue                                # keep crossing kinds apart
        # Orient i to end at n and j to start at n.
        si = shape[i] if ei[1] == n else shape[i][::-1]
        if ei[1] != n:
            ei[0], ei[1] = ei[1], ei[0]
        sj = shape[j] if ej[0] == n else shape[j][::-1]
        if ej[0] != n:
            ej[0], ej[1] = ej[1], ej[0]
        if ei[0] == ej[1]:
            continue                                # a loop: leave it
        ei[1] = ej[1]
        ei[2] += ej[2]; ei[3] += ej[3]; ei[4] |= ej[4]
        shape[i] = si + [n] + sj
        dead.add(j)
        adj[ej[1]] = [i if x == j else x for x in adj[ej[1]]]
        adj[n] = []

    # Renumber the nodes still used and write compact arrays.
    keep = [i for i in range(len(edges)) if i not in dead]
    used = {}
    for i in keep:
        for n in edges[i][:2]:
            used.setdefault(n, len(used))
    nodes_out = []
    for n, _ in sorted(used.items(), key=lambda x: x[1]):
        nodes_out += [round(out_nodes[n][0]), round(out_nodes[n][1])]
    flat, geo, starts = [], [], []
    for i in keep:
        a, b, L, w, f = edges[i]
        flat += [used[a], used[b], round(L), round(w), f]
        starts.append(len(geo) // 2)
        prev = out_nodes[a]
        for n in shape[i]:
            x, y = out_nodes[n]
            geo += [round(x - prev[0]), round(y - prev[1])]
            prev = (prev[0] + round(x - prev[0]), prev[1] + round(y - prev[1]))
    starts.append(len(geo) // 2)

    data = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "origin": [LAT0, LON0],
        "nodes": nodes_out,          # x, y in metres from the origin
        "edges": flat,               # a, b, length (m, steps counted longer), wait (s), flags
        "geoStart": starts,          # edge i's intermediate points are geo[geoStart[i] .. geoStart[i+1]) (pairs)
        "geo": geo,                  # points as deltas from the previous point, starting at node a
        "flags": {"steps": F_STEPS, "signal": F_SIGNAL, "marked": F_MARKED, "jaywalk": F_JAYWALK, "roadside": F_ROADSIDE},
    }
    out = ROOT / "data" / "walk.js"
    out.write_text("window.WALK_DATA = " + json.dumps(data, separators=(",", ":")) + ";\n", encoding="utf-8")
    n_j = sum(1 for i in keep if edges[i][4] & F_JAYWALK)
    n_c = sum(1 for i in keep if edges[i][4] & (F_SIGNAL | F_MARKED))
    print(f"{len(used)} nodes, {len(keep)} edges ({n_c} crossings, {n_j} jaywalk crossings), {len(geo) // 2} shape points")
    print(f"Wrote {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
