#!/usr/bin/env python3
"""Record Sofia's live vehicle positions for later analysis (depot runs, travel
times, congestion, bus lanes).

Deliberately small and stable so it can run for weeks untouched: it stores raw
positions and nothing derived. Analysis scripts read the same files while it
runs (SQLite WAL allows readers alongside the single writer), so they can be
changed and re-run on the whole history without restarting this.

Storage (in recordings/ unless --dir is given):
  pos-YYYY-MM-DD.sqlite   one file per service day (03:00-03:00 Sofia time)
      pos(ts, veh, trip, lat, lon, speed, stop, status, occ)
          ts       Unix seconds of the GPS fix
          veh/trip ids into the veh / trip tables (text ids from the feed)
          lat/lon  degrees x 1e6 (integers)
          speed    km/h, status = GTFS-rt VehicleStopStatus, occ = OccupancyStatus
      A vehicle is written when its fix changed, plus a heartbeat every 60 s when
      it stands still, so parked buses don't fill the disk.
  gtfs/YYYY-MM-DD-<hash>.zip   the static timetable, saved whenever it changes

Usage:
    python3 recorder/record.py [--dir recordings] [--interval 10]
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import logging
import os
import signal
import sqlite3
import struct
import sys
import time
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

FEED = "https://gtfs.sofiatraffic.bg/api/v1/vehicle-positions"
STATIC = "https://gtfs.sofiatraffic.bg/api/v1/static"
UA = {"User-Agent": "sofia-transport-recorder"}
TZ = ZoneInfo("Europe/Sofia")
DAY_START_HOUR = 3          # service day boundary
HEARTBEAT = 60              # s: re-write an unchanged vehicle at least this often
STATIC_EVERY = 6 * 3600     # s between timetable checks

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS veh(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS trip(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS stop(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS pos(
    ts INTEGER NOT NULL, veh INTEGER NOT NULL, trip INTEGER, lat INTEGER NOT NULL, lon INTEGER NOT NULL,
    speed INTEGER, stop INTEGER, status INTEGER, occ INTEGER);
CREATE INDEX IF NOT EXISTS pos_veh_ts ON pos(veh, ts);
CREATE TABLE IF NOT EXISTS poll(ts INTEGER PRIMARY KEY, feed_ts INTEGER, vehicles INTEGER, written INTEGER);
"""


# ---------- GTFS-realtime (protobuf) ----------
def _varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1; r |= (c & 0x7F) << s; s += 7
        if c < 0x80:
            return r, i


def _msg(b):
    i, out = 0, {}
    while i < len(b):
        k, i = _varint(b, i)
        f, t = k >> 3, k & 7
        if t == 0:
            v, i = _varint(b, i)
        elif t == 1:
            v = b[i:i + 8]; i += 8
        elif t == 5:
            v = b[i:i + 4]; i += 4
        elif t == 2:
            n, i = _varint(b, i); v = b[i:i + n]; i += n
        else:
            break
        out.setdefault(f, []).append(v)
    return out


def parse_positions(raw):
    feed = _msg(raw)
    header = _msg(feed[1][0]) if 1 in feed else {}
    feed_ts = header.get(3, [0])[0]
    out = []
    for e in feed.get(2, []):
        ent = _msg(e)
        if 4 not in ent:
            continue
        vp = _msg(ent[4][0])
        if 2 not in vp:
            continue
        pos = _msg(vp[2][0])
        trip = _msg(vp[1][0]) if 1 in vp else {}
        veh = _msg(vp[8][0]) if 8 in vp else {}
        code = (veh.get(1) or ent.get(1) or [b""])[0].decode()
        out.append((
            vp.get(5, [feed_ts])[0], code,
            trip.get(1, [b""])[0].decode() or None,
            round(struct.unpack("<f", pos[1][0])[0] * 1e6), round(struct.unpack("<f", pos[2][0])[0] * 1e6),
            round(struct.unpack("<f", pos[5][0])[0]) if 5 in pos else None,
            vp.get(7, [b""])[0].decode() or None, vp.get(4, [None])[0], vp.get(9, [None])[0],
        ))
    return feed_ts, out


# ---------- Storage ----------
def service_day(ts):
    t = dt.datetime.fromtimestamp(ts, TZ)
    if t.hour < DAY_START_HOUR:
        t -= dt.timedelta(days=1)
    return t.date().isoformat()


