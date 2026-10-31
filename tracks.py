"""Metro track network from OpenStreetMap, and switch-aware train routing over it.

The graph is built from OSM ways tagged railway=subway. Trains are routed with a
Dijkstra search over (node, came-from, facing) states: at each node a train may
only continue onto a track within MAX_TURN degrees of its heading (so it follows
switches realistically), and may reverse only where the caller allows it.
"""
import heapq
import json
import math
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# Recently opened sections may still be tagged as under construction in OSM.
OSM_QUERY = ('[out:json][timeout:180];('
             'way["railway"="subway"](42.58,23.18,42.80,23.46);'
             'way["railway"="construction"]["construction"="subway"](42.58,23.18,42.80,23.46);'
             'way["railway"="construction"]["construction:railway"="subway"](42.58,23.18,42.80,23.46);'
             ');out geom tags;')


def is_metro_track(tags):
    if tags.get("railway") == "subway":
        return True
    return tags.get("railway") == "construction" and "subway" in (tags.get("construction"), tags.get("construction:railway"))

MAX_TURN = 60                                  # degrees a train may turn at a node
COS_TURN = math.cos(math.radians(MAX_TURN))
NON_REVENUE = {"yard", "spur"}                 # never used by passenger trips or turnbacks


def fetch_osm(cache: Path, refresh: bool):
    if cache.exists() and not refresh:
        return json.loads(cache.read_text(encoding="utf-8"))
    body = urllib.parse.urlencode({"data": OSM_QUERY}).encode()
    for url in OVERPASS_MIRRORS:
        try:
            print(f"Fetching OSM tracks from {url} ...")
            req = urllib.request.Request(url, data=body, headers={"User-Agent": "sofiametro-sim/1.0"})
            with urllib.request.urlopen(req, timeout=90) as r:
                data = json.loads(r.read())
            cache.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return data
        except Exception as e:  # try the next mirror
            print(f"  failed: {e}")
    if cache.exists():
        print("Using cached OSM tracks.")
        return json.loads(cache.read_text(encoding="utf-8"))
    raise SystemExit("Could not download OSM track data and no cache exists.")


