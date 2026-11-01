"""Timetable-fitted speed profiles for trains running between stations.

For each station-to-station run the train accelerates, cruises below the local
speed limit and brakes into the next platform. Speed limits along the track come
from OSM maxspeed tags (M1/M2/M4), curve radius (all lines; M3 has no tags),
crossovers and the system maximum. The cruise cap is then lowered until the run
takes exactly the scheduled time, as drivers / ATO do when there is slack.

Sources: Sofia Metro maximum permitted speed 80 km/h, average 39 km/h
(bg.wikipedia.org/wiki/Софийско_метро); 81-740/741 "Rusich" acceleration
1.3 m/s², deceleration 1.1 m/s² (en.wikipedia.org/wiki/81-740/741); Siemens
Inspiro Sofia max operating speed 80 km/h (Siemens data sheet).
"""
import math

V_MAX = 80 / 3.6          # m/s, system maximum
ACCEL = 1.0               # m/s², service acceleration (averaged over the speed range)
BRAKE = 1.0               # m/s², service braking
COAST = 0.06              # m/s², deceleration while coasting (rolling + air resistance)
REPOWER = 0.85            # re-apply power when coasting speed drops below this share of the cap
A_LAT = 0.8               # m/s², allowed lateral acceleration in curves (with cant)
CROSSOVER_V = 40 / 3.6    # m/s through crossovers / onto sidings
DWELL = 25                # s, preferred stop at intermediate stations
MIN_DWELL = 8             # s, shortest stop when the timetable is tight
STEP = 5.0                # m, grid for the speed profile
SAMPLE = 2                # s, exported time resolution of a profile
CHORD = 30.0              # m, half-chord for measuring curve radius


def _path_geometry(g, nodes):
    cum = [0.0]
    for a, b in zip(nodes, nodes[1:]):
        cum.append(cum[-1] + g.dist(a, b))
    return cum


def _point(g, nodes, cum, s):
    s = max(0.0, min(cum[-1], s))
    lo, hi = 0, len(cum) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if cum[mid] <= s:
            lo = mid
        else:
            hi = mid
    seg = cum[hi] - cum[lo]
    t = (s - cum[lo]) / seg if seg > 0 else 0.0
    (x1, y1), (x2, y2) = g.xy[nodes[lo]], g.xy[nodes[hi]]
    return x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, lo


def _radius(p, q, r):
    a = math.dist(p, q)
    b = math.dist(q, r)
    c = math.dist(p, r)
    area2 = abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
    return float("inf") if area2 < 1e-6 else a * b * c / (2 * area2)


def speed_limits(g, nodes, cum, s0, s1):
    """Speed limit (m/s) at grid points from s0 to s1 along a path."""
    n = max(1, int(math.ceil((s1 - s0) / STEP)))
    out = []
    for k in range(n + 1):
        s = s0 + (s1 - s0) * k / n
        x, y, i = _point(g, nodes, cum, s)
        a, b = nodes[i], nodes[min(i + 1, len(nodes) - 1)]
        lim = V_MAX
        tag = g.speed_limit(a, b) if a != b else None
        if tag:
            lim = min(lim, tag / 3.6)
        if a != b and g.adj[a].get(b) in ("crossover", "siding"):
            lim = min(lim, CROSSOVER_V)
        p = _point(g, nodes, cum, s - CHORD)[:2]
        r = _point(g, nodes, cum, s + CHORD)[:2]
        lim = min(lim, math.sqrt(A_LAT * _radius(p, (x, y), r)))
        out.append(lim)
    return out, (s1 - s0) / n


def _run(vlim, dx, cap):
    """Velocity at each grid point and total time, for a target speed `cap`.
    The train powers up to the cap, then coasts, re-powering when it has slowed
    to REPOWER * cap; local speed limits are never exceeded."""
    n = len(vlim)
    tgt = [min(v, cap) for v in vlim]
    vf = [0.0] * n
    coasting = False
    for k in range(1, n):
        prev = vf[k - 1]
        if coasting:
            v = math.sqrt(max(prev * prev - 2 * COAST * dx, 0.0))
            if v < REPOWER * cap:
                coasting = False
        else:
            v = math.sqrt(prev * prev + 2 * ACCEL * dx)
            if v >= cap:
                v, coasting = cap, True
        vf[k] = min(tgt[k], v)
    vb = [0.0] * n
    for k in range(n - 2, -1, -1):
        vb[k] = min(tgt[k], math.sqrt(vb[k + 1] ** 2 + 2 * BRAKE * dx))
    v = [min(a, b) for a, b in zip(vf, vb)]
    v[0] = v[-1] = 0.0
    t = [0.0]
    for k in range(1, n):
        avg = (v[k - 1] + v[k]) / 2
        t.append(t[-1] + (dx / avg if avg > 1e-6 else math.sqrt(2 * dx / ACCEL)))
    return v, t


