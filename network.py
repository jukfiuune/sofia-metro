"""Map the GTFS timetable onto the OSM track graph.

Produces, for the web app:
  * platform nodes for every station (one per track, trains keep right),
  * a track path for every trip pattern,
  * turnback paths (one reversal) for every consecutive pair of trips in a run,
  * depot in/out paths to yard stabling tracks, and stabling-siding paths,
  * track polylines for drawing, with display offsets for double track.
"""
import math
from collections import defaultdict

from tracks import NON_REVENUE

TAIL_SEARCH = 1500.0     # m (+ reversal cost) within which a tail-track turnback must exist
YARD_RADIUS = 800.0      # m from the depot centre to look for stabling tracks
STABLE_SEARCH = 900.0    # m to look for a siding / tail to stable a train overnight


def _revenue(svc):
    return svc not in NON_REVENUE


def _turn_allow(svc):
    return svc != "yard"


def _turn_penalty(svc):
    return 1.5 if svc == "spur" else 1.0


def _trip_penalty(svc):
    return 4.0 if svc == "crossover" else (3.0 if svc == "siding" else 1.0)


class Network:
    def __init__(self, g, stops, lat0):
        self.g = g
        self.stops = stops
        self.paths = []          # list of (nodes, reversal indices)
        self.path_index = {}
        self.platforms = {}      # stop_id -> [node, ...]
        self.warnings = []

    def stop_xy(self, sid):
        s = self.stops[sid]
        return float(s["stop_lon"]) * self.g.kx, float(s["stop_lat"]) * self.g.ky

    def add_path(self, nodes, revs):
        key = (tuple(nodes), tuple(revs))
        if key not in self.path_index:
            self.path_index[key] = len(self.paths)
            self.paths.append((list(nodes), list(revs)))
        return self.path_index[key]

    # ---- platforms ----
    def place_platforms(self, stop_ids):
        g = self.g
        for sid in sorted(stop_ids):
            x, y = self.stop_xy(sid)
            cands = g.project(x, y, 90.0, lambda s: s == "main")
            if not cands:
                self.warnings.append(f"no track near stop {sid}")
                continue
            c1 = cands[0]
            u1 = g.unit(c1[1], c1[2])
            c2 = None
            for c in cands[1:]:
                # Must be a different, parallel track: offset sideways from c1's track.
                lateral = abs((c[4] - c1[4]) * u1[1] - (c[5] - c1[5]) * u1[0])
                if lateral < 2.5:
                    continue
                u = g.unit(c[1], c[2])
                if abs(u[0] * u1[0] + u[1] * u1[1]) > 0.85:
                    c2 = c
                    break
            nodes = [g.split(c1[1], c1[2], c1[3])]
            if c2:
                # c2's edge may have been split by c1 if it was the same edge: re-project.
                again = [c for c in g.project(c2[4], c2[5], 0.5, lambda s: s == "main") if nodes[0] not in (c[1], c[2]) or c[0] < 0.01]
                if again:
                    nodes.append(g.split(again[0][1], again[0][2], again[0][3]))
            self.platforms[sid] = nodes

    def tangent(self, node, d):
        """Track tangent at a platform node, oriented along direction vector d."""
        g = self.g
        best = None
        for w, svc in g.adj[node].items():
            if svc != "main":
                continue
            u = g.unit(node, w)
            dot = u[0] * d[0] + u[1] * d[1]
            if best is None or dot > best[0]:
                best = (dot, u)
        return best[1] if best else d

    def platform_for(self, sid, d, keep_right=True):
        """(node, heading) of the platform used when travelling in direction d."""
        nodes = self.platforms.get(sid)
        if not nodes:
            return None
        if len(nodes) == 1:
            return nodes[0], self.tangent(nodes[0], d)
        (ax, ay), (bx, by) = self.g.xy[nodes[0]], self.g.xy[nodes[1]]
        cx, cy = (ax + bx) / 2, (ay + by) / 2
        rx, ry = d[1], -d[0]                      # right of travel direction
        right = nodes[0] if (ax - cx) * rx + (ay - cy) * ry > 0 else nodes[1]
        left = nodes[1] if right == nodes[0] else nodes[0]
        n = right if keep_right else left
        return n, self.tangent(n, d)

    # ---- patterns ----
    def direction(self, stops, i):
        a = self.stop_xy(stops[max(0, i - 1)])
        b = self.stop_xy(stops[min(len(stops) - 1, i + 1)])
        dx, dy = b[0] - a[0], b[1] - a[1]
        d = math.hypot(dx, dy) or 1
        return dx / d, dy / d

    def route_pattern(self, stops, line_ends=frozenset()):
        """Returns (path index, stop distances, start state, end state, crossover_arrival)."""
        g = self.g
        n = len(stops)
        plats = []
        for i, sid in enumerate(stops):
            d = self.direction(stops, i)
            p = self.platform_for(sid, d)
            if p is None:
                return None
            plats.append(p)
        # At a line end where trains can't reverse beyond the station onto the other
        # platform (no tail tracks + crossover there), they cross over before it and
        # arrive directly on the departure track (Airport, Business Park). Short
        # trips ending mid-line always reverse beyond the station (e.g. Mladost 1).
        crossover = False
        end_node, end_h = plats[-1]
        if stops[-1] in line_ends and len(self.platforms.get(stops[-1], [])) == 2:
            d = self.direction(stops, n - 1)
            other, other_h = self.platform_for(stops[-1], d, keep_right=False)
            tail = g.route(end_node, other, h_start=end_h, h_goal=(-other_h[0], -other_h[1]), max_rev=1,
                           allow=_turn_allow, penalty=_turn_penalty, max_len=TAIL_SEARCH)
            if tail is None and n >= 2:
                # Only if there is a crossover on the approach to switch tracks with.
                prev_node, prev_h = plats[-2]
                if g.route(prev_node, other, h_start=prev_h, h_goal=other_h, penalty=_trip_penalty) is not None:
                    plats[-1] = (other, other_h)
                    crossover = True
        nodes, dists = [plats[0][0]], [0.0]
        total = 0.0
        for i in range(n - 1):
            (a, ha), (b, hb) = plats[i], plats[i + 1]
            r = g.route(a, b, h_start=ha, h_goal=hb, penalty=_trip_penalty)
            if r is None:
                r = g.route(a, b, h_start=ha, h_goal=hb, penalty=_trip_penalty, allow=lambda s: True)
            if r is None:
                self.warnings.append(f"no track path {stops[i]} -> {stops[i + 1]}")
                seg = [a, b]
            else:
                seg = r[0]
            for p, q in zip(seg, seg[1:]):
                total += g.dist(p, q)
                nodes.append(q)
            dists.append(round(total, 1))
        return self.add_path(nodes, []), dists, plats[0], plats[-1], crossover

    # ---- non-revenue moves ----
    def turnback(self, end, start):
        """Path from an arrival platform state to a departure platform state, one reversal."""
        g = self.g
        (a, ha), (b, hb) = end, start
        r = g.route(a, b, h_start=ha, h_goal=hb, max_rev=1, rev_cost=40.0,
                    allow=_turn_allow, penalty=_turn_penalty)
        if r is None:
            r = g.route(a, b, h_start=ha, h_goal=hb, max_rev=3, rev_cost=40.0, allow=lambda s: True)
        if r is None:
            self.warnings.append(f"no turnback path {a} -> {b}")
            return self.add_path([a, b], [])
        return self.add_path(*r)

    def depot_slots(self, depot):
        """Stabling tracks of a depot yard: [(dead-end node, metres of plain track before the first switch)]."""
        g = self.g
        cx, cy = depot["lon"] * g.kx, depot["lat"] * g.ky
        ends = [v for v, nb in enumerate(g.adj)
                if len(nb) == 1 and all(s == "yard" for s in nb.values())
                and math.hypot(g.xy[v][0] - cx, g.xy[v][1] - cy) < YARD_RADIUS]
        ends.sort(key=lambda v: (g.xy[v][0], g.xy[v][1]))
        out = []
        for e in ends:
            prev, v, length = None, e, 0.0
            while True:
                w = next(w for w in g.adj[v] if w != prev)
                length += g.dist(v, w)
                prev, v = v, w
                if len(g.adj[v]) != 2:
                    break
            out.append((e, length))
        return out

    def to_depot(self, end, slot):
        a, ha = end
        r = self.g.route(a, None, h_start=ha, goal_any={slot}, max_rev=3, rev_cost=60.0, allow=lambda s: True)
        return None if r is None else self.add_path(*r)

    def from_depot(self, slot, start):
        b, hb = start
        r = self.g.route(slot, b, h_goal=hb, max_rev=3, rev_cost=60.0, allow=lambda s: True)
        return None if r is None else self.add_path(*r)

    def stable_spots(self):
        g = self.g
        return {v for v, nb in enumerate(g.adj)
                if len(nb) == 1 and all(_turn_allow(s) and s != "spur" for s in nb.values())}

    def to_stable(self, end, spots):
        a, ha = end
        r = self.g.route(a, None, h_start=ha, goal_any=spots, max_rev=2, rev_cost=60.0,
                         allow=_turn_allow, max_len=STABLE_SEARCH)
        return self.add_path(*r) if r else self.add_path([a], [])

    def from_stable(self, start, spots):
        b, hb = start
        # Search backwards: from the platform facing away from the departure direction.
        r = self.g.route(b, None, h_start=(-hb[0], -hb[1]), goal_any=spots, max_rev=2, rev_cost=60.0,
                         allow=_turn_allow, max_len=STABLE_SEARCH)
        if not r:
            return self.add_path([b], [])
        nodes, revs = r
        nodes = nodes[::-1]
        revs = [len(nodes) - 1 - i for i in revs][::-1]
        return self.add_path(nodes, revs)

    # ---- export ----
    def track_lines(self, route_edges):
        """Merge graph edges into polylines of uniform (service, routes)."""
        g = self.g

        def label(a, b):
            svc = g.adj[a][b]
            rs = route_edges.get((min(a, b), max(a, b)), ())
            return svc, tuple(sorted(rs))

        used = set()
        lines = []
        for a, b, _ in g.edges():
            if (a, b) in used:
                continue
            lab = label(a, b)
            chain = [a, b]
            used.add((a, b))
            for forward in (True, False):
                while True:
                    end = chain[-1] if forward else chain[0]
                    prev = chain[-2] if forward else chain[1]
                    nb = [w for w in g.adj[end] if w != prev]
                    if len(g.adj[end]) != 2 or len(nb) != 1:
                        break
                    w = nb[0]
                    key = (min(end, w), max(end, w))
                    if key in used or label(end, w) != lab:
                        break
                    used.add(key)
                    if forward:
                        chain.append(w)
                    else:
                        chain.insert(0, w)
            lines.append({"n": chain, "s": lab[0], "r": list(lab[1])})
        return lines
