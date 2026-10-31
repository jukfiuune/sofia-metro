#!/usr/bin/env python3
"""Look at what the recorder has collected so far, without disturbing it.

Opens the day files read-only (safe while record.py is writing) and prints, per
service day: polls, rows, vehicles, trips, gaps in recording and disk size; plus
how fresh the newest data is.

    python3 recorder/status.py [--dir recordings] [--hours]

Other analysis scripts can reuse open_day() / positions() the same way.
"""
import argparse
import datetime as dt
import sqlite3
import time
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Sofia")
GAP = 60      # s between polls that counts as a gap


def open_day(path):
    """Read-only connection; works while the recorder holds the file open for writing."""
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
    db.execute("PRAGMA query_only=1")
    return db


def positions(db, since=None):
    """Yield (ts, vehicle, trip, lat, lon, speed, stop, status, occ) with text ids."""
    q = ("SELECT p.ts, v.code, t.code, p.lat / 1e6, p.lon / 1e6, p.speed, s.code, p.status, p.occ FROM pos p "
         "JOIN veh v ON v.id = p.veh LEFT JOIN trip t ON t.id = p.trip LEFT JOIN stop s ON s.id = p.stop")
    if since:
        yield from db.execute(q + " WHERE p.ts >= ? ORDER BY p.ts", (since,))
    else:
        yield from db.execute(q + " ORDER BY p.ts")


def fmt(ts):
    return dt.datetime.fromtimestamp(ts, TZ).strftime("%d.%m %H:%M")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(Path(__file__).resolve().parent.parent / "recordings"))
    ap.add_argument("--hours", action="store_true", help="also show rows and vehicles per hour")
    args = ap.parse_args()
    root = Path(args.dir)
    files = sorted(root.glob("pos-*.sqlite"))
    if not files:
        print(f"No recordings in {root} yet.")
        return
    newest = 0
    for f in files:
        db = open_day(f)
        polls, first, last = db.execute("SELECT COUNT(*), MIN(ts), MAX(ts) FROM poll").fetchone()
        rows, vehicles, trips = db.execute("SELECT COUNT(*), COUNT(DISTINCT veh), COUNT(DISTINCT trip) FROM pos").fetchone()
        stamps = [r[0] for r in db.execute("SELECT ts FROM poll ORDER BY ts")]
        gaps = [(a, b) for a, b in zip(stamps, stamps[1:]) if b - a > GAP]
        size = sum(p.stat().st_size for p in root.glob(f.name + "*")) / 1e6
        print(f"{f.stem[4:]}: {polls} polls {fmt(first)}–{fmt(last)}, {rows:,} rows, {vehicles} vehicles, "
              f"{trips} trips, {size:.1f} MB")
        for a, b in gaps[:10]:
            print(f"    gap {fmt(a)} – {fmt(b)} ({(b - a) / 60:.0f} min)")
        if len(gaps) > 10:
            print(f"    … {len(gaps) - 10} more gaps")
        if args.hours:
            for hour, n, v in db.execute(
                    "SELECT strftime('%H', ts, 'unixepoch', 'localtime'), COUNT(*), COUNT(DISTINCT veh) FROM pos GROUP BY 1"):
                print(f"    {hour}:00  {n:7,} rows  {v:4} vehicles")
        newest = max(newest, last or 0)
        db.close()
    age = time.time() - newest
    print(f"Newest poll {age:.0f} s ago" + ("" if age < 120 else "  ← the recorder may not be running"))


if __name__ == "__main__":
    main()
