# Sofia Metro map

A zoomable map of all four Sofia metro lines (M1–M4) showing where each train should be right now, based on the official timetable. It does not use live tracking.

**Live site:** https://jukfiuune.github.io/sofia-metro/

- **Timetable:** the official GTFS feed from the Sofia Urban Mobility Center (`https://gtfs.sofiatraffic.bg/api/v1/static`).
- **Track layout:** OpenStreetMap (`railway=subway`), including platform tracks, crossovers, tail tracks, sidings and depot yards. It is cached in `data/osm_tracks.json`.

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
  - **In the popup:** clicking a train shows its estimated speed.
  - **Timetable delay:** watching real trains showed them consistently arriving about 1 minute after the GTFS stop times, which the feed marks as approximate (`timepoint=0`). Train positions are therefore computed 60 s behind the clock by default. The "Trains run late by" box in the panel changes this (negative values run trains early), and the browser remembers the value. Station popups still list the official timetable times.
- **Rolling stock:** which trainset works which run isn't published, so each run gets a set at random. The draw is seeded by date, so it's repeatable. A set can do several runs whose times don't overlap. The rules come from the real fleet (Wikipedia BG):

  | Type | Sets | Cars | Length | Lines |
  |---|---|---|---|---|
  | Русич 81-740.2/741.2 | 40 | 3 × 2 articulated sections | 83.5 m | M1, M2, M4 (M2 is Русич only) |
  | 81-717.4К/714.4К, modernised | 8 | 4 | 76.8 m | M1, M4 |
  | 81-717.4/714.4, original | 4 | 4 | 76.8 m | M1, M4, rarely |
  | Škoda 21Mt/22Mt/23Mt | 8 | 4 | ~80 m | M1, M4 |
  | Siemens Inspiro | 30 | 3 | 60.0 m | M3 |

  At zoom 16 and closer, or with "Show full-length trains" ticked, each train is drawn at its real length with every car (and articulated section) following the track.
- **Non-revenue timing:** depot runs go about 40 km/h on running track and 15 km/h on yard tracks, and turnbacks about 29 km/h.
- **Display:** when zoomed in (zoom 15 and up), the two directions are drawn apart, so both tracks and the crossovers between them are visible.

## Run

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765. Any static host works; the live site is served by GitHub Pages from the `main` branch.

## Update the data

```bash
python3 build_data.py                 # latest GTFS + cached OSM tracks
python3 build_data.py --refresh-osm   # also re-download OSM tracks (Overpass; can be slow)
```

| File | Purpose |
|---|---|
| `build_data.py` | Reads the GTFS feed, builds vehicle runs, writes `data/metro.js` |
| `tracks.py` | OSM download, track graph, switch-aware routing |
| `network.py` | Places platforms and routes patterns, turnbacks, depot and stabling moves |
| `app.js` | Map, train animation, panel |
