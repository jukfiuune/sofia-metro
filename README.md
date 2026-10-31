# Sofia Transport Live

A live map of Sofia's public transport, inspired by [livetransport.eu](https://livetransport.eu/sofia). Buses, trams and trolleybuses are shown at their real GPS positions. The metro, which has no live feed, is simulated from the official timetable on the real track layout. The interface is in Bulgarian, with an English switch.

**Live site:** https://jukfiuune.github.io/sofia-metro/

## Data

- **Live vehicles:** the official GTFS-realtime feeds of the Sofia Urban Mobility Center (`https://gtfs.sofiatraffic.bg/api/v1/vehicle-positions` and `trip-updates`). They allow cross-site requests, so the browser reads them directly and no server is needed.
- **Lines, stops and route shapes:** the official GTFS static feed (`https://gtfs.sofiatraffic.bg/api/v1/static`).
- **Metro track layout:** OpenStreetMap (`railway=subway`), cached in `data/osm_tracks.json`.
- **Base map:** OpenFreeMap vector tiles (OpenMapTiles schema) in our own muted style, drawn by MapLibre. Browsers without WebGL, and low-memory phones by default, get OpenStreetMap raster tiles.
- **Vehicle models:** fleet-number ranges, model names and features (low floor, AC) come from the [livetransport.eu](https://livetransport.eu/sofia) vehicle list. Lengths, body sections, build years and coupling come from transphoto.org, fotobus.msk.ru and Wikipedia (`data/fleet_research.json`). Section splits are estimates. `tools/check_fleet.py` compares the result with the per-vehicle registers: on 31.10.2026, 388 of 394 vehicles in service matched, 4 were not in any register, and the 2 that differ (2602, 2605) appear there only as scrapped Chavdar buses that once had those numbers. Where ranges overlap, the narrowest wins. Vehicle cards have a "Wrong model?" link that opens a GitHub issue.

## Live buses, trams and trolleybuses

- **Updates:** each vehicle reports about every 5 s, and the app polls the feed at the same rate while the page is visible.
- **Snapping:** a realtime `trip_id` is `<route>-<shape>-<run>-…`, so every vehicle's route shape is known. Each GPS fix is snapped to that shape, searching ahead of the previous fix first because shapes can pass the same street twice. Fixes more than 45 m off the shape are drawn as raw positions.
- **Smooth motion:** vehicles are drawn 6 s behind real time and interpolated along the shape between two real fixes, so they follow the road and never cut corners. If a fix is late, a vehicle keeps its last speed for up to 6 s, but never past the next stop.
- **Faded vehicles:** a vehicle with no fix for 90 s is faded, and after 5 minutes it is removed.
- **Dots when zoomed out:** below zoom 14 every vehicle (live and metro) is a small dot in its line colour, drawn on one canvas. Hundreds of labelled HTML markers are too heavy for phones to composite. Tapping a dot opens the nearest vehicle.
- **Full-length view:** at zoom 16.5 and closer, or from zoom 14 with "Full-length vehicles" ticked, each vehicle is drawn at its model's real length, with its articulated sections joined by narrower dark bellows. Coupled tram pairs (T6B5, T6A5) are drawn as two cars. The feed position is the vehicle's front: standing at a stop, 12 m and 18 m vehicles alike report within about 2 m of the stop pole. So each body extends backwards from it, drawn 1.7 m right of the route centre line so that opposite directions don't overlap. If GPS error still puts a queued vehicle inside the one ahead, it is drawn just behind it.
- **Cards:**
  - **Vehicle:** next stop and ETA, speed, occupancy, model, length, low floor and AC, plus the stop list with predicted times.
  - **Stop:** live departures from `trip-updates`.
  - **Line:** directions and stops, with a button to show only that line.
- **Search:** lines ("94", "трамвай 5"), stops (by name in either language, or by 4-digit stop code), metro stations, and vehicles by fleet number.

## How trains are simulated

- **Following each train:** each GTFS `trip_id` contains a run number. Chaining a run's trips gives one physical train's whole day.
- **Routing on real track:** every movement is routed over the OSM track graph. A train can only take the straight or diverging way at a switch, never a sharp turn. The routing covers:
  - Trains keep right, with one platform per track at each station.
  - **Turnbacks** are routed with exactly one reversal. Where tracks continue past the terminus with a crossover (Slivnitsa, Obelya, Vitosha, Gorna Banya, Vazov), the train runs into the tail, reverses and pulls into the other platform. Where they don't (Airport, Business Park), it crosses over before the station and reverses at the platform.
  - **Depot moves:** runs that start or end at Slivnitsa or Obelya use the Obelya depot. Runs at Ovcha Kupel or Tsar Boris III use the Zemlyane depot. A midday break of more than 25 minutes at those stations also means a trip to the depot and back. Trains park on real yard tracks.
  - **Overnight stabling:** runs that start or end elsewhere stable on the nearest siding or tail track, for example the dead-end siding at Konstantin Velichkov.
- **Speeds between stations** (`runs.py`): each run accelerates, then cruises or coasts and re-powers below the local speed limit, then brakes into the platform. The run is fitted to take exactly the scheduled time.
  - **Speed limits:** OSM `maxspeed` tags (20–80 km/h on M1, M2 and M4), curve radius (all lines; M3 has no speed tags), 40 km/h on crossovers, and the 80 km/h system maximum (Wikipedia, and the Siemens Inspiro spec sheet).
  - **Train performance:** about 1.0 m/s² acceleration and braking. Wikipedia gives 1.3 and 1.1 m/s² for the 81-740 "Rusich" trains; nothing was found for the Inspiro or Skoda trains.
  - **Dwell:** 25 s at a stop, shortened down to 8 s where the timetable is too tight.
  - **In the card:** clicking a train shows its estimated speed.
  - **Timetable delay:** the GTFS stop times are marked approximate (`timepoint=0`), so real trains can run a little behind or ahead of them. By default trains follow the timetable exactly (0 s). The "Metro runs late by" box in the menu changes this (negative values run trains early), and the browser remembers the value. Station cards still list the official timetable times.
  - **Time travel:** the menu can show the metro at any time or speed. Live vehicles appear only in real time.
- **Rolling stock:** which trainset works which run isn't published, so each run gets a set at random. The draw is seeded by date, so it's repeatable. A set can do several runs whose times don't overlap. The rules come from the real fleet (Wikipedia BG):

  | Type | Sets | Cars | Length | Lines |
  |---|---|---|---|---|
  | Русич 81-740.2/741.2 | 40 | 3 × 2 articulated sections | 83.5 m | M1, M2, M4 (M2 is Русич only) |
  | 81-717.4К/714.4К, modernised | 8 | 4 | 76.8 m | M1, M4 |
  | 81-717.4/714.4, original | 4 | 4 | 76.8 m | M1, M4, rarely |
  | Škoda 21Mt/22Mt/23Mt | 8 | 4 | ~80 m | M1, M4 |
  | Siemens Inspiro | 30 | 3 | 60.0 m | M3 |

  When zoomed in, or with "Full-length vehicles" ticked, each train is drawn at its real length with every car (and articulated section) following the track.
- **Non-revenue timing:** depot runs go about 40 km/h on running track and 15 km/h on yard tracks, and turnbacks about 29 km/h.
- **Display:** when zoomed in (zoom 15 and up), the two directions are drawn apart, so both tracks and the crossovers between them are visible.

## Recorder

`recorder/record.py` logs every live vehicle every 10 s, around the clock, for later analysis: depot runs, travel times between stops by hour and weekday, congestion, and the effect of bus lanes. It is kept small and stores raw positions only, so analysis can change and be re-run over the whole history without restarting it.

- **Storage:** one SQLite file per service day (03:00–03:00) in `recordings/` (not in git). Positions are integers, and vehicle, trip and stop ids are stored in lookup tables. A standing vehicle is written once a minute instead of every poll. The static timetable is saved whenever it changes, so delays can later be computed against the right schedule.
- **Reading while it runs:** the files are in WAL mode, so other scripts can read them while it writes. `python3 recorder/status.py [--hours]` shows polls, rows, vehicles, gaps and size per day. Its `open_day()` and `positions()` functions are meant for analysis scripts.
- **On the server:** `recorder/install-remote.sh user@host` copies the recorder to `~/sofia-recorder/` and runs it as a systemd user service there (data in `~/sofia-recorder/recordings/`). The server user needs lingering, set once by an admin. Check it with `ssh user@host python3 sofia-recorder/status.py --dir sofia-recorder/recordings`.
- **Running locally:** `recorder/install.sh` installs a frozen copy of the script as a systemd user service (`sofia-recorder`), which restarts after crashes and on boot. Editing the project or switching branches doesn't affect the running copy; run `install.sh` again to update it. For it to run without a logged-in session: `sudo loginctl enable-linger $USER`.
- **Logs:** `journalctl --user -u sofia-recorder`.

## Performance

- **Redraw rate:** the map redraws only as often as the fastest vehicle moves about half a pixel. That's 4 times a second zoomed out, and every frame only when zoomed right in.
- **Slow devices:** the app measures how long a redraw takes on the device and waits at least three times that before the next one, so slow phones keep most of their time for scrolling and taps.
- **Off-screen vehicles:** vehicles outside the view have no marker at all.
- **Map library:** MapLibre (about 250 KB) is only downloaded when the vector map is in use.
- **Measured cost:** on a desktop a full redraw of about 400 live vehicles plus the metro takes about 1 ms of JavaScript. Snapping all fixes takes about 8 ms every 5 s.

## Run

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765. Any static host works; the live site is served by GitHub Pages from the `main` branch.

## Update the data

```bash
python3 build_transit.py              # lines, stops, shapes (latest GTFS)
python3 build_data.py                 # metro (latest GTFS + cached OSM tracks)
python3 build_data.py --refresh-osm   # also re-download OSM tracks (Overpass; can be slow)
python3 tools/build_fleet.py          # js/fleet.js from data/fleet_models.json
python3 tools/check_fleet.py          # compare models with transphoto / fotobus registers
```

| File | Purpose |
|---|---|
| `js/core.js` | Language, clock, map, panels, card, search, filters, frame loop |
| `js/basemap.js` | Vector map style (OpenFreeMap) with raster fallback |
| `js/live.js` | Realtime feed decoding, snapping, smooth motion, vehicle / stop / line cards |
| `js/metro.js` | Metro simulation: runs, turnbacks, depots, train bodies |
| `js/fleet.js` | Vehicle models by fleet number (generated) |
| `tools/check_fleet.py` | Checks the model lookup against the per-vehicle registers of transphoto.org and fotobus.msk.ru for every fleet number in the live feed |
| `build_transit.py` | Writes `data/transit.js` (lines, stops, stop patterns) and `data/shapes.js` (encoded route shapes) |
| `build_data.py`, `tracks.py`, `network.py`, `runs.py` | Metro data: GTFS runs, OSM track graph, routing, speed profiles |
