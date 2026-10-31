#!/usr/bin/env python3
"""Build data/metro.js from the official Sofia public transport GTFS feed.

The feed is published by the Sofia Urban Mobility Center (Център за градска
мобилност, sofiatraffic.bg). Only the metro routes (M1-M4) are kept.

Track geometry (platform tracks, crossovers, tail tracks, depot yards) comes
from OpenStreetMap; trains are routed over it (see tracks.py / network.py).

Usage:
    python3 build_data.py                       # download the feed and build
    python3 build_data.py path/to/gtfs.zip
    python3 build_data.py --refresh-osm [...]   # also re-download OSM tracks
"""
import csv
import io
import json
import sys
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from network import Network
from runs import add_profiles, report
from tracks import build_graph, display_offsets, extend_missing, fetch_osm

FEED_URL = "https://gtfs.sofiatraffic.bg/api/v1/static"
METRO_ROUTES = ("M1", "M2", "M3", "M4")
OUT = Path(__file__).resolve().parent / "data" / "metro.js"
OSM_CACHE = Path(__file__).resolve().parent / "data" / "osm_tracks.json"
YARD_END = 4.0      # m kept clear before a stabling track's buffer stop
YARD_GAP = 8.0      # m between trains parked one behind the other

# Depots (the GTFS feed has none). `stations` lists, per line, the stop_ids from
# which trains run to / from the depot; lat/lon is the yard centre used to find
# its stabling tracks in OSM; `train` is the longest train it keeps (m), which sets
# how many trains fit one behind the other on each stabling track, at most `per_track`. Runs that start or end anywhere else are stabled
# overnight on the nearest siding / tail track of that station.
DEPOTS = {
    "obelya": {
        # 26 stabling tracks with room for two trains each (fizik, forum.gtsofia.info topic 1038, 2011).
        "name": "Метродепо „Обеля“", "en": "Obelya depot", "lat": 42.7330, "lon": 23.2624, "train": 84.0, "per_track": 2,
        "stations": {"M1": ["M1"], "M4": ["M1"], "M2": ["M0"]},
    },
    "zemlyane": {
        "name": "Метродепо „Земляне“", "en": "Zemlyane depot (M3)", "lat": 42.6815, "lon": 23.2762, "train": 61.0, "per_track": 3,
        "stations": {"M3": ["M315", "M314"]},
    },
}


def read_csv(zf, name):
    with zf.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def to_sec(hms):
    h, m, s = (int(x) for x in hms.split(":"))
    return h * 3600 + m * 60 + s