class Graph:
    def __init__(self, lat0):
        self.lat0 = lat0
        self.kx = 111_320.0 * math.cos(math.radians(lat0))
        self.ky = 111_320.0
        self.ll = []          # [(lat, lon)]
        self.xy = []          # [(x, y)] metres
        self.adj = []         # [{neighbour: service}]
        self.vmax = {}        # (a, b) with a < b -> OSM maxspeed in km/h, if tagged
        self.key = {}

    # ---- construction ----
    def node(self, lat, lon):
        k = (round(lat, 7), round(lon, 7))
        if k not in self.key:
            self.key[k] = len(self.ll)
            self.ll.append((lat, lon))
            self.xy.append((lon * self.kx, lat * self.ky))
            self.adj.append({})
        return self.key[k]

    def node_xy(self, x, y):
        return self.node(y / self.ky, x / self.kx)

    def edge(self, a, b, svc, vmax=None):
        if a != b:
            self.adj[a][b] = svc
            self.adj[b][a] = svc
            if vmax:
                self.vmax[(min(a, b), max(a, b))] = vmax

    def speed_limit(self, a, b):
        return self.vmax.get((min(a, b), max(a, b)))

    def split(self, a, b, t):
        """Insert a node at fraction t along edge a-b and return it."""
        if t <= 0.001:
            return a
        if t >= 0.999:
            return b
        (x1, y1), (x2, y2) = self.xy[a], self.xy[b]
        svc = self.adj[a].pop(b)
        del self.adj[b][a]
        vmax = self.vmax.pop((min(a, b), max(a, b)), None)
        n = self.node_xy(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
        self.edge(a, n, svc, vmax)
        self.edge(n, b, svc, vmax)
        return n

    def dist(self, a, b):
        (x1, y1), (x2, y2) = self.xy[a], self.xy[b]
        return math.hypot(x2 - x1, y2 - y1)

    def unit(self, a, b):
        (x1, y1), (x2, y2) = self.xy[a], self.xy[b]
        d = math.hypot(x2 - x1, y2 - y1) or 1.0
        return ((x2 - x1) / d, (y2 - y1) / d)

    def densify(self, centres, radius, step):
        """Split edges near the given (x, y) points into pieces <= step metres.
        Trains can only reverse at nodes, so this lets them reverse just after
        clearing a switch instead of at the next (possibly distant) OSM node."""
        def near(v):
            x, y = self.xy[v]
            return any(math.hypot(x - cx, y - cy) < radius for cx, cy in centres)

        for a, b, svc in list(self.edges()):
            L = self.dist(a, b)
            if L <= step or not (near(a) or near(b) or svc == "yard"):
                continue
            k = int(math.ceil(L / step))
            prev = a
            for i in range(1, k):
                # split the remaining edge prev-b at the right fraction
                prev = self.split(prev, b, 1.0 / (k - i + 1))

    def edges(self):
        for a, nb in enumerate(self.adj):
            for b, svc in nb.items():
                if a < b:
                    yield a, b, svc

    def project(self, x, y, max_d, ok=lambda svc: True):
        """Nearest point on each edge within max_d: [(d, a, b, t, px, py)] sorted by distance."""
        out = []
        for a, b, svc in self.edges():
            if not ok(svc):
                continue
            (x1, y1), (x2, y2) = self.xy[a], self.xy[b]
            if min(x1, x2) - max_d > x or max(x1, x2) + max_d < x or min(y1, y2) - max_d > y or max(y1, y2) + max_d < y:
                continue
            dx, dy = x2 - x1, y2 - y1
            L2 = dx * dx + dy * dy
            t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
            px, py = x1 + t * dx, y1 + t * dy
            d = math.hypot(px - x, py - y)
            if d <= max_d:
                out.append((d, a, b, t, px, py))
        out.sort()
        return out

    def components(self):
        comp = [-1] * len(self.adj)
        c = 0
        for s in range(len(self.adj)):
            if comp[s] >= 0 or not self.adj[s]:
                continue
            stack = [s]
            comp[s] = c
            while stack:
                v = stack.pop()
                for w in self.adj[v]:
                    if comp[w] < 0:
                        comp[w] = c
                        stack.append(w)
            c += 1
        return comp

    # ---- routing ----
    def route(self, start, goal, *, h_start=None, h_goal=None, max_rev=0, rev_cost=60.0,
              allow=lambda svc: svc not in NON_REVENUE, penalty=None, goal_any=None, max_len=1e9):
        """Shortest switch-feasible path.

        start/h_start: start node and unit heading (None = any direction).
        goal/h_goal:   goal node and heading the train must be facing on arrival
                       (None = any). goal_any: alternatively a set of goal nodes.
        Returns (node list, [indices in the list where the train reverses]) or None.
        """
        goals = goal_any if goal_any is not None else {goal}
        # State (v, u, nrev): at node v having arrived from u, heading u -> v.
        # A reversal at v means backing out along the same track, i.e. moving
        # back to u. Trains therefore can't swing from one switch branch onto
        # the other: to change track they must clear the switch, reverse, and
        # take it from the other side.
        INF = float("inf")
        best = {}
        prev = {}
        heap = []

        def is_goal(v, h):
            if v not in goals:
                return False
            return h_goal is None or h[0] * h_goal[0] + h[1] * h_goal[1] > 0

        def push(cost, st, parent):
            if cost < best.get(st, INF):
                best[st] = cost
                prev[st] = parent
                heapq.heappush(heap, (cost, st))

        def edge_cost(v, w):
            return self.dist(v, w) * (penalty(self.adj[v][w]) if penalty else 1.0)

        def expand_from(v, h, cost, nrev, parent):
            for w, svc in self.adj[v].items():
                if not allow(svc):
                    continue
                u = self.unit(v, w)
                if h is not None and h[0] * u[0] + h[1] * u[1] < COS_TURN:
                    continue
                push(cost + edge_cost(v, w), (w, v, nrev), parent)

        # Start state(s).
        if start in goals and (h_goal is None or (h_start is not None and h_start[0] * h_goal[0] + h_start[1] * h_goal[1] > 0)):
            return [start], []
        expand_from(start, h_start, 0.0, 0, None)
        if max_rev > 0 and h_start is not None:
            back = (-h_start[0], -h_start[1])
            if start in goals and (h_goal is None or back[0] * h_goal[0] + back[1] * h_goal[1] > 0):
                return [start], [0]
            expand_from(start, back, rev_cost, 1, "REV0")

        found = None
        while heap:
            cost, st = heapq.heappop(heap)
            if cost > best.get(st, INF) or cost > max_len:
                continue
            v, u, nrev = st
            h = self.unit(u, v)
            if is_goal(v, h):
                found = st
                break
            expand_from(v, h, cost, nrev, st)
            if nrev < max_rev and allow(self.adj[v][u]):
                push(cost + rev_cost + edge_cost(v, u), (u, v, nrev + 1), st)
        if found is None:
            return None

        # Reconstruct.
        chain = []
        st = found
        while st is not None and st != "REV0":
            chain.append(st)
            st = prev[st]
        chain.reverse()
        nodes, revs = [start], []
        if st == "REV0":
            revs.append(0)
        for i, (v, u, nrev) in enumerate(chain):
            if i > 0 and chain[i - 1][2] < nrev:      # backed out: reversal at previous node
                revs.append(len(nodes) - 1)
            nodes.append(v)
        return nodes, revs

    def path_len(self, nodes):
        return sum(self.dist(a, b) for a, b in zip(nodes, nodes[1:]))


def build_graph(osm, lat0):
    g = Graph(lat0)
    for w in osm["elements"]:
        if w.get("type") != "way" or not is_metro_track(w.get("tags", {})):
            continue
        svc = w["tags"].get("service") or "main"
        try:
            vmax = int(w["tags"].get("maxspeed", "").split()[0])
        except (ValueError, IndexError):
            vmax = None
        geom = w["geometry"]
        ids = [g.node(p["lat"], p["lon"]) for p in geom]
        for a, b in zip(ids, ids[1:]):
            g.edge(a, b, svc, vmax)

    # Bridge small fragments (missing switch connections in OSM) to the nearest track.
    comp = g.components()
    sizes = defaultdict(int)
    for c in comp:
        if c >= 0:
            sizes[c] += 1
    for c, n in sizes.items():
        if n > 150:
            continue
        mine = [v for v in range(len(comp)) if comp[v] == c]
        best = None
        for v in mine:
            x, y = g.xy[v]
            for w in range(len(comp)):
                if comp[w] >= 0 and comp[w] != c:
                    d = math.hypot(g.xy[w][0] - x, g.xy[w][1] - y)
                    if d < 20 and (best is None or d < best[0]):
                        best = (d, v, w)
        if best:
            svc = next(iter(g.adj[best[1]].values()))
            g.edge(best[1], best[2], svc)
            print(f"  bridged OSM fragment of {n} nodes ({best[0]:.1f} m gap)")
    return g


def resample(xy_pts, step):
    out = [xy_pts[0]]
    carry = 0.0
    for (x1, y1), (x2, y2) in zip(xy_pts, xy_pts[1:]):
        L = math.hypot(x2 - x1, y2 - y1)
        d = step - carry
        while d < L:
            out.append((x1 + (x2 - x1) * d / L, y1 + (y2 - y1) * d / L))
            d += step
        carry = L - (d - step)
    if math.hypot(out[-1][0] - xy_pts[-1][0], out[-1][1] - xy_pts[-1][1]) > 1:
        out.append(xy_pts[-1])
    return out


def extend_missing(g, name, shape_ll, stop_ll, half_gap=2.0, tail=200.0, gap_thresh=35.0):
    """Synthesise double track where a line's GTFS shape runs beyond mapped OSM track
    (e.g. a newly opened extension). Adds a scissors crossover and tail tracks past the
    final station so trains can reverse there."""
    pts = [(lon * g.kx, lat * g.ky) for lat, lon in shape_ll]
    pts = resample(pts, 10.0)
    covered = [bool(g.project(x, y, gap_thresh, lambda s: s == "main")) for x, y in pts]
    for at_end in (True, False):
        seq = pts if at_end else pts[::-1]
        cov = covered if at_end else covered[::-1]
        if cov[-1]:
            continue
        i0 = len(seq) - 1
        while i0 > 0 and not cov[i0 - 1]:
            i0 -= 1
        if i0 == 0 or (len(seq) - i0) * 10 < 300:   # ignore shapes overshooting a mapped end
            continue
        # Section seq[i0-1 .. end] is unmapped. Extend past the terminal station.
        tx, ty = (stop_ll[-1][1] * g.kx, stop_ll[-1][0] * g.ky) if at_end else (stop_ll[0][1] * g.kx, stop_ll[0][0] * g.ky)
        sec = seq[i0 - 1:]
        # trim / extend so the section ends `tail` metres beyond the terminus
        ex, ey = sec[-1]
        px, py = sec[-2]
        L = math.hypot(ex - px, ey - py) or 1
        ux, uy = (ex - px) / L, (ey - py) / L
        beyond = (ex - tx) * ux + (ey - ty) * uy
        k = 1
        while beyond + k * 10 <= tail:
            sec.append((ex + ux * 10 * k, ey + uy * 10 * k))
            k += 1
        tracks = {}
        for side in (+1, -1):
            line = []
            for i, (x, y) in enumerate(sec):
                a = sec[max(0, i - 1)]
                b = sec[min(len(sec) - 1, i + 1)]
                dx, dy = b[0] - a[0], b[1] - a[1]
                d = math.hypot(dx, dy) or 1
                rx, ry = dy / d, -dx / d          # right-hand normal
                line.append(g.node_xy(x + rx * half_gap * side, y + ry * half_gap * side))
            # Join to the end of the mapped track on the same side.
            sx, sy = sec[0]
            cands = [v for v in range(len(g.adj)) if len(g.adj[v]) == 1 and v not in line
                     and math.hypot(g.xy[v][0] - sx, g.xy[v][1] - sy) < 250]
            a, b = sec[0], sec[1]
            dx, dy = b[0] - a[0], b[1] - a[1]
            d = math.hypot(dx, dy) or 1
            rx, ry = dy / d, -dx / d
            same = [v for v in cands if ((g.xy[v][0] - sx) * rx + (g.xy[v][1] - sy) * ry) * side > 0]
            if same:
                join = min(same, key=lambda v: math.hypot(g.xy[v][0] - sx, g.xy[v][1] - sy))
                g.edge(join, line[0], "main")
            for p, q in zip(line, line[1:]):
                g.edge(p, q, "main")
            tracks[side] = line
        # Scissors crossover ~40-70 m past the terminus.
        n = len(sec)
        i_term = min(range(n), key=lambda i: math.hypot(sec[i][0] - tx, sec[i][1] - ty))
        i1, i2 = min(n - 2, i_term + 4), min(n - 1, i_term + 7)
        g.edge(tracks[1][i1], tracks[-1][i2], "crossover")
        g.edge(tracks[-1][i1], tracks[1][i2], "crossover")
        print(f"  {name}: synthesised {len(sec) * 10 / 1000:.1f} km of double track missing from OSM")


def display_offsets(g):
    """For each node on a double-track section: unit vector away from the parallel
    track and half the track spacing. The map exaggerates this so both tracks are
    visible at street zoom levels."""
    out = [(0.0, 0.0, 0.0)] * len(g.adj)
    for v, nb in enumerate(g.adj):
        if not nb or any(s in NON_REVENUE for s in nb.values()):
            continue
        # Local track direction at v.
        ds = [g.unit(v, w) for w in nb]
        tx, ty = ds[0]
        x, y = g.xy[v]
        best = None
        for d, a, b, t, px, py in g.project(x, y, 7.0, lambda s: s not in NON_REVENUE and s != "crossover"):
            if v in (a, b) or a in nb or b in nb:
                continue
            ux, uy = g.unit(a, b)
            if abs(ux * tx + uy * ty) < 0.9 or d < 1.0:
                continue
            best = (d, px, py)
            break
        if best:
            d, px, py = best
            out[v] = ((x - px) / d, (y - py) / d, d / 2)
    return out