class Store:
    def __init__(self, root):
        self.root = root
        self.day = None
        self.db = None
        self.ids = {}
        self.last = {}          # vehicle code -> (ts, lat, lon, trip, stop, status, written_ts)

    def _open(self, day):
        if self.db:
            self.db.close()
        self.db = sqlite3.connect(self.root / f"pos-{day}.sqlite")
        self.db.executescript(SCHEMA)
        self.day, self.ids = day, {}

    def _id(self, table, code):
        if code is None:
            return None
        key = (table, code)
        if key not in self.ids:
            self.db.execute(f"INSERT OR IGNORE INTO {table}(code) VALUES (?)", (code,))
            self.ids[key] = self.db.execute(f"SELECT id FROM {table} WHERE code=?", (code,)).fetchone()[0]
        return self.ids[key]

    def write(self, now, feed_ts, rows):
        day = service_day(feed_ts or now)
        if day != self.day:
            self._open(day)
        written = 0
        for ts, code, trip, lat, lon, speed, stop, status, occ in rows:
            prev = self.last.get(code)
            state = (lat, lon, trip, stop, status)
            if prev:
                if ts <= prev["ts"]:
                    continue                                   # same fix as last poll
                prev["ts"] = ts
                if state == prev["state"] and ts - prev["written"] < HEARTBEAT:
                    continue                                   # standing still: heartbeat only
            self.db.execute("INSERT INTO pos VALUES (?,?,?,?,?,?,?,?,?)", (
                ts, self._id("veh", code), self._id("trip", trip), lat, lon, speed, self._id("stop", stop), status, occ))
            self.last[code] = {"ts": ts, "state": state, "written": ts}
            written += 1
        self.db.execute("INSERT OR REPLACE INTO poll VALUES (?,?,?,?)", (now, feed_ts, len(rows), written))
        self.db.commit()
        return written


def fetch(url, timeout=30):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def save_static(root):
    """Keep a copy of the static timetable whenever its content changes."""
    raw = fetch(STATIC, timeout=180)
    digest = hashlib.sha256(raw).hexdigest()[:12]
    folder = root / "gtfs"
    folder.mkdir(exist_ok=True)
    if any(p.name.endswith(f"-{digest}.zip") for p in folder.iterdir()):
        return False
    (folder / f"{dt.date.today().isoformat()}-{digest}.zip").write_bytes(raw)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default=str(Path(__file__).resolve().parent.parent / "recordings"))
    ap.add_argument("--interval", type=float, default=10.0, help="seconds between polls (feed refreshes every ~5 s)")
    args = ap.parse_args()
    root = Path(args.dir)
    root.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.FileHandler(root / "recorder.log"), logging.StreamHandler()])

    # Only one recorder per directory.
    lock = open(root / ".lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(f"Another recorder is already writing to {root}")

    stop = {"now": False}
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *a: stop.update(now=True))

    store, failures, last_static, last_feed_ts, last_log = Store(root), 0, 0, None, 0
    logging.info("Recording to %s every %.0f s (pid %d)", root, args.interval, os.getpid())
    while not stop["now"]:
        started = time.time()
        try:
            if started - last_static > STATIC_EVERY:
                last_static = started
                if save_static(root):
                    logging.info("Saved a new static timetable")
            feed_ts, rows = parse_positions(fetch(FEED))
            if feed_ts != last_feed_ts:
                written = store.write(int(started), feed_ts, rows)
                last_feed_ts = feed_ts
                if started - last_log > 600:
                    logging.info("%d vehicles, %d rows written this poll (%s)", len(rows), written, store.day)
                    last_log = started
            failures = 0
        except Exception as e:                        # network hiccups, malformed feed: keep going
            failures += 1
            logging.warning("Poll failed (%d in a row): %s", failures, e)
        # Back off on repeated failures (up to 5 min), otherwise keep the interval.
        delay = args.interval if failures == 0 else min(300, args.interval * 2 ** min(failures, 5))
        while not stop["now"] and time.time() - started < delay:
            time.sleep(0.5)
    if store.db:
        store.db.close()
    logging.info("Stopped")


if __name__ == "__main__":
    main()
