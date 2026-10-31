#!/usr/bin/env python3
"""Generate a fake recording for one or more service days, plus the answer key.

Vehicles drive their real timetable duties (GTFS block_id) through a made-up but
plausible traffic model, and the result is written through the recorder's own
storage code, so the analysis cannot tell it from a real recording. The answer
key (truth.json) holds what the analysis should recover: depot locations, the
congestion factor of every stop-to-stop segment by hour, and bus-lane segments.

Model (all invented; only the timetable and shapes are real):
  - Free-flow speeds: bus 32, trolleybus 28, tram 24 km/h (station-to-station
    averages including acceleration).
  - Congestion slows a segment by severity x peak(t): morning and evening peaks,
    weaker at weekends; severity is higher near the centre, lower for trams
    (own right of way) and for segments with a bus lane.
  - Dwell at stops 10-60 s, longer at peaks; departures from the first stop up
    to a few minutes late; layovers absorb lateness.
  - Vehicles leave a depot of their kind before the first trip, return after the
    last, and go back during long midday breaks; deadhead moves have no trip id.
  - GPS: a report every 5 s, ~4 m noise, 1% dropped reports.

Usage:
    python3 analysis/fake.py --gtfs path/to/static.zip --date 2026-11-02 [--days 7] [--out recordings-fake]
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import random
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "recorder"))
import gtfs  # noqa: E402
from record import Store  # noqa: E402

TZ = ZoneInfo("Europe/Sofia")
FREE = {"bus": 32 / 3.6, "trolley": 28 / 3.6, "tram": 24 / 3.6}
DEADHEAD = 25 / 3.6
PREFIX = {"bus": "A", "trolley": "TB", "tram": "TM"}
# Invented depot sites (roughly where Sofia's real depots are, but this is fake data).
DEPOTS = {
    "bus-zemlyane": ("bus", 42.6862, 23.2795), "bus-malashevtsi": ("bus", 42.7175, 23.3560),
    "bus-druzhba": ("bus", 42.6545, 23.3985), "bus-krasna-polyana": ("bus", 42.6985, 23.2700),
    "bus-iskar": ("bus", 42.6585, 23.4180),
    "tram-krasna-polyana": ("tram", 42.6945, 23.2840), "tram-iskar": ("tram", 42.6610, 23.4090),
    "tram-banishora": ("tram", 42.7125, 23.3085),
    "trolley-nadezhda": ("trolley", 42.7305, 23.3040), "trolley-iskar": ("trolley", 42.6635, 23.4045),
}
BREAK_TO_DEPOT = 75 * 60      # s: a gap longer than this goes back to the depot (if near)


def unit(*parts):
    """Deterministic pseudo-random number in [0, 1) from the given parts."""
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:8], 16) / 2 ** 32


def peak(sec, weekday):
    h = (sec % 86400) / 3600
    p = math.exp(-((h - 8.25) / 0.9) ** 2) + 0.85 * math.exp(-((h - 17.75) / 1.2) ** 2) + 0.25 * math.exp(-((h - 13) / 2) ** 2)
    return min(1.0, p) * (1.0 if weekday < 5 else 0.35 if weekday == 5 else 0.2)


class Network:
    """Answer key for segments: severity and bus lanes, stable across days."""

    def __init__(self, day):
        self.day = day
        self.severity, self.lane = {}, {}

    def seg(self, a, b, kind):
        key = (a, b)
        if key not in self.severity:
            la, lo, _ = self.day["stops"][a]
            x, y = gtfs.to_xy(la, lo)
            centre = math.exp(-math.hypot(x, y) / 4000)
            sev = 0.12 + 0.5 * centre + 0.18 * (unit("sev", a, b) - 0.5)
            lane = kind != "tram" and centre > 0.3 and unit("lane", a, b) < 0.3
            if kind == "tram":
                sev *= 0.3
            if lane:
                sev *= 0.35
            self.severity[key], self.lane[key] = max(0.02, min(0.75, sev)), lane
        return self.severity[key]

    def travel(self, a, b, kind, dist, t, weekday, rnd):
        sev = self.seg(a, b, kind)
        v = FREE[kind] * (1 - sev * peak(t, weekday)) * rnd.uniform(0.9, 1.1)
        return max(15.0, dist / max(v, 1.7))


# ---------- A vehicle's day as a list of legs ----------
# ("shape", t0, t1, shape_id, s0, s1, trip_id, next_stop_ids, stop_d)  moving along a shape
# ("line", t0, t1, (x0, y0), (x1, y1))                                   deadhead, no trip
# ("hold", t0, t1, (x, y), trip_id or None, stop_id or None)             standing

def plan_vehicle(day, net, block, depot, weekday, rnd):
    trips = day["trips"]
    legs = []
    dx, dy = gtfs.to_xy(depot[1], depot[2])

    def stop_xy(sid):
        return gtfs.to_xy(*day["stops"][sid][:2])

    def deadhead(t0, a, b):
        dur = math.dist(a, b) * 1.35 / DEADHEAD + 60
        legs.append(("line", t0, t0 + dur, a, b))
        return t0 + dur

    first = trips[block[0]]
    t = first["dep"][0] - 15 * 60 - math.dist((dx, dy), stop_xy(first["stops"][0])) * 1.35 / DEADHEAD
    legs.append(("hold", t - 20 * 60, t, (dx, dy), None, None))
    t = deadhead(t, (dx, dy), stop_xy(first["stops"][0]))
    late = 0.0
    for k, tid in enumerate(block):
        tr = trips[tid]
        sched_dep = tr["dep"][0]
        start = max(t, sched_dep + max(-30.0, rnd.gauss(25, 45)))
        legs.append(("hold", t, start, stop_xy(tr["stops"][0]), tid, tr["stops"][0]))
        t = start
        kind = day["routes"][tr["route"]]["kind"]
        for i in range(len(tr["stops"]) - 1):
            a, b = tr["stops"][i], tr["stops"][i + 1]
            dist = max(1.0, tr["d"][i + 1] - tr["d"][i])
            dur = net.travel(a, b, kind, dist, t, weekday, rnd)
            legs.append(("shape", t, t + dur, tr["shape"], tr["d"][i], tr["d"][i + 1], tid, b))
            t += dur
            if i + 1 < len(tr["stops"]) - 1:
                dwell = rnd.uniform(10, 25) + 25 * peak(t, weekday) * rnd.random()
                legs.append(("hold", t, t + dwell, stop_xy(b), tid, b))
                t += dwell
        late = t - tr["arr"][-1]
        nxt = trips[block[k + 1]] if k + 1 < len(block) else None
        end_xy = stop_xy(tr["stops"][-1])
        if nxt is None:
            legs.append(("hold", t, t + 90, end_xy, tid, tr["stops"][-1]))
            t = deadhead(t + 90, end_xy, (dx, dy))
            legs.append(("hold", t, t + 5 * 60, (dx, dy), None, None))      # parked, then switched off
            break
        gap = nxt["dep"][0] - t
        near = math.dist(end_xy, (dx, dy)) < 6000
        if gap > BREAK_TO_DEPOT and near:
            legs.append(("hold", t, t + 90, end_xy, tid, tr["stops"][-1]))
            t = deadhead(t + 90, end_xy, (dx, dy))
            back = math.dist((dx, dy), stop_xy(nxt["stops"][0])) * 1.35 / DEADHEAD + 60
            leave = nxt["dep"][0] - back - 8 * 60
            legs.append(("hold", t, leave, (dx, dy), None, None))
            t = deadhead(leave, (dx, dy), stop_xy(nxt["stops"][0]))
        elif tr["stops"][-1] != nxt["stops"][0]:
            legs.append(("hold", t, t + 60, end_xy, tid, tr["stops"][-1]))
            t = deadhead(t + 60, end_xy, stop_xy(nxt["stops"][0]))
    del late
    return legs


def position(day, leg, t):
    """(x, y, speed km/h, trip_id, stop_id, status) at time t within the leg."""
    kind = leg[0]
    f = (t - leg[1]) / max(1e-6, leg[2] - leg[1])
    if kind == "hold":
        return (*leg[3], 0, leg[4], leg[5], 1 if leg[5] else 2)
    if kind == "line":
        (x0, y0), (x1, y1) = leg[3], leg[4]
        v = math.dist(leg[3], leg[4]) / max(1, leg[2] - leg[1]) * 3.6
        return x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, v, None, None, 2
    _, t0, t1, sid, s0, s1, tid, nxt = leg
    e = f * f * (3 - 2 * f)                                   # accelerate, cruise, brake
    s = s0 + (s1 - s0) * e
    v = (s1 - s0) / max(1, t1 - t0) * 6 * f * (1 - f) * 3.6
    x, y, _ = day["shapes"][sid].at(s)
    return x, y, v, tid, nxt, 2


def assign_fleet(vehicles, rnd):
    """Fleet numbers from the real model ranges of each kind (fake assignment)."""
    fleet = json.loads((HERE.parent / "data" / "fleet_models.json").read_text(encoding="utf-8"))["models"]
    pool = {k: [n for m in fleet if m["type"] == k for a, b in m["ranges"] for n in range(a, b + 1)] for k in PREFIX}
    for k in pool:
        rnd.shuffle(pool[k])
    for v in vehicles:
        v["code"] = f"{PREFIX[v['kind']]}{pool[v['kind']].pop():04d}"


def generate(day, date, out, net, seed):
    rnd = random.Random(f"{seed}|{date}")
    weekday = date.weekday()
    midnight = dt.datetime.combine(date, dt.time(0), TZ).timestamp()
    vehicles = []
    for block, tids in sorted(day["blocks"].items()):
        kind = day["routes"][day["trips"][tids[0]]["route"]]["kind"]
        fx, fy = gtfs.to_xy(*day["stops"][day["trips"][tids[0]]["stops"][0]][:2])
        name, depot = min(((n, d) for n, d in DEPOTS.items() if d[0] == kind),
                          key=lambda nd: math.dist((fx, fy), gtfs.to_xy(nd[1][1], nd[1][2])))
        legs = plan_vehicle(day, net, tids, depot, weekday, rnd)
        vehicles.append({"block": block, "kind": kind, "depot": name, "legs": legs, "i": 0,
                         "phase": rnd.randrange(5)})
    assign_fleet(vehicles, rnd)

    store = Store(out)
    start = min(v["legs"][0][1] for v in vehicles)
    end = max(v["legs"][-1][2] for v in vehicles)
    t = math.floor(start / 10) * 10
    polls = 0
    while t <= end:
        rows = []
        for v in vehicles:
            legs = v["legs"]
            rep = t - ((t - v["phase"]) % 5)                     # each vehicle reports every 5 s
            while v["i"] < len(legs) and legs[v["i"]][2] < rep:
                v["i"] += 1
            if v["i"] >= len(legs) or legs[v["i"]][1] > rep or rnd.random() < 0.01:
                continue
            x, y, speed, tid, stop, status = position(day, legs[v["i"]], rep)
            lat, lon = gtfs.to_ll(x + rnd.gauss(0, 4), y + rnd.gauss(0, 4))
            occ = min(6, int(peak(rep, weekday) * 4 + rnd.random() * 1.5)) if tid else None
            rows.append((int(midnight + rep), v["code"], tid, round(lat * 1e6), round(lon * 1e6),
                         round(speed) if speed is not None else None, stop, status, occ))
        if rows:
            polls += 1
            store.write(int(midnight + t), int(midnight + t), rows, commit=polls % 360 == 0)
        t += 10
    store.db.commit()
    store.db.close()
    return vehicles, polls


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gtfs", required=True, help="static GTFS zip (the recorder keeps copies in recordings/gtfs)")
    ap.add_argument("--date", required=True, help="first service day, YYYY-MM-DD")
    ap.add_argument("--days", type=int, default=1)
    ap.add_argument("--out", default=str(HERE.parent / "recordings-fake"))
    ap.add_argument("--seed", default="sofia")
    args = ap.parse_args()
    out = Path(args.out)
    (out / "gtfs").mkdir(parents=True, exist_ok=True)
    gz = Path(args.gtfs)
    target = out / "gtfs" / gz.name
    if not target.exists():
        target.write_bytes(gz.read_bytes())

    truth = {"depots": {n: {"kind": k, "lat": la, "lon": lo} for n, (k, la, lo) in DEPOTS.items()},
             "segments": {}, "vehicles": {}, "model": __doc__}
    net = None
    for k in range(args.days):
        date = dt.date.fromisoformat(args.date) + dt.timedelta(days=k)
        day = gtfs.load_day(gz, date.strftime("%Y%m%d"))
        if net is None:
            net = Network(day)
        net.day = day
        vehicles, polls = generate(day, date, out, net, args.seed)
        for v in vehicles:
            truth["vehicles"].setdefault(date.isoformat(), {})[v["code"]] = {"block": v["block"], "depot": v["depot"]}
        print(f"{date}: {len(vehicles)} vehicles, {polls} polls")
    for (a, b), sev in net.severity.items():
        truth["segments"][f"{a}>{b}"] = {"severity": round(sev, 3), "bus_lane": net.lane[(a, b)]}
    truth["peak"] = "severity x peak(t): see analysis/fake.py peak()"
    (out / "truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Wrote {out} (answer key: truth.json)")


if __name__ == "__main__":
    main()