def route_on_tracks(routes, stops, shapes, patterns, trips, calendars, lat0, refresh_osm):
    g = build_graph(fetch_osm(OSM_CACHE, refresh_osm), lat0)

    # Fill any line section that OSM doesn't map yet from the GTFS shape.
    for r in routes:
        own = [p for p in patterns if p["route"] == r]
        longest = max(own, key=lambda p: len(p["stops"]))
        ll = [(float(stops[s]["stop_lat"]), float(stops[s]["stop_lon"])) for s in longest["stops"]]
        extend_missing(g, r, shapes[longest["shape"]], ll)

    # Extra nodes near stations where trains reverse (trip ends / starts, depot stations).
    turn_stops = {p["stops"][0] for p in patterns} | {p["stops"][-1] for p in patterns}
    g.densify([(float(stops[s]["stop_lon"]) * g.kx, float(stops[s]["stop_lat"]) * g.ky) for s in turn_stops],
              radius=1500.0, step=25.0)

    net = Network(g, stops, lat0)
    net.place_platforms({s for p in patterns for s in p["stops"]})

    states, state_index = [], {}

    def state_id(st):
        node, h = st
        key = (node, round(h[0], 2), round(h[1], 2))
        if key not in state_index:
            state_index[key] = len(states)
            states.append(st)
        return state_index[key]

    # Real line termini: ends of each line's longest patterns.
    line_ends = set()
    for r in routes:
        own = [p for p in patterns if p["route"] == r]
        longest = max(len(p["stops"]) for p in own)
        line_ends |= {p["stops"][i] for p in own if len(p["stops"]) == longest for i in (0, -1)}

    routed = {}
    for p in patterns:
        key = tuple(p["stops"])
        if key not in routed:
            routed[key] = net.route_pattern(p["stops"], line_ends)
        res = routed[key]
        if res is None:
            raise SystemExit(f"could not place pattern {p['stops']} on tracks")
        path, dists, s0, s1, crossover = res
        p["path"], p["pd"], p["s0"], p["s1"] = path, dists, state_id(s0), state_id(s1)
        if crossover:
            p["xo"] = 1
        del p["shape"]

    # Vehicle runs over every service date -> which moves actually occur.
    cal_dates = defaultdict(list)
    for ci, dates in enumerate(calendars):
        for d in dates:
            cal_dates[d].append(ci)
    pairs, firsts, lasts = set(), set(), set()
    for d, cis in cal_dates.items():
        cis = set(cis)
        runs = defaultdict(list)
        for pi, start, ci, run in trips:
            if ci in cis:
                runs[(patterns[pi]["route"], run)].append((start, pi))
        for v in runs.values():
            v.sort()
            firsts.add(v[0][1])
            lasts.add(v[-1][1])
            pairs.update((a[1], b[1]) for a, b in zip(v, v[1:]))

    turns = {f"{a}>{b}": net.turnback(states[patterns[a]["s1"]], states[patterns[b]["s0"]]) for a, b in sorted(pairs)}

    depots = {}
    depot_station = {}
    for key, dp in DEPOTS.items():
        tracks = [(e, int((length - YARD_END) // (dp["train"] + YARD_GAP))) for e, length in net.depot_slots(dp)]
        tracks = [(e, min(cap, dp["per_track"])) for e, cap in tracks if cap >= 1]
        if not tracks:
            raise SystemExit(f"no yard tracks found for depot {key}")
        slots = [e for e, _ in tracks]
        for r, sids in dp["stations"].items():
            for sid in sids:
                depot_station[(r, sid)] = key
        ins, outs = {}, {}
        for pi, p in enumerate(patterns):
            if depot_station.get((p["route"], p["stops"][-1])) == key and p["s1"] not in ins:
                ins[p["s1"]] = [net.to_depot(states[p["s1"]], sl) for sl in slots]
        inbound = {(min(a, b), max(a, b)) for v in ins.values() for i in v if i is not None
                   for a, b in zip(net.paths[i][0], net.paths[i][0][1:])}
        for pi, p in enumerate(patterns):
            if depot_station.get((p["route"], p["stops"][0])) == key and p["s0"] not in outs:
                outs[p["s0"]] = [net.from_depot(sl, states[p["s0"]], avoid=inbound) for sl in slots]
        # Keep only yard tracks reachable for every move in and out.
        moves = list(ins.values()) + list(outs.values())
        keep = [i for i in range(len(slots)) if all(v[i] is not None for v in moves)]
        if not keep:
            raise SystemExit(f"no depot yard track at {key} reachable from all its stations")
        slots = [slots[i] for i in keep]
        caps = [tracks[i][1] for i in keep]
        ins = {s: [v[i] for i in keep] for s, v in ins.items()}
        outs = {s: [v[i] for i in keep] for s, v in outs.items()}
        depots[key] = {
            "name": dp["name"], "en": dp["en"], "stations": dp["stations"],
            "lat": round(sum(g.ll[s][0] for s in slots) / len(slots), 6),
            "lon": round(sum(g.ll[s][1] for s in slots) / len(slots), 6),
            "slots": slots, "cap": caps, "pitch": dp["train"] + YARD_GAP, "end": YARD_END, "in": ins, "out": outs,
        }

    # Overnight stabling away from the depots: every siding / tail track end near a
    # terminal, with how much plain track it has before the first switch.
    spots = net.stable_spots()
    stable_in, stable_out = {}, {}
    # Depot stations too: trains stay out there on nights the depot is full.
    for pi in lasts:
        p = patterns[pi]
        if p["s1"] not in stable_in:
            stable_in[p["s1"]] = net.to_stables(states[p["s1"]], spots)
    for pi in firsts:
        p = patterns[pi]
        if p["s0"] not in stable_out:
            stable_out[p["s0"]] = net.from_stables(states[p["s0"]], spots)
    used = {net.paths[i][0][-1] for v in stable_in.values() for i in v} | {net.paths[i][0][0] for v in stable_out.values() for i in v}
    stable_room = {s: round(net.spot_room(s), 1) for s in sorted(used)}

    # Which lines use each track (for colouring) and a representative line path.
    route_edges = defaultdict(set)
    for p in patterns:
        nodes = net.paths[p["path"]][0]
        for a, b in zip(nodes, nodes[1:]):
            route_edges[(min(a, b), max(a, b))].add(p["route"])
    for r in routes:
        own = [p for p in patterns if p["route"] == r]
        routes[r]["line"] = max(own, key=lambda p: (len(p["stops"]), -p["s0"]))["path"]

    station_pos = {}
    for sid, nodes in net.platforms.items():
        station_pos[sid] = [round(sum(g.ll[n][0] for n in nodes) / len(nodes), 6),
                            round(sum(g.ll[n][1] for n in nodes) / len(nodes), 6)]

    profiles = add_profiles(g, net.paths, patterns)
    report(g, net.paths, patterns, routes)

    offs = display_offsets(g)
    for w in net.warnings:
        print("  warning:", w)
    print(f"  tracks: {len(g.ll)} nodes, {len(net.paths)} routed paths, {len(turns)} turnbacks")
    return {
        "nodes": [[round(la, 6), round(lo, 6), round(o[0], 2), round(o[1], 2), round(o[2], 1)]
                  for (la, lo), o in zip(g.ll, offs)],
        # [nodes, reversal indices, metres on depot yard / spur tracks]
        "paths": [[n, rv, round(sum(g.dist(a, b) for a, b in zip(n, n[1:]) if g.adj[a].get(b) in ("yard", "spur")))]
                  for n, rv in net.paths],
        "tracks": net.track_lines(route_edges),
        "profiles": profiles,
        "turns": turns,
        "depots": depots,
        "stable": {"in": stable_in, "out": stable_out, "room": stable_room},
        "station_pos": station_pos,
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    refresh_osm = "--refresh-osm" in sys.argv
    if args:
        raw = Path(args[0]).read_bytes()
    else:
        print(f"Downloading {FEED_URL} ...")
        with urllib.request.urlopen(FEED_URL, timeout=120) as r:
            raw = r.read()
    zf = zipfile.ZipFile(io.BytesIO(raw))

    feed_info = next(read_csv(zf, "feed_info.txt"), {})

    routes = {}
    for r in read_csv(zf, "routes.txt"):
        if r["route_id"] in METRO_ROUTES:
            routes[r["route_id"]] = {
                "name": r["route_short_name"],
                "long": r["route_long_name"],
                "color": "#" + (r["route_color"] or "888888"),
                "text": "#" + (r["route_text_color"] or "FFFFFF"),
            }

    trips = {t["trip_id"]: t for t in read_csv(zf, "trips.txt") if t["route_id"] in routes}

    stop_times = defaultdict(list)
    for st in read_csv(zf, "stop_times.txt"):
        if st["trip_id"] in trips:
            stop_times[st["trip_id"]].append(
                (int(st["stop_sequence"]), st["stop_id"], to_sec(st["arrival_time"]), to_sec(st["departure_time"]))
            )

    used_stops = {s for v in stop_times.values() for _, s, _, _ in v}
    stops = {}
    for s in read_csv(zf, "stops.txt"):
        stops[s["stop_id"]] = s

    en = {}
    for t in read_csv(zf, "translations.txt"):
        if t["table_name"] == "stops" and t["field_name"] == "stop_name" and t["language"] == "en":
            en[t["field_value"]] = t["translation"]

    shape_ids = {t["shape_id"] for t in trips.values()}
    shape_pts = defaultdict(list)
    for p in read_csv(zf, "shapes.txt"):
        if p["shape_id"] in shape_ids:
            shape_pts[p["shape_id"]].append(
                (int(p["shape_pt_sequence"]), float(p["shape_pt_lat"]), float(p["shape_pt_lon"]))
            )
    shapes = {}
    for sid, pts in shape_pts.items():
        pts.sort()
        shapes[sid] = [(round(la, 6), round(lo, 6)) for _, la, lo in pts]

    # Service calendars: dedupe identical date sets.
    service_ids = {t["service_id"] for t in trips.values()}
    svc_dates = defaultdict(set)
    removed = defaultdict(set)
    for c in read_csv(zf, "calendar_dates.txt"):
        if c["service_id"] in service_ids:
            (svc_dates if c["exception_type"] == "1" else removed)[c["service_id"]].add(c["date"])
    if "calendar.txt" in zf.namelist():
        raise SystemExit("calendar.txt present; extend the builder to expand weekly calendars")
    calendars, cal_index, svc_to_cal = [], {}, {}
    for sid in sorted(service_ids):
        key = tuple(sorted(svc_dates[sid] - removed[sid]))
        if key not in cal_index:
            cal_index[key] = len(calendars)
            calendars.append(list(key))
        svc_to_cal[sid] = cal_index[key]

    lat0 = sum(float(stops[s]["stop_lat"]) for s in used_stops) / len(used_stops)

    # Patterns: same route, stop list and relative timings.
    patterns, pat_index, out_trips = [], {}, []
    for tid, t in trips.items():
        seq = sorted(stop_times[tid])
        if len(seq) < 2:
            continue
        t0 = seq[0][2]
        stop_list = tuple(s for _, s, _, _ in seq)
        offs = tuple((a - t0, d - t0) for _, _, a, d in seq)
        key = (t["route_id"], stop_list, offs)
        if key not in pat_index:
            pat_index[key] = len(patterns)
            patterns.append({
                "route": t["route_id"],
                "headsign": t["trip_headsign"],
                "shape": t["shape_id"],
                "stops": list(stop_list),
                "arr": [a for a, _ in offs],
                "dep": [d for _, d in offs],
            })
        # trip_id is "<route>-<shape>-<run>-<seq>-...": <run> identifies the vehicle
        # working, so a run's trips chain end-to-end through the day.
        run = int(tid.split("-")[2])
        out_trips.append([pat_index[key], t0, svc_to_cal[t["service_id"]], run])
    out_trips.sort(key=lambda r: (r[0], r[1]))

    track_data = route_on_tracks(routes, stops, shapes, patterns, out_trips, calendars, lat0, refresh_osm)

    station_lines = defaultdict(set)
    for p in patterns:
        for s in p["stops"]:
            station_lines[s].add(p["route"])
    stations = {}
    for sid in sorted(used_stops):
        s = stops[sid]
        name = s["stop_name"]
        stations[sid] = {
            "name": name,
            "en": en.get(name, ""),
            "lat": round(float(s["stop_lat"]), 6),
            "lon": round(float(s["stop_lon"]), 6),
            "parent": s["parent_station"],
            "lines": sorted(station_lines[sid]),
            "plat": track_data["station_pos"].get(sid),
        }
    del track_data["station_pos"]

    data = {
        "source": "Sofia Urban Mobility Center GTFS (" + FEED_URL + ")",
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "feed": {
            "start": feed_info.get("feed_start_date", ""),
            "end": feed_info.get("feed_end_date", ""),
            "version": feed_info.get("feed_version", ""),
        },
        "timezone": "Europe/Sofia",
        "routes": routes,
        "stations": stations,
        **track_data,
        "calendars": calendars,
        "patterns": patterns,
        "trips": out_trips,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("window.METRO_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n",
                   encoding="utf-8")
    print(f"Wrote {OUT} ({OUT.stat().st_size // 1024} KB): {len(routes)} lines, {len(stations)} platforms, "
          f"{len(patterns)} patterns, {len(out_trips)} trips, {len(calendars)} calendars")


if __name__ == "__main__":
    main()
