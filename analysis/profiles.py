#!/usr/bin/env python3
"""Travel-time profiles per stop-to-stop segment, by day type and hour.

From analysis/out/passages.sqlite: the run time of each segment (left stop A ->
reached stop B, along a path of length L) and the dwell at each stop. For every segment and (day type,
hour) it keeps the median run time; the free-flow time is the 10th percentile
over all hours. congestion = median / free-flow (1.0 = empty roads).

Writes analysis/out/profiles.json:
  {"segments": {"A>B|L": {"free": s, "n": count, "wd": {hour: [median_s, n]}, "sat": {...}, "sun": {...}}},
   "dwell": {stop: {"wd": {hour: median_s}}}}

    python3 analysis/profiles.py [--db analysis/out/passages.sqlite] [--dir recordings]
"""
import argparse
import datetime as dt
import json
import sqlite3
import statistics
from collections import defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
TZ = ZoneInfo("Europe/Sofia")


def daytype(day):
    wd = dt.date.fromisoformat(day).weekday()
    return "wd" if wd < 5 else "sat" if wd == 5 else "sun"


def seg_lengths(db, gtfs_zip):
    """(trip, seq) -> metres from the previous stop, from the timetable of each day."""
    import gtfs
    out = {}
    for (day,) in db.execute("SELECT DISTINCT day FROM passage"):
        for tid, t in gtfs.load_day(gtfs_zip, day.replace("-", ""))["trips"].items():
            for i in range(1, len(t["d"])):
                out[(tid, i)] = t["d"][i] - t["d"][i - 1]
    return out


def build(db_path, gtfs_zip):
    db = sqlite3.connect(db_path)
    lengths = seg_lengths(db, gtfs_zip)
    runs = defaultdict(lambda: defaultdict(list))      # seg -> (daytype, hour) -> [seconds]
    dwells = defaultdict(lambda: defaultdict(list))
    prev = None
    for day, trip, seq, stop, arr, dep in db.execute(
            "SELECT day, trip, seq, stop, arr, dep FROM passage ORDER BY day, trip, seq"):
        dtp = daytype(day)
        if arr is not None and dep is not None and dep >= arr:
            dwells[stop][(dtp, dt.datetime.fromtimestamp(arr, TZ).hour)].append(dep - arr)
        if prev and prev[0] == day and prev[1] == trip and prev[2] == seq - 1 and prev[4] is not None and arr is not None:
            run = arr - prev[4]
            length = lengths.get((trip, seq))
            # Runs faster than 90 km/h are measurement errors (e.g. a route looping back
            # past a stop); dropping them keeps the free-flow estimate honest.
            if 5 <= run <= 3600 and length and length / run <= 25:
                hour = dt.datetime.fromtimestamp(prev[4], TZ).hour
                # Different routes can join the same two stops by different paths, so the
                # key includes the path length (to 25 m): "A>B|L".
                runs[f"{prev[3]}>{stop}|{round(length / 25) * 25}"][(dtp, hour)].append(run)
        prev = (day, trip, seq, stop, dep)
    segments = {}
    for seg, buckets in runs.items():
        every = sorted(x for v in buckets.values() for x in v)
        free = every[max(0, int(len(every) * 0.1) - 1)] if len(every) >= 3 else every[0]
        out = {"free": round(free, 1), "n": len(every)}
        for (dtp, hour), v in buckets.items():
            out.setdefault(dtp, {})[str(hour)] = [round(statistics.median(v), 1), len(v)]
        segments[seg] = out
    dwell = {}
    for stop, buckets in dwells.items():
        for (dtp, hour), v in buckets.items():
            dwell.setdefault(stop, {}).setdefault(dtp, {})[str(hour)] = round(statistics.median(v), 1)
    return {"segments": segments, "dwell": dwell}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(HERE / "out" / "passages.sqlite"))
    ap.add_argument("--dir", default=str(HERE.parent / "recordings"), help="recording dir (for its timetable copy)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    import sys
    sys.path.insert(0, str(HERE))
    import gtfs
    prof = build(args.db, gtfs.latest_gtfs(args.dir))
    out = Path(args.out or Path(args.db).with_name(Path(args.db).stem.replace("passages", "profiles") + ".json"))
    out.write_text(json.dumps(prof, separators=(",", ":")), encoding="utf-8")
    print(f"{len(prof['segments'])} segments, {len(prof['dwell'])} stops with dwell data -> {out}")


if __name__ == "__main__":
    main()
