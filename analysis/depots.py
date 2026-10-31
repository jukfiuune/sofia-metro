#!/usr/bin/env python3
"""Find depots: places where vehicles stand for a long time without a trip.

For each vehicle, runs of fixes without a trip id that stay within 60 m for at
least MIN_STAY are "parked" events. Their positions are clustered (cells of
CELL metres, merged with neighbours) and clusters visited by at least
MIN_VEHICLES different vehicles are reported as depots, with the vehicle kinds
using them and the times vehicles leave (pull-outs) and arrive (pull-ins).

Writes analysis/out/depots.json.

    python3 analysis/depots.py --dir recordings [--day ...]
"""
import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "recorder"))
import gtfs  # noqa: E402
from status import open_day  # noqa: E402

MIN_STAY = 10 * 60      # s
STAY_RADIUS = 60        # m
CELL = 150              # m
MIN_VEHICLES = 3


def kind_of(code):
    return "tram" if code.startswith("TM") else "trolley" if code.startswith("TB") else "bus"


def parked_events(db):
    """[(veh, x, y, t_start, t_end)] for no-trip stays of at least MIN_STAY."""
    out = []
    cur = None                                          # (veh, x, y, t0, t1, n)
    q = ("SELECT v.code, p.trip, p.ts, p.lat, p.lon FROM pos p JOIN veh v ON v.id = p.veh ORDER BY p.veh, p.ts")
    for veh, trip, ts, lat, lon in db.execute(q):
        x, y = gtfs.to_xy(lat / 1e6, lon / 1e6)
        if trip is None and cur and cur[0] == veh and math.hypot(x - cur[1], y - cur[2]) < STAY_RADIUS:
            cur = (veh, cur[1], cur[2], cur[3], ts, cur[5] + 1)
            continue
        if cur and cur[4] - cur[3] >= MIN_STAY:
            out.append(cur[:5])
        cur = (veh, x, y, ts, ts, 1) if trip is None else None
    if cur and cur[4] - cur[3] >= MIN_STAY:
        out.append(cur[:5])
    return out


def cluster(events):
    cells = defaultdict(list)
    for e in events:
        cells[(round(e[1] / CELL), round(e[2] / CELL))].append(e)
    seen, clusters = set(), []
    for c in cells:
        if c in seen:
            continue
        stack, members = [c], []
        seen.add(c)
        while stack:
            cx, cy = stack.pop()
            members += cells[(cx, cy)]
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (cx + dx, cy + dy)
                    if n in cells and n not in seen:
                        seen.add(n)
                        stack.append(n)
        clusters.append(members)
    return clusters


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default=str(HERE.parent / "recordings"))
    ap.add_argument("--day", nargs="*")
    ap.add_argument("--out", default=str(HERE / "out" / "depots.json"))
    args = ap.parse_args()
    files = sorted(Path(args.dir).glob("pos-*.sqlite"))
    if args.day:
        files = [f for f in files if f.stem[4:] in args.day]
    events = []
    for f in files:
        db = open_day(f)
        events += parked_events(db)
        db.close()
    depots = []
    for members in cluster(events):
        vehicles = {m[0] for m in members}
        if len(vehicles) < MIN_VEHICLES:
            continue
        x = sum(m[1] for m in members) / len(members)
        y = sum(m[2] for m in members) / len(members)
        lat, lon = gtfs.to_ll(x, y)
        kinds = defaultdict(int)
        for v in vehicles:
            kinds[kind_of(v)] += 1
        depots.append({"lat": round(lat, 5), "lon": round(lon, 5), "vehicles": len(vehicles), "kinds": dict(kinds),
                       "stays": len(members), "pull_outs": sorted(int(m[4]) for m in members),
                       "pull_ins": sorted(int(m[3]) for m in members)})
    depots.sort(key=lambda d: -d["vehicles"])
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(depots), encoding="utf-8")
    print(f"{len(events)} parked stays -> {len(depots)} depots")
    for d in depots:
        print(f"  {d['lat']:.4f},{d['lon']:.4f}  {d['vehicles']} vehicles {d['kinds']}")


if __name__ == "__main__":
    main()