def min_time(vlim, dx):
    return _run(vlim, dx, V_MAX)[1][-1]


def fit(vlim, dx, T):
    """Grid times for a run lasting exactly T seconds."""
    v, t = _run(vlim, dx, V_MAX)
    if t[-1] >= T:                      # timetable tighter than our physics: compress
        f = T / t[-1]
        return [x * f for x in t]
    lo, hi = 0.3, V_MAX
    for _ in range(25):
        mid = (lo + hi) / 2
        if _run(vlim, dx, mid)[1][-1] > T:
            lo = mid
        else:
            hi = mid
    t = _run(vlim, dx, hi)[1]
    f = T / t[-1]
    return [x * f for x in t]


def sample(t, dx, T):
    """Distance from the run start every SAMPLE seconds (excluding 0 and T)."""
    out, k = [], 0
    tau = SAMPLE
    while tau < T - 1e-6:
        while k < len(t) - 2 and t[k + 1] < tau:
            k += 1
        seg = t[k + 1] - t[k]
        f = (tau - t[k]) / seg if seg > 0 else 0.0
        out.append(round((k + f) * dx, 1))
        tau += SAMPLE
    return out


def add_profiles(g, paths, patterns):
    """Give each pattern per-stop dwell times ("dw") and per-run profile ids ("pf").
    Returns the deduplicated profile list: [run seconds, d@2s, d@4s, ...]."""
    profiles, index = [], {}
    limits_cache, fit_cache = {}, {}
    for p in patterns:
        nodes = paths[p["path"]][0]
        cum = _path_geometry(g, nodes)
        pd, arr = p["pd"], p["arr"]
        n = len(pd)
        segs = []
        for i in range(n - 1):
            key = (p["path"], pd[i], pd[i + 1])
            if key not in limits_cache:
                vlim, dx = speed_limits(g, nodes, cum, pd[i], pd[i + 1])
                limits_cache[key] = (vlim, dx, min_time(vlim, dx))
            segs.append(limits_cache[key])
        gaps = [arr[i + 1] - arr[i] for i in range(n - 1)]
        slack = [gaps[i] - segs[i][2] for i in range(n - 1)]
        dw = [0] * n
        for j in range(1, n - 1):
            dw[j] = int(max(MIN_DWELL, min(DWELL, slack[j - 1], slack[j])))
        pf = []
        for i in range(n - 1):
            vlim, dx, _ = segs[i]
            T = gaps[i] - (dw[i] / 2 if i > 0 else 0) - (dw[i + 1] / 2 if i + 1 < n - 1 else 0)
            T = round(max(T, 5.0), 1)
            fkey = (p["path"], pd[i], pd[i + 1], T)
            if fkey not in fit_cache:
                fit_cache[fkey] = (T, *sample(fit(vlim, dx, T), dx, T))
            prof = fit_cache[fkey]
            if prof not in index:
                index[prof] = len(profiles)
                profiles.append(list(prof))
            pf.append(index[prof])
        p["dw"], p["pf"] = dw, pf
    return profiles


def report(g, paths, patterns, routes):
    """Average scheduled speed per line, and how often the timetable is tighter than the model."""
    for r in sorted(routes):
        own = [p for p in patterns if p["route"] == r]
        longest = max(own, key=lambda p: len(p["stops"]))
        km = longest["pd"][-1] / 1000
        mins = (longest["arr"][-1] - longest["arr"][0]) / 60
        print(f"  {r}: {km:.1f} km in {mins:.0f} min = {km / mins * 60:.0f} km/h average incl. stops, "
              f"dwell {min(longest['dw'][1:-1])}-{max(longest['dw'][1:-1])} s")
