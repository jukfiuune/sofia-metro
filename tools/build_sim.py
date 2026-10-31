#!/usr/bin/env python3
"""Write data/sim.js: what the browser needs to simulate buses, trams and
trolleybuses at any date and time.

  - The timetable for every date in the feed, compacted: trips that share a shape
    and relative stop times share a pattern; a trip is [pattern, start, calendar,
    duty]. Calendars are bit strings over the feed's date range.
  - Travel-time profiles from analysis/out/profiles.json: per stop-to-stop
    segment the free-flow run time and, per day type and hour, the slow-down
    factor; per stop the typical dwell. Encoded as one character per hour.
  - Depots from analysis/out/depots.json.

Stop indices refer to data/transit.js (build_transit.py), which must be built
from the same feed.

    python3 tools/build_sim.py --gtfs recordings/gtfs/<file>.zip \
        --profiles analysis/out/profiles.json --depots analysis/out/depots.json [--label "fake week"]
"""
import argparse
import csv
import io
import json
import math
import sys
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from build_transit import KINDS, project_stops  # noqa: E402

MISSING = "!"


def read(zf, name):
    with zf.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def secs(hms):
    h, m, s = (int(x) for x in hms.split(":"))
    return h * 3600 + m * 60 + s


def level(value, step, top=74):
    return chr(48 + max(0, min(top, round(value / step))))


def hours_string(by_hour, encode):
    return "".join(encode(by_hour[str(h)]) if str(h) in by_hour else MISSING for h in range(24))


