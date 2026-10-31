#!/usr/bin/env python3
"""Stop passages: when each vehicle arrived at and left each stop of each trip.

Reads a recording day (real or fake; safe while the recorder is writing), snaps
every fix of a trip to that trip's route shape, and interpolates the moments the
vehicle came within R metres of each stop and moved beyond it. Results go to
analysis/out/passages.sqlite, one row per (trip, stop), with the scheduled time,
so delays and segment travel times can be computed by the next steps.

    python3 analysis/passages.py --dir recordings [--day 2026-11-02 ...]
"""
import argparse
import datetime as dt
import math
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "recorder"))
import gtfs  # noqa: E402
from status import open_day  # noqa: E402

TZ = ZoneInfo("Europe/Sofia")
R = 12.0           # m: "at the stop" radius along the shape
SNAP = 40.0        # m: fixes further from the shape are ignored
AHEAD = 1500.0     # m: how far past the previous fix to search on the shape
OUT = HERE / "out" / "passages.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS passage(
    day TEXT, veh TEXT, trip TEXT, route TEXT, shape TEXT, seq INTEGER, stop TEXT,
    sched INTEGER, arr REAL, dep REAL, PRIMARY KEY (day, trip, seq));
CREATE INDEX IF NOT EXISTS passage_stop ON passage(stop, day);
CREATE TABLE IF NOT EXISTS done(day TEXT PRIMARY KEY, trips INTEGER, passages INTEGER, seconds REAL);
"""


class Cursor:
    """Snaps successive fixes to a shape, moving forward along it."""

    def __init__(self, shape):
        self.sh = shape
        self.k = None          # current segment index

    def snap(self, x, y):
        sh = self.sh
        n = len(sh.xy) - 1
        if self.k is None:
            s, err = sh.project(x, y)
        else:
            lo = max(0, self.k - 3)
            limit = sh.cum[self.k] + AHEAD
            best, s, k = math.inf, 0.0, lo
            while k < n and sh.cum[k] <= limit:
                (x1, y1), (x2, y2) = sh.xy[k], sh.xy[k + 1]
                dx, dy = x2 - x1, y2 - y1
                L2 = dx * dx + dy * dy
                f = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
                e = math.hypot(x - x1 - dx * f, y - y1 - dy * f)
                if e < best:
                    best, s = e, sh.cum[k] + math.sqrt(L2) * f
                k += 1
            err = best
        if err > SNAP:
            return None
        lo, hi = 0, n
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if sh.cum[mid] <= s:
                lo = mid
            else:
                hi = mid
        self.k = lo
        return s


def crossing(track, target):
    """Time at which the (time, s) track first reaches distance `target`, or None."""
    for (t0, s0), (t1, s1) in zip(track, track[1:]):
        if s1 >= target:
            if s0 >= target:
                return t0
            return t0 + (t1 - t0) * (target - s0) / (s1 - s0)
    return None


def trip_passages(trip, fixes, shape):
    """fixes: [(ts, x, y)] of one vehicle on one trip. Returns [(seq, arr, dep)]."""
    cur = Cursor(shape)
    track = []
    for ts, x, y in fixes:
        s = cur.snap(x, y)
        if s is None:
            continue
        if track and s < track[-1][1]:
            s = track[-1][1]                         # GPS jitter backwards: hold
        track.append((ts, s))
    if len(track) < 3:
        return []
    out = []
    first, last = track[0][1], track[-1][1]
    n = len(trip["d"])
    for i, d in enumerate(trip["d"]):
        if d < first - R and i > 0 or d > last + R:
            continue                                # not covered by the recording
        arr = None if i == 0 else crossing(track, d - R)
        dep = None if i == n - 1 else crossing(track, d + R)
        if arr is None and dep is None:
            continue
        out.append((i, arr, dep))
    return out


def day_midnight(day):
    return dt.datetime.combine(dt.date.fromisoformat(day), dt.time(0), TZ).timestamp()


def analyse_day(path, gtfs_zip, out_db):
    day = path.stem[4:]
    started = time.time()
    tt = gtfs.load_day(gtfs_zip, day.replace("-", ""))
    midnight = day_midnight(day)
    db = open_day(path)
    rows = db.execute(
        "SELECT v.code, t.code, p.ts, p.lat, p.lon FROM pos p JOIN veh v ON v.id = p.veh JOIN trip t ON t.id = p.trip "
        "ORDER BY p.veh, p.ts")
    groups = defaultdict(list)
    for veh, trip, ts, lat, lon in rows:
        if trip in tt["trips"]:
            groups[(veh, trip)].append((ts, *gtfs.to_xy(lat / 1e6, lon / 1e6)))
    db.close()
    out_db.execute("DELETE FROM passage WHERE day = ?", (day,))
    count = 0
    for (veh, tid), fixes in groups.items():
        trip = tt["trips"][tid]
        shape = tt["shapes"][trip["shape"]]
        res = trip_passages(trip, fixes, shape)
        out_db.executemany("INSERT OR REPLACE INTO passage VALUES (?,?,?,?,?,?,?,?,?,?)", [
            (day, veh, tid, trip["route"], trip["shape"], i, trip["stops"][i],
             int(midnight + (trip["arr"][i] if i else trip["dep"][0])), arr, dep) for i, arr, dep in res])
        count += len(res)
    secs = time.time() - started
    out_db.execute("INSERT OR REPLACE INTO done VALUES (?,?,?,?)", (day, len(groups), count, secs))
    out_db.commit()
    return len(groups), count, secs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default=str(HERE.parent / "recordings"))
    ap.add_argument("--day", nargs="*", help="service days (YYYY-MM-DD); default: all")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    root = Path(args.dir)
    gz = gtfs.latest_gtfs(root)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    out = sqlite3.connect(args.out)
    out.executescript(SCHEMA)
    files = sorted(root.glob("pos-*.sqlite"))
    if args.day:
        files = [f for f in files if f.stem[4:] in args.day]
    for f in files:
        trips, n, secs = analyse_day(f, gz, out)
        print(f"{f.stem[4:]}: {trips} vehicle-trips, {n:,} stop passages ({secs:.0f} s)")


if __name__ == "__main__":
    main()
