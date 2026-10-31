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

## Routes on OSM roads (planner branch)

GTFS route shapes are drawn by the transit authority and often run beside the real street, cut corners or skip loops. `tools/match_shapes.py` map-matches every shape onto OpenStreetMap, so lines, vehicles and bodies sit on the streets the map draws.

- **Data:** `tools/fetch_osm_roads.py` downloads roads (with one-way rules and bus or trolleybus exemptions), tram tracks, depots and route relations for Sofia and its suburbs. It fetches in tiles over several Overpass mirrors and resumes after interruptions.
- **Matching:** the matcher is a hidden Markov model. Buses and trolleybuses use roads in their legal direction; trams use tram tracks.
- **Route relations:** where a line has an OSM route relation (495 of 517 shapes), its ways are preferred. Relations are often more detailed than GTFS (exact lanes, tracks, loops) but can be out of date, so the GTFS shape still decides where the line goes.
- **Clean-up:** back-and-forth spikes from starting on the wrong lane are removed. A match is rejected, keeping the GTFS shape, if less than 85% of the route matched or its length differs by more than 15%.
- **Result:** 516 of 517 shapes are on OSM geometry. Every matched shape stays within 45 m of its GTFS original, and 10,740 of 10,743 trip stops are within 40 m of their placed point.
- **Where it's used:** `build_transit.py` and the analysis loader use `data/osm_shapes.json` when it exists.
- **Depots:** they come from OSM: Столичен електротранспорт's tram depots (Искър, Банишора, Красна поляна, Клокотница) and trolleybus depots (Искър, Левски, Надежда), the Малашевци and Дружба bus garages, МТК's garage, and Земляне, located from its e-bus chargers. Build the simulation with `--depots osm`.

## Simulation (planner branch)

At any time other than "Now", or at any speed-up, buses, trams and trolleybuses are simulated instead of shown live. The metro is simulated as before.

- **Duties:** every vehicle duty of the day (GTFS block) leaves the nearest depot of its kind, drives its trips and waits at the terminus for its next departure. During long breaks it goes back to the depot, and at the end of the day it returns there.
- **Travel times** come from the analysis, not the timetable: each stop-to-stop stretch takes its free-flow time times the slow-down for that day type and hour, and each stop its typical dwell. Lateness builds up and is absorbed at layovers, as in reality.
- **Cards:**
  - **Vehicle:** state, next stop with predicted time and delay, and the predicted time at every stop.
  - **Stop:** predicted departures with expected lateness.
  - **Depot:** parked vehicles by line.
- **Data:** `data/sim.js` (about 375 KB compressed) is loaded only on first use. It holds the timetable for every date in the feed, plus the travel-time profiles and depots. Build it with `python3 tools/build_sim.py --gtfs ... --profiles analysis/out/profiles.json --depots analysis/out/depots.json --label "..."`.
- **Current data:** for now the profiles and depots come from the fake week, so the app labels them "fake week, test data". Real profiles replace them once the server has recorded enough.
- **Speed:** about 750 simulated vehicles at the morning peak take about 0.4 ms per frame to compute.

### Live plus forecast

In real time the simulation also loads in the background, a couple of seconds after the live map. It's used for forecasts:

- **Matching:** every live vehicle is matched to its duty. A GTFS `block_id` is route + run number + service id, all of which are in the realtime trip id, so all live vehicles match.
- **Forecast:** a vehicle's day is re-planned from where it actually is, with the same travel-time model. The rest of its current trip gets predicted stop times, and its next trips start at their scheduled time or as soon as it can make it.
- **Vehicle cards:** show the next trips with predicted departures. Stop times the official predictions don't cover are filled in from the forecast and marked ≈.
- **Lost GPS:** a vehicle with no GPS fix for 90 s keeps moving along its forecast for up to 15 minutes, drawn with a dashed outline and labelled as a forecast.
- **Stop cards:** add forecast departures (≈) for duties the official predictions don't cover yet.
- **Duties without GPS (Map panel, off by default):** scheduled vehicles that aren't in the live feed, drawn hollow and dashed. On a Saturday afternoon about 12% of scheduled duties (53 of 445) had no live vehicle, spread across many lines: cancellations, missing GPS units or timing differences.

- **Speed-up from "Now":** pressing 10× (or any speed) hands every live vehicle over to its forecast, starting exactly where it is drawn, with the same marker, model and body. In a test, 388 of 390 live vehicles continued without moving at the switch, 99% of them by 0 m. Scheduled duties without a live vehicle continue from the plain simulation.

Each forecast takes about 0.7 ms and is computed only when needed, then cached until that vehicle's next GPS fix.

## Analysis (planner branch)

Scripts in `analysis/` turn recordings into the data the simulation and route planner will use. They read a recording directory without disturbing the recorder, and work the same on real and fake recordings.

| Script | Output |
|---|---|
| `fake.py` | A fake recording: vehicles drive their real timetable duties through an invented traffic model (morning and evening peaks, worse near the centre, milder on bus-lane stretches and for trams), with stop dwells, late departures, layovers and depot runs. It is written through the recorder's own storage code, plus `truth.json` with the answers: depots, each stretch's congestion and bus lanes. About 1 minute per day. |
| `passages.py` | `out/passages.sqlite`: when each vehicle arrived at and left each stop of each trip, from fixes snapped to the trip's route shape. About 2 minutes per day. |
| `profiles.py` | `out/profiles.json`: per stop-to-stop stretch (stop pair plus path length, since routes can join two stops by different paths), the free-flow run time (10th percentile) and the median run time by day type (weekday / Saturday / Sunday) and hour; plus dwell times per stop. |
| `depots.py` | `out/depots.json`: places where several vehicles stand for 10+ minutes without a trip, with the vehicle kinds and pull-out / pull-in times. |
| `validate.py` | Compares the analysis of a fake recording with its answer key. |
| `gtfs.py` | Shared timetable loader for one service day (cached). |

```bash
python3 analysis/fake.py --gtfs recordings/gtfs/<file>.zip --date 2026-11-02 --days 5 --out recordings-fake
python3 analysis/passages.py --dir recordings-fake --out analysis/out/fake-passages.sqlite
python3 analysis/profiles.py --db analysis/out/fake-passages.sqlite --dir recordings-fake
python3 analysis/depots.py --dir recordings-fake --out analysis/out/fake-depots.json
python3 analysis/validate.py --fake recordings-fake --profiles analysis/out/fake-profiles.json --depots analysis/out/fake-depots.json
```

**Accuracy on a fake week (Monday to Sunday):**
- **Depots:** all 10 found within 2 m.
- **Congestion, grouped by true slow-down:** measured ×1.09 for true ×1.0–1.1, ×1.20 for ×1.1–1.25, ×1.34 for ×1.25–1.5, ×1.55 for ×1.5–2.0, ×1.98 for ×2+.
- **Single stretches:** correlation 0.48 across all weekday stretch-hours with 2+ runs, and 0.71 without the 0.16% of stretch-hours that are still measurement outliers.
- **Bus lanes:** found without the analysis being told where they are (peak ×1.17 with a lane against ×1.23 without).

**Fixes this validation found, which apply to real data too:**
- **Stop placement:** stops near terminal loops were placed at the route's first close pass. That also corrected the live map's data for lines 76, 78, 79, 183, 213 and N1.
- **Waiting vehicles:** a vehicle waiting at a stop whose coordinates sit slightly off the route was counted as driving to the next stop.
- **Impossible runs:** runs faster than 90 km/h are dropped as errors.

**Memory:** `passages.py` streams one vehicle trip at a time, peaking at about 300 MB for a full day (it used to need about 1 GB).

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