def osm_depots(folder):
    """Depots mapped in OpenStreetMap (tools/fetch_osm_roads.py): Столичен
    електротранспорт's tram and trolleybus depots, the bus garages, and Zemlyane bus
    garage, which OSM only shows as Столичен автотранспорт's charging stations."""
    out, chargers = [], []
    for f in ("depots.json", "busdepots.json"):
        p = folder / f
        if not p.exists():
            continue
        for e in json.loads(p.read_text(encoding="utf-8"))["elements"]:
            t, c = e.get("tags", {}), e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
            name, op = t.get("name", ""), t.get("operator", "")
            if t.get("amenity") == "charging_station" and "автотранспорт" in op:
                chargers.append((c["lat"], c["lon"]))
                continue
            if e["type"] == "relation" or t.get("landuse") not in ("industrial", "depot"):
                continue
            kind = ("tram" if "Трамвайно" in name or t.get("railway:depot") == "tram" or t.get("depot") == "tram"
                    else "trolley" if "Тролейбусно" in name or t.get("depot") == "trolleybus"
                    else "bus" if "Автобусен гараж" in name and ("автотранспорт" in op) or "МТК" in op else None)
            if kind:
                out.append({"lat": round(c["lat"], 5), "lon": round(c["lon"], 5), "kinds": {kind: 1}, "name": name or op})
    if chargers:
        out.append({"lat": round(sum(a for a, _ in chargers) / len(chargers), 5), "lon": round(sum(b for _, b in chargers) / len(chargers), 5),
                    "kinds": {"bus": 1}, "name": "Автобусен гараж „Земляне“"})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gtfs", required=True)
    ap.add_argument("--profiles", required=True)
    ap.add_argument("--depots", required=True, help='analysis/out/depots.json, or "osm" for the depots mapped in OpenStreetMap')
    ap.add_argument("--label", default="", help="where the profiles come from, shown in the app")
    ap.add_argument("--out", default=str(ROOT / "data" / "sim.js"))
    args = ap.parse_args()

    td = json.loads((ROOT / "data" / "transit.js").read_text(encoding="utf-8").split("=", 1)[1].rstrip().rstrip(";"))
    stop_index = {s[0]: i for i, s in enumerate(td["stops"])}
    stop_xy = {s[0]: (s[4], s[5]) for s in td["stops"]}

    zf = zipfile.ZipFile(args.gtfs)
    routes = {r["route_id"] for r in read(zf, "routes.txt") if r["route_type"] in KINDS}
    trips = {t["trip_id"]: t for t in read(zf, "trips.txt") if t["route_id"] in routes}
    st = defaultdict(list)
    for r in read(zf, "stop_times.txt"):
        if r["trip_id"] in trips:
            st[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"], secs(r["arrival_time"]), secs(r["departure_time"])))
    extra = {}                                   # stops used by some trips but not in transit.js
    for s in read(zf, "stops.txt"):
        if s["stop_id"] not in stop_index:
            extra[s["stop_id"]] = (float(s["stop_lat"]), float(s["stop_lon"]), s["stop_name"])

    # Calendars as bit strings over the feed's date range.
    svc = defaultdict(set)
    for c in read(zf, "calendar_dates.txt"):
        if c["exception_type"] == "1":
            svc[c["service_id"]].add(c["date"])
    all_dates = sorted(set().union(*svc.values()))
    base = datetime.strptime(all_dates[0], "%Y%m%d").date()
    span = (datetime.strptime(all_dates[-1], "%Y%m%d").date() - base).days + 1
    cal_index, calendars = {}, []
    for sid, ds in svc.items():
        bits = ["0"] * span
        for d in ds:
            bits[(datetime.strptime(d, "%Y%m%d").date() - base).days] = "1"
        key = "".join(bits)
        if key not in cal_index:
            cal_index[key] = len(calendars)
            calendars.append(key)
    svc_cal = {sid: cal_index["".join("1" if (base + timedelta(days=k)).strftime("%Y%m%d") in ds else "0" for k in range(span))]
               for sid, ds in svc.items()}

    # Profiles: free-flow time and hourly factors per (stop A, stop B, length).
    prof = json.loads(Path(args.profiles).read_text(encoding="utf-8"))
    seg_prof = {}
    for key, p in prof["segments"].items():
        free = max(1.0, p["free"])
        enc = lambda v: level(v[0] / free - 1, 0.05)
        seg_prof[key] = [round(free, 1)] + [hours_string(p.get(dtp, {}), enc) for dtp in ("wd", "sat", "sun")]
    profiles, prof_index = [], {}
    pair_best = {}                                # stop pair -> its profile key with the most runs
    for key, p in prof["segments"].items():
        pair = key.split("|")[0]
        if pair not in pair_best or p["n"] > prof["segments"][pair_best[pair]]["n"]:
            pair_best[pair] = key

    # Shapes for stop placement of patterns whose stops differ from transit.js.
    shapes = defaultdict(list)
    for p in read(zf, "shapes.txt"):
        shapes[p["shape_id"]].append((int(p["shape_pt_sequence"]), float(p["shape_pt_lat"]), float(p["shape_pt_lon"])))
    lat0 = 42.69
    kx, ky = 111320 * math.cos(math.radians(lat0)), 111320.0
    to_xy = lambda la, lo: ((lo - 23.32) * kx, (la - lat0) * ky)
    shape_geo = {}

    def geo(sid):
        if sid not in shape_geo:
            xy = [to_xy(la, lo) for _, la, lo in sorted(shapes[sid])]
            cum = [0.0]
            for a, b in zip(xy, xy[1:]):
                cum.append(cum[-1] + math.dist(a, b))
            shape_geo[sid] = (xy, cum)
        return shape_geo[sid]

    patterns, pat_index, out_trips, duties, duty_index = [], {}, [], [], {}
    for tid, rows in st.items():
        rows.sort()
        t = trips[tid]
        t0 = rows[0][3]
        stops = [r[1] for r in rows]
        key = (t["shape_id"], tuple(stops), tuple(r[2] - t0 for r in rows))
        if key not in pat_index:
            tp = td["patterns"].get(t["shape_id"])
            same = tp and [td["stops"][i][0] for i in tp["s"]] == stops
            if same:
                d = tp["d"]
            else:
                xy, cum = geo(t["shape_id"])
                d = project_stops(xy, cum, [to_xy(*(stop_xy.get(s) or extra[s][:2])) for s in stops])
            segs = []
            for i in range(1, len(stops)):
                L = round((d[i] - d[i - 1]) / 25) * 25
                pair = f"{stops[i - 1]}>{stops[i]}"
                # Profiles are keyed by stop pair and path length; geometry changes (e.g.
                # OSM-matched shapes) shift lengths a little, so nearby lengths count too.
                k = next((f"{pair}|{L + dl}" for dl in (0, 25, -25, 50, -50, 75, -75) if f"{pair}|{L + dl}" in seg_prof), None)
                if k is None and pair in pair_best:
                    k = pair_best[pair]
                if k in seg_prof:
                    if k not in prof_index:
                        prof_index[k] = len(profiles)
                        profiles.append(seg_prof[k])
                    segs.append(prof_index[k])
                else:
                    segs.append(-1)
            pat_index[key] = len(patterns)
            patterns.append({
                "sh": t["shape_id"],
                "s": None if same else [stop_index.get(s, s) for s in stops],
                "d": None if same else [round(x, 1) for x in d],
                "t": [r[2] - t0 for r in rows],
                "g": segs,
            })
        duty = t["block_id"] or f"{t['route_id']}-run{tid.split('-')[2]}"
        if duty not in duty_index:
            duty_index[duty] = len(duties)
            duties.append(duty)
        out_trips.append([pat_index[key], t0, svc_cal[t["service_id"]], duty_index[duty]])
    out_trips.sort(key=lambda x: (x[3], x[1]))

    dwell = {}
    for stop, by in prof["dwell"].items():
        if stop in stop_index:
            dwell[stop_index[stop]] = [hours_string(by.get(dtp, {}), lambda v: level(v, 2)) for dtp in ("wd", "sat", "sun")]

    depots = osm_depots(ROOT / "data" / "osm") if args.depots == "osm" else [
        {"lat": d["lat"], "lon": d["lon"], "kinds": d["kinds"], "vehicles": d["vehicles"]}
        for d in json.loads(Path(args.depots).read_text(encoding="utf-8"))]

    data = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "label": args.label,
        "dateBase": base.strftime("%Y%m%d"),
        "calendars": calendars,
        "patterns": patterns,
        "trips": out_trips,           # [pattern, start (s after midnight), calendar, duty]
        "duties": duties,             # duty index -> GTFS block_id (or "<route>-run<n>" when the feed has none)
        "profiles": profiles,         # [free s, weekday 24 chars, saturday, sunday]: chr(48 + (factor - 1) / 0.05), "!" = no data
        "dwell": dwell,               # stop index -> [weekday, saturday, sunday]: chr(48 + seconds / 2)
        "depots": depots,
        "extraStops": {k: v for k, v in extra.items() if any(k in (p["s"] or []) for p in patterns)},
    }
    out = Path(args.out)
    out.write_text("window.SIM_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    covered = sum(1 for p in patterns for g in p["g"] if g >= 0) / max(1, sum(len(p["g"]) for p in patterns))
    print(f"{len(out_trips)} trips, {len(patterns)} patterns, {len(duties)} duties, {len(calendars)} calendars, "
          f"{len(profiles)} segment profiles ({covered:.0%} of segments covered), {len(dwell)} dwell stops, {len(depots)} depots")
    print(f"Wrote {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
