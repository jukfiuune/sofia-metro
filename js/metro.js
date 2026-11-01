/* Sofia Metro — estimated train positions from the official GTFS timetable.
 *
 * Trips are chained into vehicle runs (the run number in each trip_id), so each
 * physical train is followed through its whole day. Every movement — trips,
 * turnbacks at termini, depot runs, overnight stabling — follows a path routed
 * over the real track layout from OpenStreetMap (see build_data.py), so trains
 * use the actual platforms, crossovers, tail tracks and yard roads. Timings of
 * non-revenue moves are estimates.
 */
(function () {
  "use strict";

  const D = window.METRO_DATA;
  const map = ST.map, t = ST.t;
  const LINE_ORDER = Object.keys(D.routes).sort();

  const UNLOAD = 30;           // s at the arrival platform before moving off
  const READY = 120;           // s at the departure platform before a run's first trip
  const REV_HOLD = 20;         // s to change ends when reversing
  const SHUNT_SPEED = 8;       // m/s for turnback moves (over switches)
  const DEPOT_SPEED = 11;      // m/s (~40 km/h) for empty runs on the running line
  const YARD_SPEED = 4;        // m/s (~15 km/h) on depot yard tracks and spurs
  const DEPOT_GAP = 25 * 60;   // layovers longer than this at a depot station go to the depot
  const DEPOT_MIN_STAY = 10 * 60;
  const STOP_SHORT = 4;        // m a train stops short of a buffer stop  // ... if that leaves at least this long standing in the depot
  // The GTFS stop times are marked approximate (timepoint=0) and real trains can run a little
  // behind or ahead of them; this shifts positions behind the clock by that many seconds.
  // Adjustable in the menu; negative values run trains early.
  const DEFAULT_DELAY = 0;     // s
  let timetableDelay = DEFAULT_DELAY;
  try {
    const saved = localStorage.getItem("metro.delay2");
    if (saved !== null && Number.isFinite(+saved)) timetableDelay = +saved;
  } catch (e) { /* storage unavailable */ }
  const DAY_START = 3 * 3600;  // service day boundary (03:00) for depot / stabling state
  const DAY_END = DAY_START + 86400;

  // ---------- Geometry ----------
  const N = D.nodes; // [lat, lon, ux, uy, halfGap]
  const LAT0 = N.reduce((s, n) => s + n[0], 0) / N.length;
  const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 111320;
  const nodeDist = (a, b) => Math.hypot((N[b][1] - N[a][1]) * KX, (N[b][0] - N[a][0]) * KY);

  const paths = D.paths.map(([n, rv = [], yl = 0]) => {
    const cum = [0];
    for (let i = 1; i < n.length; i++) cum.push(cum[i - 1] + nodeDist(n[i - 1], n[i]));
    return { n, cum, len: cum.at(-1), rvd: rv.map(i => cum[i]), rvn: rv.map(i => n[i]), yl };
  });

  /** Pixel distance between the two displayed tracks' centre and each track, by zoom. */
  const trackOffset = z => (z >= 17 ? 9 : z >= 16 ? 7 : z >= 15 ? 5 : 0);
  let offPx = 0, mpp = 1;
  function updateScale() {
    const z = map.getZoom();
    offPx = trackOffset(z);
    mpp = 156543.03392 * Math.cos(LAT0 * Math.PI / 180) / Math.pow(2, z);
  }

  /** Displayed position of a point between nodes a and b (fraction t), with track spreading. */
  function displayLL(a, b, t) {
    const A = N[a], B = N[b];
    let lat = A[0] + (B[0] - A[0]) * t, lon = A[1] + (B[1] - A[1]) * t;
    if (offPx) {
      const ux = A[2] + (B[2] - A[2]) * t, uy = A[3] + (B[3] - A[3]) * t, h = A[4] + (B[4] - A[4]) * t;
      const extra = Math.max(0, offPx * mpp - h);
      lat += uy * extra / KY;
      lon += ux * extra / KX;
    }
    return [lat, lon];
  }
  const nodeLL = n => displayLL(n, n, 0);

  /** Position and heading at distance d along a path. */
  function pathAt(p, d) {
    const { n, cum } = p;
    if (n.length === 1) return { ll: nodeLL(n[0]), brg: null };
    d = Math.max(0, Math.min(p.len, d));
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid; else hi = mid;
    }
    // Skip zero-length steps (reversal points repeat a node).
    while (lo > 0 && cum[hi] - cum[lo] < 0.01) lo--;
    const seg = cum[hi] - cum[lo];
    const t = seg > 0 ? (d - cum[lo]) / seg : 0;
    const a = N[n[lo]], b = N[n[hi]];
    const brg = Math.atan2((b[1] - a[1]) * KX, (b[0] - a[0]) * KY) * 180 / Math.PI;
    return { ll: displayLL(n[lo], n[hi], t), brg };
  }

  /** The stretch of path P (between reversal points) the vehicle is travelling on. */
  function travelPiece(st) {
    const P = st.P;
    if (st.kind === "move") return [Math.min(st.leg.d0, st.leg.d1), Math.max(st.leg.d0, st.leg.d1)];
    const b = [0, ...P.rvd, P.len];
    for (let i = 1; i < b.length; i++) if (st.d <= b[i] + 0.01) return [b[i - 1], b[i]];
    return [b.at(-2), b.at(-1)];
  }

  /** Point s metres along P, continuing straight beyond either end of `piece`. */
  function pieceAt(P, piece, s) {
    const [lo, hi] = piece;
    if (s >= lo && s <= hi) return pathAt(P, s).ll;
    const end = s < lo ? lo : hi;
    const inward = s < lo ? Math.min(hi, lo + 5) : Math.max(lo, hi - 5);
    const a = pathAt(P, end).ll, b = pathAt(P, inward).ll;
    const dx = (a[1] - b[1]) * KX, dy = (a[0] - b[0]) * KY, len = Math.hypot(dx, dy) || 1;
    const ext = s < lo ? lo - s : s - hi;
    return [a[0] + dy / len * ext / KY, a[1] + dx / len * ext / KX];
  }

  const CAR_GAP = 0.9, SECTION_GAP = 0.7;
  /** Centre-lines of each car body section of a train centred at st.d, and the
   *  articulation joints between sections of the same car. */
  function trainSections(type, st) {
    let [lo, hi] = travelPiece(st);
    if (hi - lo < 3) { lo = 0; hi = st.P.len; }
    const piece = [lo, hi], out = [], joints = [];
    const line = (a, b) => {
      const pts = [], steps = Math.max(1, Math.ceil((a - b) / 4));
      for (let i = 0; i <= steps; i++) pts.push(pieceAt(st.P, piece, a - (a - b) * i / steps));
      return pts;
    };
    let s = st.d + type.length / 2;                 // front of the train
    for (const car of type.cars) {
      const sec = car / type.sections;
      for (let k = 0; k < type.sections; k++) {
        const gapFront = k === 0 ? CAR_GAP / 2 : SECTION_GAP / 2;
        const gapBack = k === type.sections - 1 ? CAR_GAP / 2 : SECTION_GAP / 2;
        out.push(line(s - gapFront, s - sec + gapBack));
        if (k < type.sections - 1) joints.push(line(s - sec + gapBack + 0.1, s - sec - gapBack - 0.1));
        s -= sec;
      }
    }
    out.joints = joints;
    return out;
  }

  const ease = f => f * f * (3 - 2 * f);
  const lerp = (a, b, f) => a + (b - a) * f;

  // ---------- Timetable model ----------
  const calendars = D.calendars.map(c => new Set(c));

  // GTFS gives one time per stop; the build chose a dwell per stop (p.dw) centred
  // on it, and a speed profile for each run between stops (p.pf -> D.profiles:
  // [run seconds, distance after 2 s, after 4 s, ...]).
  for (const p of D.patterns) {
    const n = p.stops.length;
    p.tArr = []; p.tDep = [];
    for (let i = 0; i < n; i++) {
      p.tArr.push(i === 0 ? p.arr[0] : p.arr[i] - p.dw[i] / 2);
      p.tDep.push(i === n - 1 ? p.dep[i] : p.dep[i] + p.dw[i] / 2);
    }
    p.P = paths[p.path];
  }
  const PROFILE_STEP = 2;

  /** Distance covered `tau` seconds into a run of length L following profile `prof`. */
  function profileDist(prof, tau, L) {
    const T = prof[0];
    if (tau <= 0) return 0;
    if (tau >= T) return L;
    const k = Math.floor(tau / PROFILE_STEP);
    const d0 = k === 0 ? 0 : prof[k];
    const t1 = Math.min(T, (k + 1) * PROFILE_STEP);
    const d1 = (k + 1) * PROFILE_STEP >= T ? L : prof[k + 1];
    return d0 + (d1 - d0) * (tau - k * PROFILE_STEP) / (t1 - k * PROFILE_STEP);
  }
  const patternIdx = new Map(D.patterns.map((p, i) => [p, i]));

  // Trip tuple: [patternIndex, startSec, calendarIndex, runNumber]
  const trips = D.trips.map(([pi, start, cal, run], idx) => ({ id: idx, pi, p: D.patterns[pi], start, cal, run }));

  function depotFor(route, stop) {
    for (const [key, dp] of Object.entries(D.depots)) if ((dp.stations[route] || []).includes(stop)) return key;
    return null;
  }

  /** Position of a trip at `t` seconds after its start: distance along its pattern path. */
  function tripPos(p, t) {
    const n = p.stops.length;
    for (let i = 0; i < n; i++) {
      if (t <= p.tDep[i]) {
        if (t >= p.tArr[i]) return { d: p.pd[i], atStop: i, next: i, prev: i };
        const prof = D.profiles[p.pf[i - 1]], L = p.pd[i] - p.pd[i - 1], tau = t - p.tDep[i - 1];
        const d = profileDist(prof, tau, L);
        const v = (profileDist(prof, tau + 0.5, L) - profileDist(prof, tau - 0.5, L)); // m/s
        return { d: p.pd[i - 1] + d, atStop: -1, next: i, prev: i - 1, v };
      }
    }
    return { d: p.pd[n - 1], atStop: n - 1, next: n - 1, prev: n - 1 };
  }

  // ---------- Fleet ----------
  // Rolling stock (bg.wikipedia.org/wiki/Софийско_метро, ru.wikipedia.org 81-740/741 and
  // 81-717/714, Siemens and Škoda data sheets). Car lengths in metres; `sections` =
  // articulated sections per car. Which set works which run is NOT published: sets
  // are assigned at random (seeded per date) respecting the lines each type serves.
  const TRAIN_TYPES = {
    // `year`: roughly when the type entered (or, modernised, re-entered) service.
    rusich:  { name: "81-740.2/741.2 „Русич“", maker: "Metrovagonmash", cars: [28.15, 27.2, 28.15], sections: 2, year: 2010 },
    nomK:    { name: "81-717.4К/714.4К (modernised)", maker: "Metrovagonmash, modernised 2019–22", cars: [19.21, 19.21, 19.21, 19.21], sections: 1, year: 2021 },
    nom:     { name: "81-717.4/714.4 (original, 1990)", maker: "Metrovagonmash", cars: [19.21, 19.21, 19.21, 19.21], sections: 1, year: 1990 },
    skoda:   { name: "Škoda 21Mt/22Mt/23Mt", maker: "Škoda Group, 2025–26", cars: [20, 20, 20, 20], sections: 1, year: 2025 },
    inspiro: { name: "Siemens Inspiro Sofia", maker: "Siemens / Newag", cars: [20, 20, 20], sections: 1, year: 2020 },
  };
  for (const t of Object.values(TRAIN_TYPES)) t.length = t.cars.reduce((a, b) => a + b, 0);

  // Sets, the lines they may work, and how readily the depot sends them out.
  const FLEET = [];
  const addSets = (type, ids, lines, weight) => ids.forEach(id => FLEET.push({ type, id, lines, weight }));
  const range = (a, b, f) => Array.from({ length: b - a + 1 }, (_, i) => f(a + i));
  addSets("rusich", range(1, 40, i => `Русич №${i}`), ["M1", "M2", "M4"], 1);
  addSets("nomK", ["A1", "A2", "A6", "A7", "A8", "A9", "A10", "A11"], ["M1", "M4"], 1.2);
  addSets("nom", ["A3", "A4", "A5", "A12"], ["M1", "M4"], 0.08);   // kept as reserve, rarely used
  addSets("skoda", range(61, 68, i => `A${i}`), ["M1", "M4"], 1.2);
  addSets("inspiro", range(1, 30, i => `B${i}`), ["M3"], 1);

  function seededRandom(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return () => {               // mulberry32
      h = (h + 0x6D2B79F5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- Depot yards ----------
  // Which trainset works which run is not published, so it is played out day by day,
  // carrying each night's yard over to the next morning: a train coming back stops in
  // front of those already on its stabling track, and a run leaving the depot takes a
  // train standing at the front of a track (one allowed on its line). The trains that
  // came in last at night therefore go out first, and sets nobody takes stay deep in
  // the yard as spares. Lines with sets of their own get their own tracks (at Obelya:
  // M2, worked only by Русич sets; M1 and M4 share the rest).
  const HISTORY = 3;                 // days played out before the one shown
  const yardGroup = route => route === "M2" ? "M2" : "main";
  const YARDS = (() => {
    const runsOf = {};
    for (const tr of trips) (runsOf[tr.p.route] ||= new Set()).add(tr.run);
    const out = {};
    for (const [key, dp] of Object.entries(D.depots)) {
      const tracks = dp.slots.map((_, i) => ({ i, cap: dp.cap[i], group: "main" }));
      const lines = Object.keys(dp.stations), runs = r => (runsOf[r] || new Set()).size;
      const total = lines.reduce((a, r) => a + runs(r), 0), places = tracks.reduce((a, t) => a + t.cap, 0);
      for (const g of new Set(lines.map(yardGroup))) {
        if (g === "main") continue;
        // Places in proportion to the group's runs, plus room for spares; the first tracks in yard order.
        const want = Math.ceil(places * lines.filter(r => yardGroup(r) === g).reduce((a, r) => a + runs(r), 0) / total * 1.15);
        let got = 0;
        for (const t of tracks) if (t.group === "main" && got < want) { t.group = g; got += t.cap; }
      }
      out[key] = tracks;
    }
    return out;
  })();
  const homeDepot = set => Object.keys(D.depots).find(k => D.depots[k].stations[set.lines[0]]);

  /** Yard state with no history: each depot full of its sets, newest at the front; sets that
   *  don't fit wait at the depot station's platform. */
  function baseYard() {
    const yard = {}, outside = [], atPlatform = new Map();
    for (const [key, tracks] of Object.entries(YARDS)) {
      yard[key] = tracks.map(() => []);
      const sets = FLEET.filter(s => homeDepot(s) === key).sort((a, b) => TRAIN_TYPES[a.type].year - TRAIN_TYPES[b.type].year);
      for (const set of sets) {
        const fits = g => tracks.find(t => t.group === g && yard[key][t.i].length < t.cap && (g === "main" || set.lines.includes(g)));
        const t = (set.lines.length > 2 && fits(tracks.find(t => t.group !== "main")?.group)) || fits("main") || tracks.find(t => yard[key][t.i].length < t.cap);
        if (t) { yard[key][t.i].push(set); continue; }
        const A = D.patterns.find(p => set.lines.includes(p.route) && depotFor(p.route, p.stops.at(-1)) === key);
        if (!A) continue;
        const k = atPlatform.get(A) || 0;
        atPlatform.set(A, k + 1);
        outside.push({ set, station: stationOf(A.stops.at(-1)), stop: A.stops.at(-1), plat: patternIdx.get(A), k });
      }
    }
    return { yard, outside };
  }

  /** Turnback route from the end of pattern a to the start of pattern b (alternative `alt`
   *  if there is one, e.g. via the other tail track), or undefined. */
  const turnPath = (a, b, alt = 0) => { const t = D.turns[`${a}>${b}`]; return t && paths[t[alt] ?? t[0]]; };
  const stationOf = stop => (D.stations[stop] && D.stations[stop].parent) || stop;
  const lineDepot = route => D.depots[Object.keys(D.depots).find(k => D.depots[k].stations[route])];
  /** Natural duration of a move along P, including reversal stops. */
  const moveTime = (P, speed) => (P.len - P.yl) / speed + P.yl / YARD_SPEED + P.rvd.length * REV_HOLD;
  const nextDate = date => shiftDay({ year: +date.slice(0, 4), month: +date.slice(4, 6), day: +date.slice(6, 8) }, 1);

  /** A pattern on one of `routes` from a depot station to `station`, for running empty
   *  between the depot and a station where a train spends the night; -1 if none. */
  function emptyRunTo(station, routes, ok) {
    return D.patterns.findIndex((q, qi) => routes.includes(q.route) && depotFor(q.route, q.stops[0]) &&
      stationOf(q.stops.at(-1)) === station && ok(qi));
  }

  // A train may rest in a terminal's tail tracks only while no trains are turning back
  // there: overnight, before the morning's first turnbacks or after the evening's last.
  const TURN_MARGIN = 30 * 60;
  const stationDays = new Map();
  /** Per station for a service day: when trains start turning back there and when they
   *  stop, and the runs whose first trip leaves it early enough to have waited overnight. */
  function stationDay(date) {
    if (stationDays.has(date)) return stationDays.get(date);
    const byRun = new Map();
    for (const trip of trips) {
      if (!calendars[trip.cal].has(date)) continue;
      const k = `${trip.p.route}/${trip.run}`;
      byRun.set(k, [...(byRun.get(k) || []), trip]);
    }
    const turns = new Map(), firsts = [];
    for (const list of byRun.values()) {
      list.sort((a, b) => a.start - b.start);
      firsts.push(list[0]);
      for (let k = 0; k + 1 < list.length; k++) {
        const st = stationOf(list[k].p.stops.at(-1));
        if (stationOf(list[k + 1].p.stops[0]) !== st) continue;
        const t = list[k].start + list[k].p.arr.at(-1), w = turns.get(st);
        turns.set(st, w ? [Math.min(w[0], t), Math.max(w[1], t)] : [t, t]);
      }
    }
    const starts = new Map();
    for (const tr of firsts) {
      const st = stationOf(tr.p.stops[0]);
      if (depotFor(tr.p.route, tr.p.stops[0]) || !overnightStart(turns, st, tr.start + tr.p.dep[0])) continue;
      starts.set(st, [...(starts.get(st) || []), tr]);
    }
    const day = { turns, starts };
    if (stationDays.size > 12) stationDays.delete(stationDays.keys().next().value);
    stationDays.set(date, day);
    return day;
  }
  const overnightStart = (turns, st, dep) => !turns.has(st) || dep <= turns.get(st)[0] + TURN_MARGIN;
  const overnightEnd = (turns, st, arr) => !turns.has(st) || arr >= turns.get(st)[1] - TURN_MARGIN;

  /** Play one service day out from the yard state at its start: gives every run its set
   *  and every depot stay its place; returns the vehicles (runs and spares) and the yard
   *  state the day ends with. */
  function playDay(date, start, runs) {
    const rand = seededRandom(date);
    const pickWeighted = list => {
      let r = rand() * list.reduce((a, e) => a + e.set.weight, 0);
      for (const e of list) { r -= e.set.weight; if (r <= 0) return e; }
      return list[0];
    };
    const yard = {};
    for (const [key, tracks] of Object.entries(YARDS)) {
      yard[key] = tracks.map(t => ({ ...t, occ: start.yard[key][t.i].map((set, k) => ({ set, k, t1: Infinity })) }));
    }
    const outside = [...start.outside];
    const placed = new Set();
    for (const key in yard) for (const t of yard[key]) for (const e of t.occ) placed.add(e.set);
    for (const o of outside) placed.add(o.set);
    // Sets in neither (a bigger fleet than the history knew): wait outside, at no place.
    for (const set of FLEET) if (!placed.has(set)) outside.push({ set, ll: null });

    const front = t => t.occ.reduce((m, e) => (!m || e.k > m.k ? e : m), null);
    const take = (t, e) => t.occ.splice(t.occ.indexOf(e), 1);

    /** A train for run v leaving `depot`: the front of a track of its group if one is
     *  allowed on its line, else of any track, else dug out from wherever it stands. */
    function fromDepot(v, depot) {
      const ok = e => e && !e.own && e.set.lines.includes(v.route);
      const tracks = yard[depot] || [];
      for (const pass of [t => t.group === yardGroup(v.route), () => true]) {
        const fronts = tracks.filter(pass).map(t => [t, front(t)]).filter(([, e]) => ok(e));
        if (fronts.length) {
          const e = pickWeighted(fronts.map(([, e]) => e)), t = fronts.find(([, f]) => f === e)[0];
          take(t, e);
          return { e, t };
        }
      }
      for (const t of tracks) {
        const e = t.occ.filter(ok).sort((a, b) => b.k - a.k)[0];
        if (e) { take(t, e); return { e, t }; }
      }
      return null;
    }
    // Trains that spent the night away from a depot wait at their station in the order
    // they can leave: those at a platform first, then the front train of each tail track.
    const waiting = new Map();
    for (const o of outside) if (o.station) waiting.set(o.station, [...(waiting.get(o.station) || []), o]);
    for (const list of waiting.values()) list.sort((a, b) => (b.plat != null) - (a.plat != null) || b.k - a.k);
    const loose = outside.filter(o => !o.station);        // sets with no known place yet
    /** The train waiting at `station` that run v can take first (one allowed on its line). */
    function fromStation(v, station) {
      const list = waiting.get(station) || [];
      const i = list.findIndex(o => o.set.lines.includes(v.route));
      return i < 0 ? null : list.splice(i, 1)[0];
    }
    function fromLoose(v) {
      const i = loose.findIndex(o => o.set.lines.includes(v.route));
      return i < 0 ? null : loose.splice(i, 1)[0].set;
    }
    /** Place for a train arriving at `depot` that leaves again at t1 (Infinity: not today). */
    function park(depot, v, t1) {
      let best = null, bestScore = Infinity;
      for (const t of yard[depot]) {
        const k = t.occ.length ? Math.max(...t.occ.map(e => e.k)) + 1 : 0;
        if (k >= t.cap || (t.group !== "main" && !v.set.lines.includes(t.group))) continue;
        const blocked = t.occ.filter(e => e.t1 < t1).length;
        // Own group first; never box in a train that leaves earlier; fill tracks one at a time.
        const score = (t.group === yardGroup(v.route) ? 0 : 1e9) + blocked * 1e7 + (t.occ.length ? (t.cap - k) * 1e3 : 1e5) + t.i;
        if (score < bestScore) { bestScore = score; best = { t, k }; }
      }
      return best;
    }

    // Moves in and out of the yards, in time order (departures first at the same moment).
    const events = [];
    for (const v of runs) { v.parks = []; v.startAt = v.endAt = undefined; v.set = null; }
    const today = stationDay(date);
    // Runs starting the day away from a depot, in order of departure: the train waiting at
    // their station, else one pulled out of the depot early that runs there empty.
    const firstDep = v => v.trips[0].start + v.trips[0].p.dep[0];
    for (const v of runs.filter(v => v.legs[0].kind !== "depot").sort((a, b) => firstDep(a) - firstDep(b))) {
      const p = v.trips[0].p, pi = patternIdx.get(p), station = stationOf(p.stops[0]);
      // Only a run leaving before the turnbacks there begin can take a train that waited overnight.
      const o = overnightStart(today.turns, station, firstDep(v)) && fromStation(v, station);
      if (o) { v.set = o.set; v.stable0 = o; continue; }
      const qi = emptyRunTo(station, [v.route], qi => turnPath(qi, pi));
      const q = D.patterns[qi], depot = q && depotFor(q.route, q.stops[0]), outs = depot && D.depots[depot].out[q.s0];
      if (outs) {
        const pull = firstDep(v) - READY - moveTime(turnPath(qi, pi), SHUNT_SPEED) - q.P.len / DEPOT_SPEED - moveTime(paths[outs[0]], DEPOT_SPEED);
        v.emptyFrom = { qi, depot };
        events.push([pull, 0, v, -2]);
        continue;
      }
      v.set = fromLoose(v);
      if (!v.set) { const got = fromDepot(v, homeDepot(FLEET.find(f => f.lines.includes(v.route)))); if (got) v.set = got.e.set; }
      v.freshStart = true;
    }
    // Those with no train from the night before still need a free place of their own: the
    // last to leave first, so they come out front first.
    {
      const taken = new Map();
      for (const o of outside) if (o.station) { const key = o.plat != null ? "p" + D.patterns[o.plat].P.n.at(-1) : o.spot; taken.set(key, Math.max(taken.get(key) || 0, o.k + 1)); }
      for (const v of runs.filter(v => v.freshStart && v.set).sort((a, b) => firstDep(b) - firstDep(a))) {
        const p = v.trips[0].p, dp = lineDepot(v.route), len = TRAIN_TYPES[v.set.type].length;
        const opts = (D.stable.out[p.s0] || []).map(i => ({ spot: paths[i].n[0], k: taken.get(paths[i].n[0]) || 0 })).sort((a, b) => a.k - b.k);
        const o = opts.find(({ spot, k }) => dp.end + k * dp.pitch + len <= (D.stable.room[spot] || 0));
        if (o) { v.stable0 = { spot: o.spot, k: o.k }; taken.set(o.spot, o.k + 1); }
      }
    }
    // Trains ending while others still turn back there, or more than tomorrow's runs need,
    // run on empty to the depot instead, so none blocks a tail track during service; their
    // arrival in the yard is played out with the other moves.
    const arrival = v => v.trips.at(-1).start + v.trips.at(-1).p.arr.at(-1);
    const needs = stationDay(nextDate(date)).starts;
    const at = new Map();                                   // station -> trains ending there tonight
    const endingAway = runs.filter(v => v.legs.at(-1).kind === "hold" && v.legs.at(-1).parked).sort((a, b) => arrival(a) - arrival(b));
    for (const v of endingAway) { const st = stationOf(v.trips.at(-1).p.stops.at(-1)); at.set(st, (at.get(st) || 0) + 1); }
    for (const v of endingAway) {
      const A = v.trips.at(-1).p, Ai = patternIdx.get(A), station = stationOf(A.stops.at(-1));
      if (overnightEnd(today.turns, station, arrival(v)) && (at.get(station) || 0) <= (needs.get(station) || []).length) continue;
      const ri = D.patterns.findIndex((r, ri) => r.route === v.route && stationOf(r.stops[0]) === station &&
        depotFor(r.route, r.stops.at(-1)) && D.depots[depotFor(r.route, r.stops.at(-1))].in[r.s1] && turnPath(Ai, ri));
      if (ri < 0) continue;
      const r = D.patterns[ri], depot = depotFor(r.route, r.stops.at(-1));
      const t = arrival(v) + UNLOAD + moveTime(turnPath(Ai, ri), SHUNT_SPEED) + r.P.len / DEPOT_SPEED + moveTime(paths[D.depots[depot].in[r.s1][0]], DEPOT_SPEED);
      v.homeTo = { ri, depot };
      events.push([t, 1, v, v.stays.length]);
      at.set(station, at.get(station) - 1);
    }
    for (const v of runs) {
      v.stays.forEach((s, j) => {
        if (s.t0 > DAY_START) events.push([s.t0, 1, v, j]);
        if (s.t1 < DAY_END) events.push([s.t1, 0, v, j]);
      });
    }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[4] || 0) - (b[4] || 0));
    const endOutside = [];
    for (const [t, arrive, v, j] of events) {
      const s = v.stays[j];
      if (j === -2) {                               // pulled out early to run empty to its first station
        const got = fromDepot(v, v.emptyFrom.depot);
        if (got) {
          v.set = got.e.set;
          v.deadhead = { ...v.emptyFrom, slot: got.t.i, k: got.e.k };
          if (got.e.from) { got.e.from.endAt = got.e.arrived; v.startAt = got.e.arrived; }
        } else v.set = fromLoose(v);
        continue;
      }
      if (!arrive) {
        if (v.own) {                                // leaving after a layover in the depot
          take(v.own.t, v.own.e);
          v.own = null;
          continue;
        }
        if (v.set) continue;                        // laid over without a place (yard full)
        // A train that spent the night at the depot station (depot full) goes first.
        const o = s.t0 === DAY_START && fromStation(v, stationOf(v.trips[0].p.stops[0]));
        if (o) { v.set = o.set; v.stable0 = o; v.noDepotStart = true; continue; }
        const got = fromDepot(v, s.depot) || (() => { const set = fromLoose(v); return set && { e: { set } }; })();
        if (!got) continue;
        v.set = got.e.set;
        if (got.t) v.parks[j] = { slot: got.t.i, k: got.e.k };
        if (got.e.from) { got.e.from.endAt = got.e.arrived; v.startAt = got.e.arrived; }   // came in earlier today
        continue;
      }
      if (!v.set) { if (v.homeTo && j === v.stays.length) v.homeTo = null; continue; }
      if (v.homeTo && j === v.stays.length) {                 // back from a station, empty
        const place = park(v.homeTo.depot, v, Infinity);
        if (!place) { v.homeTo = null; continue; }
        place.t.occ.push({ set: v.set, k: place.k, t1: Infinity, from: v, arrived: t });
        v.parks[j] = { slot: place.t.i, k: place.k };
        Object.assign(v.homeTo, { slot: place.t.i, k: place.k });
        continue;
      }
      const leaves = s.t1 < DAY_END ? s.t1 : Infinity;
      const at = park(s.depot, v, leaves);
      if (!at) { if (leaves === Infinity) v.noDepotEnd = true; continue; }   // depot full: stays out at the station
      const e = { set: v.set, k: at.k, t1: leaves, from: leaves === Infinity ? v : null, arrived: t, own: leaves !== Infinity };
      at.t.occ.push(e);
      v.parks[j] = { slot: at.t.i, k: at.k };
      if (e.own) v.own = { t: at.t, e };
    }
    // Who stands where away from the depots, and until when: trains not taken today stay
    // all day, those that spent the night there until they move off this morning.
    const standing = new Map();                             // tail end node or "p"+platform node -> [{k, until}]
    const placeKey = o => o.plat != null ? "p" + D.patterns[o.plat].P.n.at(-1) : o.spot;
    const stand = (key, k, until) => standing.set(key, [...(standing.get(key) || []), { k, until }]);
    const stayed = [...waiting.values()].flat();
    for (const o of stayed) stand(placeKey(o), o.k, Infinity);
    for (const v of runs) if (v.stable0) stand(placeKey(v.stable0), v.stable0.k, v.trips[0].start + v.trips[0].p.dep[0] - READY);
    /** Next free place (k) at `key` for a train arriving at t: in front of all still there. */
    const nextK = (key, t) => (standing.get(key) || []).filter(e => e.until > t).reduce((m, e) => Math.max(m, e.k + 1), 0);
    // Tomorrow's runs that start away from a depot need a train at their station. Where
    // fewer end there tonight, the last trains bound for the depot run on empty to spend
    // the night in that station's tail tracks, as far as they hold; the rest come out of
    // the depot early tomorrow.
    for (const o of stayed) at.set(o.station, (at.get(o.station) || 0) + 1);
    const homeward = runs.filter(v => v.set && !v.endAt && !v.noDepotEnd && v.legs.at(-1).kind === "depot")
      .sort((a, b) => arrival(b) - arrival(a));
    for (const [station, firsts] of stationDay(nextDate(date)).starts) {
      let short = firsts.length - (at.get(station) || 0);
      for (const v of homeward) {
        if (short <= 0) break;
        if (v.sendTo != null) continue;
        const A = v.trips.at(-1).p, Ai = patternIdx.get(A), routes = firsts.map(t => t.p.route).filter(r => v.set.lines.includes(r));
        const qi = emptyRunTo(station, routes, qi => stationOf(D.patterns[qi].stops[0]) === stationOf(A.stops.at(-1)) && turnPath(Ai, qi));
        if (qi < 0) continue;
        // Room left in the station's tail tracks for this train.
        const q = D.patterns[qi], dp = lineDepot(v.route), len = TRAIN_TYPES[v.set.type].length;
        const room = (D.stable.in[q.s1] || []).reduce((a, i) => {
          const r = (D.stable.room[paths[i].n.at(-1)] || 0) - dp.end - len;
          return a + (r >= 0 ? Math.floor(r / dp.pitch) + 1 : 0);
        }, 0);
        if ((at.get(station) || 0) >= room) break;
        for (const t of Object.values(yard).flat()) { const e = t.occ.find(e => e.from === v); if (e) take(t, e); }
        v.sendTo = qi; v.noDepotEnd = true;
        at.set(station, (at.get(station) || 0) + 1);
        short--;
      }
    }
    // Trains ending the day away from a depot, in order of arrival: into the tail tracks
    // as far as each holds, then at the platform behind them.
    const evening = runs.filter(v => v.set && !v.homeTo && (v.noDepotEnd || (v.legs.at(-1).kind === "hold" && v.legs.at(-1).parked)));
    for (const v of evening.sort((a, b) => arrival(a) - arrival(b))) {
      const A = v.sendTo != null ? D.patterns[v.sendTo] : v.trips.at(-1).p, dp = lineDepot(v.route), len = TRAIN_TYPES[v.set.type].length;
      const t = arrival(v);
      let place = null;
      // The emptiest tail track it fits on, else the platform.
      const opts = (D.stable.in[A.s1] || []).map(i => ({ i, spot: paths[i].n.at(-1), k: nextK(paths[i].n.at(-1), t) })).sort((a, b) => a.k - b.k);
      for (const { i, spot, k } of opts) {
        if (dp.end + k * dp.pitch + len <= (D.stable.room[spot] || 0)) { place = { tail: i, spot, k }; stand(spot, k, Infinity); break; }
      }
      if (!place) {
        const key = "p" + A.P.n.at(-1), k = nextK(key, t);
        stand(key, k, Infinity);
        place = { plat: patternIdx.get(A), k };
      }
      v.stable1 = place;
      endOutside.push({ set: v.set, station: stationOf(A.stops.at(-1)), stop: A.stops.at(-1), ...place });
    }
    // Runs left without a set (more runs than trains): any set allowed on the line.
    for (const v of runs) if (!v.set) v.set = FLEET.find(f => f.lines.includes(v.route));

    // Trains in the yard, or stabled away from it, all day: spares.
    const list = [...runs];
    for (const o of stayed) {
      list.push({ key: `${date}/spare/${o.set.id}`, route: o.set.lines[0], run: null, spare: true, set: o.set, trips: [], stays: [], parks: [], outside: o });
    }
    for (const [key, tracks] of Object.entries(yard)) {
      for (const t of tracks) for (const e of t.occ) {
        if (e.t1 !== Infinity || e.from) continue;
        list.push({ key: `${date}/spare/${e.set.id}`, route: e.set.lines[0], run: null, spare: true, set: e.set, trips: [],
                    stays: [{ depot: key, t0: DAY_START, t1: DAY_END }], parks: [{ slot: t.i, k: e.k }] });
      }
    }
    // Next morning's yard: gaps left by trains dug out closed up, in order; trains that
    // stood outside all day unused are taken back in overnight (at the front of a track).
    const end = { yard: {}, outside: [...endOutside, ...stayed] };
    for (const [key, tracks] of Object.entries(yard)) end.yard[key] = tracks.map(t => t.occ.sort((a, b) => a.k - b.k).map(e => e.set));
    // Sets with no place yet go into their depot, or when it is full wait at its station's platform.
    for (const { set } of loose) {
      const key = homeDepot(set), t = YARDS[key].find(t => end.yard[key][t.i].length < t.cap && (t.group === "main" || set.lines.includes(t.group)));
      if (t) { end.yard[key][t.i].push(set); continue; }
      const A = D.patterns.find(p => set.lines.includes(p.route) && depotFor(p.route, p.stops.at(-1)) === key);
      if (!A) continue;
      const pk = "p" + A.P.n.at(-1), k = nextK(pk, DAY_END);
      stand(pk, k, Infinity);
      end.outside.push({ set, station: stationOf(A.stops.at(-1)), stop: A.stops.at(-1), plat: patternIdx.get(A), k });
    }
    return { list, end };
  }

  // ---------- Keeping trains apart ----------
  // Each train's moves are timed from its own timetable; these two passes make trains
  // that would meet on the same track wait instead.

  /** Track edges a move leg runs over. */
  const edgeKey = (a, b) => a < b ? a * 65536 + b : b * 65536 + a;   // track edge between two nodes
  const edgeLen = e => nodeDist(Math.floor(e / 65536), e % 65536);
  function moveEdges(l) {
    if (l._edges) return l._edges;           // the path and stretch of a leg never change, only its times
    const { P } = l, lo = Math.min(l.d0, l.d1), hi = Math.max(l.d0, l.d1), out = [];
    for (let i = 1; i < P.n.length; i++) {
      if (P.cum[i] > lo && P.cum[i - 1] < hi && P.n[i] !== P.n[i - 1]) out.push(edgeKey(P.n[i], P.n[i - 1]));
    }
    return (l._edges = out);
  }
  /** Runs of consecutive legs with one move status (with the stops to change ends between). */
  function moveRuns(v, status) {
    const out = [];
    for (let i = 0; i < v.legs.length; i++) {
      if (v.legs[i].kind !== "move" || v.legs[i].status !== status) continue;
      let j = i;
      while (j + 2 < v.legs.length && v.legs[j + 1].status === "changingEnds" && v.legs[j + 2].status === status) j += 2;
      const edges = new Set();
      for (let k = i; k <= j; k++) if (v.legs[k].kind === "move") for (const e of moveEdges(v.legs[k])) edges.add(e);
      out.push({ v, i, j, t0: v.legs[i].t0, t1: v.legs[j].t1, edges });
      i = j;
    }
    return out;
  }
  /** Whether two runs of moves share at least 30 m of track. */
  const shares = (a, b) => {
    if (a.edges.size > b.edges.size) [a, b] = [b, a];
    let m = 0;
    for (const e of a.edges) {
      if (!b.edges.has(e)) continue;
      if ((m += edgeLen(e)) >= 30) return true;
    }
    return false;
  };
  /** When a run is on each track edge it uses: edge -> [first on, last off], counting the
   *  train's length (moving) and the track under it while it stands (changing ends). */
  function edgeTimes(r) {
    if (r.times && r.at === r.t0) return r.times;
    const out = new Map();
    const add = (e, t0, t1) => { const o = out.get(e); out.set(e, o ? [Math.min(o[0], t0), Math.max(o[1], t1)] : [t0, t1]); };
    for (let k = r.i; k <= r.j; k++) {
      const l = r.v.legs[k], { P } = l;
      if (!P) continue;
      const half = TRAIN_TYPES[r.v.set.type].length / 2;
      const lo = l.kind === "move" ? Math.min(l.d0, l.d1) : l.d - half, hi = l.kind === "move" ? Math.max(l.d0, l.d1) : l.d + half;
      for (let i = 1; i < P.n.length; i++) {
        if (!(P.cum[i] > lo && P.cum[i - 1] < hi) || P.n[i] === P.n[i - 1]) continue;
        const e = edgeKey(P.n[i], P.n[i - 1]);
        if (l.kind !== "move") { add(e, l.t0, l.t1); continue; }
        const at = c => l.t0 + (l.d1 !== l.d0 ? Math.max(0, Math.min(1, (c - l.d0) / (l.d1 - l.d0))) : 0) * (l.t1 - l.t0);
        const ta = at(P.cum[i - 1]), tb = at(P.cum[i]);
        add(e, Math.min(ta, tb) - 8, Math.max(ta, tb) + 8);       // ~8 s for a train's length to pass
      }
    }
    r.times = out; r.at = r.t0;
    return out;
  }
  /** How long run m must wait so it is on no track edge while run o is (0: they don't meet). */
  function waitFor(m, o) {
    if (o.v === m.v || !(o.t0 < m.t1 + 10 && m.t0 < o.t1 + 10) || !shares(m, o)) return 0;
    const a = edgeTimes(m), b = edgeTimes(o);
    let dt = 0;
    for (const [e, [a0, a1]] of a) {
      const t = b.get(e);
      if (t && a0 < t[1] && t[0] < a1) dt = Math.max(dt, t[1] - a0 + 2);
    }
    return dt;
  }
  const meets = (m, o) => waitFor(m, o) > 0;
  const NON_SERVICE_MOVES = ["reversing", "shunting", "leavingDepot", "toDepot"];
  const nonServiceRuns = v => NON_SERVICE_MOVES.flatMap(st => moveRuns(v, st));

  /** Turnbacks where following trains would meet in a tail track (or one meets a train
   *  coming out of the depot) take the other route there, e.g. the other tail track. */
  /** Runs indexed by the track edges they use, to compare each only with those it shares track with. */
  const BUCKET = 900;                      // s: runs are indexed per track edge and quarter of an hour
  function runIndex(runs, margin = 30) {
    const idx = new Map();
    let stamp = 0;
    const keys = (r, f) => { for (let b = Math.floor((r.t0 - margin) / BUCKET); b <= Math.floor((r.t1 + margin) / BUCKET); b++) for (const e of r.edges) f(e * 128 + (b & 127)); };
    const add = r => keys(r, k => { const l = idx.get(k); if (l) l.push(r); else idx.set(k, [r]); });
    const remove = v => { for (const l of idx.values()) for (let i = l.length - 1; i >= 0; i--) if (l[i].v === v) l.splice(i, 1); };
    /** Runs sharing a track edge with m at about the same time (each once). */
    const near = m => {
      const out = [], s = ++stamp;
      keys(m, k => { for (const o of idx.get(k) || []) if (o._seen !== s) { o._seen = s; out.push(o); } });
      return out;
    };
    runs.forEach(add);
    return { add, remove, near };
  }

  function chooseTurns(list) {
    const idx = runIndex(list.flatMap(nonServiceRuns));
    const meetsAny = m => { for (const o of idx.near(m)) if (meets(m, o)) return true; return false; };
    const turns = list.flatMap(v => [...moveRuns(v, "reversing"), ...moveRuns(v, "shunting")]).filter(m => m.v.legs[m.i].turnK != null).sort((a, b) => a.t0 - b.t0);
    for (const m of turns) {
      if (m.v.legs[m.i] === undefined || !meetsAny(m)) continue;
      const v = m.v, k = v.legs[m.i].turnK;
      const t = D.turns[`${patternIdx.get(v.trips[k].p)}>${patternIdx.get(v.trips[k + 1].p)}`];
      if (!t || t.length < 2) continue;
      const use = alt => {
        v.turnAlt = { ...v.turnAlt, [k]: alt };
        v.legs = buildLegs(v);
        idx.remove(v);
        const runs = nonServiceRuns(v);
        runs.forEach(idx.add);
        return runs.find(o => v.legs[o.i].turnK === k);
      };
      const m2 = use(1);
      if (!m2 || meetsAny(m2)) use(0);
    }
  }

  /** Delay legs i..j of v by dt, stretching the standing leg before them and shortening
   *  the one after; false (and nothing changed) if the one after can't absorb it. */
  function delay(v, i, j, dt) {
    const before = v.legs[i - 1], after = v.legs[j + 1];
    if (!before || before.kind === "move" || (after && after.t0 + dt >= after.t1 - 1)) return false;
    before.t1 += dt;
    for (let k = i; k <= j; k++) { v.legs[k].t0 += dt; v.legs[k].t1 += dt; }
    if (after) after.t0 += dt;
    return true;
  }

  /** Move legs i..j of v dt earlier, starting sooner from the standing leg before them and
   *  standing longer at the one after; false (nothing changed) if that can't be done. */
  function advance(v, i, j, dt) {
    const before = v.legs[i - 1], after = v.legs[j + 1];
    if (!before || !after || before.kind === "move" || after.kind === "move" || before.t1 - dt <= before.t0 + 1) return false;
    before.t1 -= dt;
    for (let k = i; k <= j; k++) { v.legs[k].t0 -= dt; v.legs[k].t1 -= dt; }
    after.t0 -= dt;
    return true;
  }
  /** Platform node a standing leg is at (path start or end), or null. */
  const holdNode = l => l.kind === "hold" && l.P ? (l.d <= 0.01 ? l.P.n[0] : l.d >= l.P.len - 0.01 ? l.P.n.at(-1) : null) : null;
  /** Standing legs by platform node and hour (a leg is listed under each hour it spans, with
   *  a few minutes' margin as legs may still shift): at(node, t) -> [[vehicle, leg]] there then. */
  function holdsByNode(list) {
    const idx = new Map(), H = 3600, M = 600;
    for (const v of list) for (const l of v.legs) {
      const n = holdNode(l);
      if (n == null) continue;
      for (let h = Math.floor((l.t0 - M) / H); h <= Math.floor((l.t1 + M) / H); h++) {
        const k = n * 64 + (h & 63), a = idx.get(k);
        if (a) a.push([v, l]); else idx.set(k, [[v, l]]);
      }
    }
    return { at: (n, t) => idx.get(n * 64 + (Math.floor(t / H) & 63)) || [] };
  }
  /** Whether nobody else stands at the platform node of hold leg h between t0 and t1. */
  function platformFree(byNode, v, h, t0, t1) {
    const n = holdNode(h);
    return n != null && ![...byNode.at(n, t0), ...byNode.at(n, t1)].some(([w, l]) => w !== v && l.t0 < t1 && l.t1 > t0);
  }

  function keepApart(list) {
    const byNode = holdsByNode(list);
    // Into the depot, or turning back via a tail track: a train waits at the platform (up to
    // three minutes) until those coming out of the depot have cleared the track both need.
    const outs = list.flatMap(v => moveRuns(v, "leavingDepot"));
    for (const m of list.flatMap(v => [...moveRuns(v, "toDepot"), ...moveRuns(v, "reversing")])) {
      for (let guard = 0; guard < 4; guard++) {
        let dt = 0, worst = null;
        for (const o of outs) { const w = waitFor(m, o); if (w > dt) { dt = w; worst = o; } }
        if (!dt) break;
        if (dt <= 180 && delay(m.v, m.i, m.j, dt)) { m.t0 += dt; m.t1 += dt; continue; }
        // Otherwise the train coming out leaves the depot that much earlier and waits longer
        // at its platform, if the platform is free then.
        const o = worst, after = o.v.legs[o.j + 1];
        if (dt <= 300 && after && platformFree(byNode, o.v, after, after.t0 - dt, after.t0) && advance(o.v, o.i, o.j, dt)) {
          o.t0 -= dt; o.t1 -= dt;
          continue;
        }
        break;
      }
    }
    // Out of the depot one after another: of two that would come out together, the one due
    // at its platform first leaves the yard that much earlier.
    const order = [...outs].sort((a, b) => a.t1 - b.t1);
    for (let x = 1; x < order.length; x++) {
      for (let y = x - 1; y >= 0 && y >= x - 6; y--) {
        const first = order[y], dt = meets(order[x], first) ? waitFor(first, order[x]) : 0;
        const after = first.v.legs[first.j + 1];
        if (dt > 0 && dt <= 300 && after && platformFree(byNode, first.v, after, after.t0 - dt, after.t0) && advance(first.v, first.i, first.j, dt)) {
          first.t0 -= dt; first.t1 -= dt;
        }
      }
    }
    // Into a tail track to change ends: a train waits at the arrival platform until the one
    // before it has left that tail.
    const nodeAt = (P, d) => d <= 0.01 ? P.n[0] : d >= P.len - 0.01 ? P.n.at(-1) : null;
    const tails = new Map();
    for (const v of list) for (const l of v.legs) {
      if (l.kind === "hold" && l.status === "changingEnds") { const n = nodeAt(l.P, l.d); if (n != null) { const a = tails.get(n); if (a) a.push([v, l]); else tails.set(n, [[v, l]]); } }
    }
    for (const v of list) {
      for (let i = 2; i + 2 < v.legs.length; i++) {
        const h = v.legs[i], m = v.legs[i - 1];
        if (h.kind !== "hold" || h.status !== "changingEnds" || m.kind !== "move" || v.legs[i + 1].kind !== "move") continue;
        const busy = (tails.get(nodeAt(h.P, h.d)) || []).filter(([w, o]) => w !== v && o.t0 < h.t1 + 5 && o.t1 > m.t0 - 5 && o.t0 <= h.t0);
        if (!busy.length) continue;
        // Wait until the other has changed ends and pulled out again.
        const free = Math.max(...busy.map(([w, o]) => { const k = w.legs.indexOf(o); return (w.legs[k + 1] || o).t1; })) + 5;
        if (free > m.t0) delay(v, i - 1, i + 1, free - m.t0);
      }
    }
    // Onto a platform: a train turning back (or coming out to its first trip) waits on
    // the tail track until the train standing at that platform has left.
    const nodeOf = holdNode, standing = byNode;
    for (const v of list) {
      for (let i = 1; i < v.legs.length; i++) {
        const l = v.legs[i], m = v.legs[i - 1];
        if (l.kind !== "hold" || m.kind !== "move" || !["waiting", "readyFirst"].includes(l.status)) continue;
        const n = nodeOf(l);
        // Others standing at that platform while this one would, and leaving before it does:
        // they are ahead of it there, so it pulls in only once they have gone.
        const busy = [];
        if (n != null) for (let t = m.t1; t < l.t1 + 3600; t += 3600) for (const x of standing.at(n, Math.min(t, l.t1))) {
          const [w, h] = x;
          if (w !== v && h.t0 < l.t1 && h.t1 > m.t1 && h.t1 <= l.t1 && !busy.includes(x)) busy.push(x);
        }
        if (!busy.length) continue;
        const free = Math.max(...busy.map(([, h]) => h.t1)) + 15;
        delay(v, i - 1, i - 1, free - m.t1);
      }
    }
  }

  // ---------- Vehicles (runs) per service day ----------
  const dayCache = new Map();
  const prevDate = date => shiftDay({ year: +date.slice(0, 4), month: +date.slice(4, 6), day: +date.slice(6, 8) }, -1);

  /** The runs of a service day with their legs, before sets and yard places are known. */
  function dayRuns(date) {
    const runs = new Map();
    for (const trip of trips) {
      if (!calendars[trip.cal].has(date)) continue;
      const key = `${trip.p.route}/${trip.run}`;
      if (!runs.has(key)) runs.set(key, { key: `${date}/${key}`, route: trip.p.route, run: trip.run, trips: [] });
      runs.get(key).trips.push(trip);
    }
    const list = [...runs.values()];
    for (const v of list) {
      v.trips.sort((a, b) => a.start - b.start);
      v.legs = buildLegs(v);
    }
    return list;
  }

  /** A day played out: which set works each run and where every train stands overnight.
   *  Earlier days are played out only for the yard they leave behind. */
  function planDay(date, depth = HISTORY) {
    if (dayCache.has(date)) return dayCache.get(date);
    const start = depth > 0 ? planDay(prevDate(date), depth - 1).end : baseYard();
    const plan = { ...playDay(date, start, dayRuns(date)), ready: false };
    if (dayCache.size > 8) dayCache.delete(dayCache.keys().next().value);
    dayCache.set(date, plan);
    return plan;
  }
  /** The day's trains with their movements, routed to each one's own place and kept apart. */
  function vehiclesFor(date) {
    const plan = planDay(date);
    if (!plan.ready) {
      for (const v of plan.list) v.legs = v.spare ? spareLegs(v) : buildLegs(v);
      // Waits can make trains meet that didn't before, so choose routes again after them.
      chooseTurns(plan.list);
      keepApart(plan.list);
      chooseTurns(plan.list);
      keepApart(plan.list);
      plan.ready = true;
    }
    return plan.list;
  }

  /**
   * Legs: {t0, t1, kind, ...}
   *   trip:  in service along the pattern path
   *   move:  non-revenue move along path P from d0 to d1
   *   hold:  standing on path P at distance d (platform, tail, siding)
   *   depot: parked on a depot yard track (node)
   */
  function buildLegs(v) {
    const legs = [];
    const T = v.trips;
    const push = (t0, t1, leg) => { if (t1 > t0) legs.push(Object.assign({ t0, t1 }, leg)); };
    v.stays = [];

    /** Natural duration of a move along P, including reversal stops. */

    /** Add move legs along P (from distance `from` to `to`) between t0 and t1, stopping at
     *  reversal points. Where it reverses at the end of a tail track, the train runs in only
     *  until its front is at the buffer stop and comes back out from there. */
    function addMove(P, t0, t1, status, extra, from = 0, to = P.len) {
      const pieces = [];
      let last = from;
      const len = v.set ? TRAIN_TYPES[v.set.type].length : lineDepot(v.route).pitch;
      const rvd = P.rvd.filter(r => r > from && r < to);
      for (const r of rvd) {
        const room = D.stable.room[P.rvn[P.rvd.indexOf(r)]];
        const c = room == null ? 0 : Math.max(0, Math.min(STOP_SHORT + len / 2, room - len / 2));
        pieces.push([last, r - c]);
        last = r + c;
      }
      pieces.push([last, to]);
      const holdT = Math.min(REV_HOLD, (t1 - t0) * 0.2 / Math.max(1, rvd.length));
      const runT = (t1 - t0) - holdT * rvd.length;
      let t = t0;
      const total = pieces.reduce((s, [x, y]) => s + Math.abs(y - x), 0) || 1;
      pieces.forEach(([a, b], i) => {
        const dt = runT * Math.abs(b - a) / total;
        push(t, t + dt, { kind: "move", P, d0: a, d1: b, status, ...extra });
        t += dt;
        if (i < pieces.length - 1) {
          push(t, t + holdT, { kind: "hold", P, d: b, status: "changingEnds", ...extra });
          t += holdT;
        }
      });
    }

    /** Track and place for the depot stay starting now: the slot, and the train centre's
     *  distance from the track's buffer stop (trains park nose to tail from the end). */
    const park = depot => {
      const dp = D.depots[depot], j = v.stays.length, a = v.parks && v.parks[j];
      const len = v.set ? TRAIN_TYPES[v.set.type].length : dp.pitch;
      const k = a ? a.k : 0;
      return { slot: a ? a.slot : v.run % dp.slots.length, c: dp.end + k * dp.pitch + len / 2 };
    };
    /** Parked leg: standing at the place on the path in (or out of) the yard. */
    const parkedLeg = (t0, t1, depot, slot, P, d, extra) => {
      v.stays.push({ depot, t0, t1 });
      push(t0, t1, { kind: "depot", depot, node: D.depots[depot].slots[slot], P, d, ...extra });
    };
    /** Train centre's distance from the end of a stabling siding or tail track for the
     *  k-th train standing there (k = 0 at the buffer stop), like places in a depot. */
    const stableAt = (k = 0) => {
      const dp = lineDepot(v.route);
      return dp.end + k * dp.pitch + (v.set ? TRAIN_TYPES[v.set.type].length : dp.pitch) / 2;
    };
    /** Train centre on path P for the k-th train stopped behind its end (a platform). */
    const behind = (P, k = 0) => Math.max(0, P.len - k * lineDepot(v.route).pitch);
    const firstStop = trip => trip.p.stops[0];
    const lastStop = trip => trip.p.stops.at(-1);

    // Before the first trip.
    {
      const first = T[0], p = first.p, dep = first.start + p.dep[0];
      const nextInfo = { nextTrip: first };
      let depot = depotFor(v.route, firstStop(first));
      if (depot && v.noDepotStart) { v.stays.push({ depot: null, t0: 0, t1: 0 }); depot = null; }   // keeps stay numbering
      const outs = depot && D.depots[depot].out[p.s0];
      const pk = depot && park(depot);
      if (outs && outs[pk.slot] != null) {
        const P = paths[outs[pk.slot]];
        const dt = moveTime(P, DEPOT_SPEED);
        parkedLeg(v.startAt ?? DAY_START, dep - READY - dt, depot, pk.slot, P, pk.c, nextInfo);
        addMove(P, dep - READY - dt, dep - READY, "leavingDepot", nextInfo, pk.c);
      } else if (v.deadhead) {
        // Pulled out of the depot early and run empty to the station its first trip leaves from.
        const dh = v.deadhead, q = D.patterns[dh.qi], dp = D.depots[dh.depot];
        const Po = paths[dp.out[q.s0][dh.slot]], Pt = turnPath(dh.qi, patternIdx.get(p));
        const tTurn = moveTime(Pt, SHUNT_SPEED), tRun = q.P.len / DEPOT_SPEED, tOut = moveTime(Po, DEPOT_SPEED);
        const c = dp.end + dh.k * dp.pitch + (v.set ? TRAIN_TYPES[v.set.type].length : dp.pitch) / 2;
        let t = dep - READY - tTurn - tRun - tOut;
        push(v.startAt ?? DAY_START, t, { kind: "depot", depot: dh.depot, node: dp.slots[dh.slot], P: Po, d: c, ...nextInfo });
        addMove(Po, t, t + tOut, "leavingDepot", nextInfo, c); t += tOut;
        addMove(q.P, t, t + tRun, "emptyRun", nextInfo); t += tRun;
        addMove(Pt, t, t + tTurn, "toPlatform", nextInfo);
      } else if (v.stable0 && v.stable0.plat != null) {
        // Spent the night at the platform it arrived at: over to the departure platform if that differs.
        const sb = v.stable0, A = D.patterns[sb.plat], Pt = turnPath(sb.plat, patternIdx.get(p));
        if (A.P !== p.P && Pt && Pt.len >= 5) {
          const dt = moveTime(Pt, SHUNT_SPEED);
          push(DAY_START, dep - READY - dt, { kind: "hold", P: A.P, d: behind(A.P, sb.k), parked: true, status: "stabled", stop: A.stops.at(-1), ...nextInfo });
          addMove(Pt, dep - READY - dt, dep - READY, "toPlatform", nextInfo);
        } else {
          // No route between the two platforms on record: it waits in its place and appears at
          // the departure platform when due.
          push(DAY_START, dep - READY, { kind: "hold", P: A.P, d: behind(A.P, sb.k), parked: true, status: "stabled", stop: A.stops.at(-1), ...nextInfo });
        }
      } else {
        // On a tail track or siding: the one it spent the night on, at its place there.
        const opts = D.stable.out[p.s0] || [], sb = v.stable0;
        const i = (sb && opts.find(i => paths[i].n[0] === sb.spot)) ?? opts[0];
        const P = i != null ? paths[i] : p.P;
        const dt = P === p.P ? 0 : moveTime(P, SHUNT_SPEED);
        const d = P === p.P ? 0 : Math.min(P.len, stableAt(sb ? sb.k : 0));
        push(DAY_START, dep - READY - dt, { kind: "hold", P, d, parked: true, status: "stabled", stop: firstStop(first), ...nextInfo });
        if (dt) addMove(P, dep - READY - dt, dep - READY, "toPlatform", nextInfo, d);
      }
      push(Math.max(DAY_START, dep - READY), dep, { kind: "hold", P: p.P, d: 0, status: "readyFirst", stop: firstStop(first), ...nextInfo });
    }

    for (let k = 0; k < T.length; k++) {
      const A = T[k], pA = A.p, B = T[k + 1];
      const ta = A.start + pA.arr.at(-1), endStop = lastStop(A);
      push(A.start + pA.dep[0], ta, { kind: "trip", trip: A });
      const arrived = { kind: "hold", P: pA.P, d: pA.P.len, stop: endStop };
      const depot = depotFor(v.route, endStop);
      const tb = B ? B.start + B.p.dep[0] : 0;

      if (!B) {
        // After the last trip: depot or stabling siding until the end of the service day.
        push(ta, ta + UNLOAD, { ...arrived, status: "terminating" });
        const ins = depot && !v.noDepotEnd && D.depots[depot].in[pA.s1];
        const pk = ins && park(depot);
        if (ins && ins[pk.slot] != null) {
          const P = paths[ins[pk.slot]], dt = moveTime(P, DEPOT_SPEED);
          addMove(P, ta + UNLOAD, ta + UNLOAD + dt, "toDepot", {}, 0, P.len - pk.c);
          parkedLeg(ta + UNLOAD + dt, v.endAt ?? DAY_END, depot, pk.slot, P, P.len - pk.c, {});
        } else if (v.homeTo) {
          // No run starts here tomorrow: back to the depot empty after the last trip.
          const h = v.homeTo, r = D.patterns[h.ri], dp = D.depots[h.depot];
          const Pt = turnPath(patternIdx.get(pA), h.ri), Pi = paths[dp.in[r.s1][h.slot]];
          const len = v.set ? TRAIN_TYPES[v.set.type].length : dp.pitch, c = dp.end + h.k * dp.pitch + len / 2;
          let t = ta + UNLOAD;
          const dTurn = moveTime(Pt, SHUNT_SPEED), dRun = r.P.len / DEPOT_SPEED, dIn = moveTime(Pi, DEPOT_SPEED);
          addMove(Pt, t, t + dTurn, "toDepot", {}); t += dTurn;
          addMove(r.P, t, t + dRun, "toDepot", {}); t += dRun;
          addMove(Pi, t, t + dIn, "toDepot", {}, 0, Pi.len - c); t += dIn;
          parkedLeg(t, v.endAt ?? DAY_END, h.depot, h.slot, Pi, Pi.len - c, {});
        } else {
          let A = pA, t = ta + UNLOAD;
          if (v.sendTo != null) {
            // Runs on empty to spend the night at a station where a run starts tomorrow.
            const q = D.patterns[v.sendTo], Pt = turnPath(patternIdx.get(pA), v.sendTo);
            const dTurn = moveTime(Pt, SHUNT_SPEED), dRun = q.P.len / DEPOT_SPEED;
            addMove(Pt, t, t + dTurn, "toStabling", {}); t += dTurn;
            addMove(q.P, t, t + dRun, "toStabling", {}); t += dRun;
            A = q;
          }
          // Away from a depot: into a tail track or siding, or stays at the platform.
          const sb = v.stable1, i = sb ? sb.tail : (D.stable.in[A.s1] || [])[0];
          if (i == null) push(t, DAY_END, { kind: "hold", P: A.P, d: behind(A.P, sb ? sb.k : 0), stop: A.stops.at(-1), parked: true, status: "stabled" });
          else {
            const P = paths[i], dt = moveTime(P, SHUNT_SPEED), d = Math.max(0, P.len - stableAt(sb ? sb.k : 0));
            addMove(P, t, t + dt, "toSiding", {}, 0, d);
            push(t + dt, DAY_END, { kind: "hold", P, d, parked: true, status: "stabled", stop: A.stops.at(-1) });
          }
        }
        break;
      }

      const nextInfo = { nextTrip: B };
      const ins = depot && D.depots[depot].in[pA.s1], outs = depot && D.depots[depot].out[B.p.s0];
      const pk = depot ? park(depot) : null, slot = pk ? pk.slot : 0;
      const Pi = ins && paths[ins[slot]], Po = outs && paths[outs[slot]];
      const di = Pi ? moveTime(Pi, DEPOT_SPEED) : 0, dout = Po ? moveTime(Po, DEPOT_SPEED) : 0;
      // Into the depot only for a real rest there, not a few minutes between two runs in and out.
      if (depot && tb - ta > DEPOT_GAP && Pi && Po && tb - ta - UNLOAD - di - dout - READY >= DEPOT_MIN_STAY) {
        push(ta, ta + UNLOAD, { ...arrived, status: "terminating", ...nextInfo });
        addMove(Pi, ta + UNLOAD, ta + UNLOAD + di, "toDepot", nextInfo, 0, Pi.len - pk.c);
        parkedLeg(ta + UNLOAD + di, tb - READY - dout, depot, slot, Pi, Pi.len - pk.c, nextInfo);
        addMove(Po, tb - READY - dout, tb - READY, "leavingDepot", nextInfo, pk.c);
        push(tb - READY, tb, { kind: "hold", P: B.p.P, d: 0, status: "waiting", stop: firstStop(B), ...nextInfo });
        continue;
      }

      // Turnback: the routed path tells whether the train runs into a tail track
      // and reverses (path with a reversal point beyond the station) or already
      // arrived on its departure platform (zero-length path, reverses in place).
      // The route chosen to keep clear of other trains (keepApart), else the best one.
      const P = turnPath(patternIdx.get(pA), patternIdx.get(B.p), v.turnAlt && v.turnAlt[k]);
      const gap = tb - ta;
      if (!P || P.len < 5) {
        push(ta, tb, { kind: "hold", P: B.p.P, d: 0, status: "waiting", stop: firstStop(B), ...nextInfo });
        continue;
      }
      const u = Math.min(UNLOAD, gap * 0.15);
      const dt = Math.min(moveTime(P, SHUNT_SPEED), Math.max(gap - u - 20, gap * 0.5));
      push(ta, ta + u, { ...arrived, status: "arrived", ...nextInfo });
      addMove(P, ta + u, ta + u + dt, P.rvd.length ? "reversing" : "shunting", { ...nextInfo, turnK: k });
      push(ta + u + dt, tb, { kind: "hold", P: B.p.P, d: 0, status: "waiting", stop: firstStop(B), ...nextInfo });
    }
    return legs;
  }

  /** A spare set: parked at its place in the yard all day, facing the exit, or where it
   *  spent the night away from a depot. */
  function spareLegs(v) {
    if (v.outside) {
      const o = v.outside, dp = lineDepot(v.route), len = TRAIN_TYPES[v.set.type].length;
      const P = o.plat != null ? D.patterns[o.plat].P : paths[o.tail];
      const d = Math.max(0, o.plat != null ? P.len - o.k * dp.pitch : P.len - (dp.end + o.k * dp.pitch + len / 2));
      return [{ t0: DAY_START, t1: DAY_END, kind: "hold", P, d, parked: true, status: "stabled", stop: o.stop }];
    }
    const { depot, t0, t1 } = v.stays[0], dp = D.depots[depot], a = v.parks[0] || { slot: 0, k: 0 };
    const P = paths[Object.values(dp.out)[0][a.slot]];
    const d = dp.end + a.k * dp.pitch + TRAIN_TYPES[v.set.type].length / 2;
    return [{ t0, t1, kind: "depot", depot, node: dp.slots[a.slot], P, d }];
  }

  /** State of a vehicle at service-day second `sec`, or null if it has no leg then. */
  function vehicleState(v, sec) {
    const legs = v.legs;
    let i = v.li || 0;
    if (i >= legs.length || legs[i].t0 > sec) i = 0;
    while (i < legs.length && legs[i].t1 <= sec) i++;
    v.li = i;
    const leg = legs[i];
    if (!leg || leg.t0 > sec) return null;
    const f = (sec - leg.t0) / (leg.t1 - leg.t0);
    switch (leg.kind) {
      case "trip": {
        const p = leg.trip.p, t = sec - leg.trip.start;
        const tp = tripPos(p, t);
        return { leg, kind: "trip", P: p.P, d: tp.d, tp, t };
      }
      case "hold": return { leg, kind: "hold", P: leg.P, d: leg.d };
      case "move": return { leg, kind: "move", P: leg.P, d: lerp(leg.d0, leg.d1, ease(f)) };
      case "depot": return { leg, kind: "depot", node: leg.node, P: leg.P, d: leg.d };
    }
    return null;
  }

  // ---------- Time ----------
  const { clockAt, ymd, shiftDay, hhmm } = ST;
  /** Service days that may have trips running at this instant: [dateStr, secondsSinceThatMidnight]. */
  function serviceDays(ms) {
    const { p, sec } = clockAt(ms);
    return [[ymd(p.year, p.month, p.day), sec], [shiftDay(p, -1), sec + 86400]];
  }
  /** The single service day that owns vehicle state at this instant (days change at 03:00). */
  function vehicleDay(ms) {
    const { p, sec } = clockAt(ms);
    return sec >= DAY_START ? [ymd(p.year, p.month, p.day), sec] : [shiftDay(p, -1), sec + 86400];
  }

  // ---------- Names and strings ----------
  const MT = {
    changingEnds: ["Смяна на кабината", "Changing ends"], stabled: ["Нощува на {s}", "Stabled overnight at {s}"],
    leavingDepot: ["Излиза от депото", "Leaving depot"], toPlatform: ["Отива към перона", "Moving to platform"],
    readyFirst: ["Готов за първи курс", "Ready for first trip"], terminating: ["Краен курс — слизане на пътници", "Terminating — passengers leaving"],
    toDepot: ["Прибира се в депото", "Returning to depot"], toSiding: ["Отива към коловоза за нощуване", "Running to stabling siding"],
    toStabling: ["Празен курс към гарата за нощуване", "Running empty to its overnight station"],
    emptyRun: ["Празен курс към първата си гара", "Running empty to its first station"],
    waiting: ["Изчаква заминаване", "Waiting to depart"], arrived: ["Пристигна — слизане на пътници", "Arrived — passengers leaving"],
    reversing: ["Обръща през задния коловоз", "Reversing via tail track"], shunting: ["Маневра", "Shunting"],
    parkedIn: ["Паркиран в {d}", "Parked in {d}"], inService: ["В движение", "In service"],
    notInService: ["Извън движение", "Not in service"], run: ["курс", "run"], estimated: ["изчислено по разписание", "estimated from the timetable"],
    simulatedMove: ["симулирано движение", "simulated move"], departing: ["Тръгва от", "Departing"],
    atStation: ["На станция", "At station"], left: ["Тръгна от", "Left"], next: ["Следваща", "Next"],
    from: ["От", "From"], to: ["До", "To"], train: ["Влак", "Train"], cars: ["{n} вагона", "{n} cars"],
    carsSections: ["{n} вагона × {k} секции", "{n} cars × {k} sections"],
    crossesOver: ["Преминава на другия коловоз преди {s}", "Crosses over to the departure track before {s}"],
    nextTrip: ["Следващ курс", "Next trip"], departs: ["Тръгва", "Departs"], doneForDay: ["Приключи за деня", "Finished for the day"],
    spare: ["резерв", "spare"], spareToday: ["Няма — резерв днес", "None — spare today"],
    trainsParked: ["{n} влака в депото", "{n} trains parked"], noneParked: ["Няма паркирани влакове", "No trains parked here now"],
    out: ["излиза {t}", "out {t}"], noDeps: ["Няма заминавания в следващите 45 мин.", "No scheduled departures in the next 45 min."],
    schedDeps: ["Заминавания по разписание", "Scheduled departures"], trainsRunning: ["{n} влака в движение", "{n} trains running"],
    stations: ["Станции", "Stations"], depot: ["Депо", "Depot"], metroLine: ["Метролиния", "Metro line"],
  };
  const mt = (key, vars) => {
    let s = MT[key] ? MT[key][ST.lang === "bg" ? 0 : 1] : key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
    return s;
  };
  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s\-.(„"])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
      .replace(/\bIii\b/g, "III").replace(/\bIi\b/g, "II").replace(/(^|\s)Ндк(?=\s|$)/g, "$1НДК").replace(/\bNdk\b/g, "NDK");
  }
  const stBg = id => titleCase(D.stations[id].name);
  const stEn = id => D.stations[id].en ? titleCase(D.stations[id].en) : stBg(id);
  const stName = id => ST.lang === "bg" ? stBg(id) : stEn(id);
  const headName = h => {
    if (ST.lang === "bg") return titleCase(h);
    const id = Object.keys(D.stations).find(k => D.stations[k].name === h);
    return id ? stEn(id) : titleCase(h);
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---------- Map layers ----------
  const bodyRenderer = L.canvas({ pane: "bodies", padding: 0.2 });
  const lineInfo = r => ({ id: r, name: D.routes[r].name, kind: "metro", color: D.routes[r].color, text: D.routes[r].text });
  ST.registerLines(LINE_ORDER.map(lineInfo));
  const chip = r => ST.lineChip(lineInfo(r));

  // Overview lines (zoomed out): one representative track path per line. Track shared
  // with an already-drawn line is dashed, so overlapping lines (M1 / M4) stay visible.
  const CELL = 40; // metres
  const overview = L.layerGroup().addTo(map);
  const lineLayers = {};
  function drawOverview() {
    overview.clearLayers();
    const drawnCells = new Set();
    const cellOf = (lat, lon) => [Math.round(lon * KX / CELL), Math.round(lat * KY / CELL)];
    const nearDrawn = (lat, lon) => {
      const [cx, cy] = cellOf(lat, lon);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (drawnCells.has(`${cx + dx},${cy + dy}`)) return true;
      return false;
    };
    for (const r of LINE_ORDER) {
      const route = D.routes[r];
      const pts = paths[route.line].n.map(i => [N[i][0], N[i][1]]);
      const group = L.layerGroup();
      lineLayers[r] = group;
      if (ST.routeVisible(r, "metro")) group.addTo(overview);
      const runs = [];
      let cur = null;
      for (const pt of pts) {
        const shared = nearDrawn(pt[0], pt[1]);
        if (!cur || cur.shared !== shared) {
          if (cur) cur.pts.push(pt);
          cur = { shared, pts: cur ? [cur.pts.at(-1)] : [] };
          runs.push(cur);
        }
        cur.pts.push(pt);
      }
      for (const run of runs) {
        if (run.pts.length < 2) continue;
        L.polyline(run.pts, { pane: "lines", color: ST.dark ? "#000" : "#fff", weight: 9, opacity: run.shared ? 0 : 0.9, interactive: false }).addTo(group);
        L.polyline(run.pts, {
          pane: "lines", color: route.color, weight: 6, opacity: 1, interactive: false,
          dashArray: run.shared ? "10 10" : null, lineCap: run.shared ? "butt" : "round",
        }).addTo(group);
      }
      for (const pt of pts) { const [cx, cy] = cellOf(pt[0], pt[1]); drawnCells.add(`${cx},${cy}`); }
    }
  }

  // Detailed track layer (zoomed in): every OSM track, coloured by the lines using it,
  // grey for tail tracks, crossovers, sidings and depot yards.
  const trackLayer = L.layerGroup();
  function drawTracks() {
    trackLayer.clearLayers();
    for (const tr of D.tracks) {
      const pts = tr.n.map(nodeLL);
      const revenue = tr.r.length > 0;
      const yard = tr.s === "yard";
      L.polyline(pts, {
        pane: "tracks", interactive: false, lineCap: "butt",
        color: revenue ? D.routes[tr.r[0]].color : (ST.dark ? "#8a9099" : "#5f6670"),
        weight: revenue ? 4 : (yard ? 1.5 : 2.5), opacity: revenue ? 1 : 0.9,
      }).addTo(trackLayer);
      if (tr.r.length > 1) {
        L.polyline(pts, { pane: "tracks", interactive: false, lineCap: "butt", color: D.routes[tr.r[1]].color, weight: 4, dashArray: "8 8" }).addTo(trackLayer);
      }
    }
  }
  function updateZoomLayers() {
    updateScale();
    const z = map.getZoom();
    if (z >= 15) map.removeLayer(overview); else if (!map.hasLayer(overview)) overview.addTo(map);
    if (z >= 13) { drawTracks(); if (!map.hasLayer(trackLayer)) trackLayer.addTo(map); } else map.removeLayer(trackLayer);
    map.getContainer().classList.toggle("hide-station-labels", z < 13);
  }

  // Stations: merge platforms with the same name that are close together into one marker.
  const stationGroups = [];
  for (const id of Object.keys(D.stations)) {
    const s = D.stations[id];
    const [lat, lon] = s.plat || [s.lat, s.lon];
    let g = stationGroups.find(g => Math.hypot((g.lat - lat) * KY, (g.lon - lon) * KX) < 350 &&
      (g.name.replace(/\s+II$/, "") === s.name.replace(/\s+II$/, "") || g.parent === s.parent));
    if (!g) { g = { ids: [], lines: new Set(), lat, lon, name: s.name, parent: s.parent }; stationGroups.push(g); }
    g.ids.push(id);
    s.lines.forEach(l => g.lines.add(l));
  }
  function drawStations() {
    for (const g of stationGroups) {
      if (g.m) map.removeLayer(g.m);
      const interchange = g.lines.size > 1 && !(g.lines.size === 2 && g.lines.has("M1") && g.lines.has("M4"));
      g.m = L.circleMarker([g.lat, g.lon], {
        pane: "stations", radius: interchange ? 7 : 5, weight: interchange ? 3 : 2,
        color: ST.dark ? "#e8eaed" : "#1d1f23", fillColor: ST.dark ? "#15171a" : "#fff", fillOpacity: 0.9,
      }).addTo(map);
      g.m.bindTooltip(stName(g.ids[0]), { permanent: true, direction: "right", offset: [8, 0], className: "station-label" });
      g.m.on("click", () => openStation(g));
    }
  }

  // ---------- Depots ----------
  const depotMarkers = {};
  for (const [key, dp] of Object.entries(D.depots)) {
    const m = L.marker([dp.lat, dp.lon], {
      pane: "stations", keyboard: false,
      icon: L.divIcon({ className: "depot-icon", iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="depot k-metro">${ST.kindIcon("metro", 18)}<span class="depot-count">0</span></div>` }),
    }).addTo(map);
    m.on("click", () => ST.openCard({ id: "depot:" + key, render: () => depotCard(key) }));
    depotMarkers[key] = m;
  }
  let lastParked = [];

  // ---------- Cards ----------
  const fact = (label, value) => `<div class="fact"><span>${label}</span><b>${value}</b></div>`;
  const metroMs = () => ST.clock.now() - timetableDelay * 1000;
  const minsText = s => s < 60 ? `${Math.max(0, Math.round(s))} ${t("sec")}` : `${Math.round(s / 60)} ${t("min")}`;

  function depotCard(key) {
    const dp = D.depots[key];
    const list = lastParked.filter(x => x.st.leg.depot === key);
    let html = `<div class="card-head"><span class="kind-badge">${ST.kindIcon("metro", 22)}</span><div><div class="card-title">${ST.lang === "bg" ? dp.name : dp.en}</div>` +
      `<div class="card-sub">${mt("depot")} · ${mt("trainsParked", { n: list.length })}</div></div></div>`;
    if (!list.length) return html + `<p class="muted">${mt("noneParked")}</p>`;
    const next = x => x.st.leg.nextTrip ? x.st.leg.nextTrip.start : 1e9;
    list.sort((a, b) => next(a) - next(b));
    html += `<div class="rows">`;
    for (const { v, st } of list) {
      const n = st.leg.nextTrip;
      html += `<div class="row-item">${chip(v.route)}<span class="grow">${esc(v.set.id)}</span><span class="t">${n ? mt("out", { t: hhmm(n.start + n.p.dep[0]) }) : mt(v.spare ? "spare" : "doneForDay")}</span></div>`;
    }
    return html + "</div>";
  }

  function stationDepartures(g) {
    const [date0] = serviceDays(metroMs());
    const horizon = 45 * 60, rows = new Map();
    for (const [date, sec] of serviceDays(metroMs())) {
      for (const trip of trips) {
        if (!calendars[trip.cal].has(date)) continue;
        const p = trip.p;
        for (const id of g.ids) {
          const i = p.stops.indexOf(id);
          if (i < 0 || i === p.stops.length - 1) continue;
          const tt = trip.start + p.dep[i];
          if (tt < sec - 20 || tt > sec + horizon) continue;
          const key = `${p.route}|${p.headsign}`;
          if (!rows.has(key)) rows.set(key, { route: p.route, head: p.headsign, times: [] });
          rows.get(key).times.push({ t: tt, wait: tt - sec });
        }
      }
    }
    void date0;
    return [...rows.values()].sort((a, b) => a.route.localeCompare(b.route) || a.head.localeCompare(b.head));
  }

  function stationCard(g) {
    const list = stationDepartures(g);
    let html = `<div class="card-head"><span class="kind-badge">${ST.kindIcon("metro", 22)}</span><div><div class="card-title">${esc(stName(g.ids[0]))}</div>` +
      `<div class="card-sub">${t("station")} · ${[...g.lines].sort().map(chip).join(" ")}</div></div></div>`;
    html += `<h4>${mt("schedDeps")}</h4>`;
    if (!list.length) return html + `<p class="muted">${mt("noDeps")}</p>`;
    html += `<div class="rows">`;
    for (const r of list) {
      r.times.sort((a, b) => a.t - b.t);
      const next = r.times.slice(0, 3).map(x => { const m = Math.round(x.wait / 60); return m <= 0 ? t("nowShort") : `${m} ${t("min")}`; }).join(" · ");
      html += `<div class="row-item">${chip(r.route)}<span class="grow">${esc(headName(r.head))}</span><span class="t">${next}</span></div>`;
    }
    return html + "</div>";
  }
  function openStation(g) {
    ST.openCard({ id: "station:" + g.ids[0], render: () => stationCard(g) });
    ST.focus([g.lat, g.lon]);
  }

  function trainFacts(v) {
    const ty = TRAIN_TYPES[v.set.type];
    const cars = ty.sections > 1 ? mt("carsSections", { n: ty.cars.length, k: ty.sections }) : mt("cars", { n: ty.cars.length });
    return fact(t("model"), esc(ty.name)) + fact(t("fleetNo"), esc(v.set.id)) + fact(t("length"), `${ty.length.toFixed(1)} m · ${cars}`);
  }

  function stopList(p, trip, current) {
    let html = `<ol class="stoplist">`;
    p.stops.forEach((id, i) => {
      const cls = i < current ? "past" : i === current ? "current" : "";
      html += `<li class="${cls}"><span class="dot"></span><span class="grow">${esc(stName(id))}</span><span class="t">${hhmm(trip.start + p.arr[i])}</span></li>`;
    });
    return html + "</ol>";
  }

  function trainCard(key) {
    const tm = states.get(key);
    if (!tm) return null;
    const { v, st, sec } = tm;
    const r = v.route, leg = st.leg;
    let html;
    if (st.kind === "trip") {
      const trip = leg.trip, p = trip.p, tp = st.tp, tt = st.t;
      html = `<div class="card-head">${chip(r)}<div><div class="card-title">${t("toward")} ${esc(headName(p.headsign))}</div>` +
        `<div class="card-sub">${mt("inService")} · ${mt("run")} ${v.run} · ${mt("estimated")}</div></div></div><div class="facts">`;
      if (tp.atStop >= 0) html += fact(tp.atStop === 0 ? mt("departing") : mt("atStation"), esc(stName(p.stops[tp.atStop])));
      else {
        html += fact(mt("next"), `${esc(stName(p.stops[tp.next]))} · ${minsText(p.arr[tp.next] - tt)}`);
        html += fact(t("speed"), `≈ ${Math.round(tp.v * 3.6)} ${t("kmh")}`);
      }
      html += trainFacts(v) + `</div>`;
      if (p.xo) html += `<p class="muted small">${mt("crossesOver", { s: esc(stName(p.stops.at(-1))) })}</p>`;
      html += `<h4>${t("stopsOnRoute")}</h4>` + stopList(p, trip, tp.atStop >= 0 ? tp.atStop : tp.next - 0.5);
    } else {
      const status = st.kind === "depot" ? mt("parkedIn", { d: ST.lang === "bg" ? D.depots[leg.depot].name : D.depots[leg.depot].en })
        : mt(leg.status, { s: leg.stop ? stName(leg.stop) : "" });
      html = `<div class="card-head">${chip(r)}<div><div class="card-title">${esc(status)}</div>` +
        `<div class="card-sub">${mt("notInService")} · ${v.spare ? mt("spare") : `${mt("run")} ${v.run}`} · ${mt("simulatedMove")}</div></div></div><div class="facts">`;
      if (leg.stop && leg.status !== "stabled") html += fact(mt("atStation"), esc(stName(leg.stop)));
      const n = leg.nextTrip;
      if (n) {
        const dep = n.start + n.p.dep[0];
        html += fact(mt("nextTrip"), `${t("toward")} ${esc(headName(n.p.headsign))}`);
        html += fact(mt("departs"), `${esc(stName(n.p.stops[0]))} ${hhmm(dep)} · ${minsText(dep - sec)}`);
      } else html += fact(mt("nextTrip"), mt(v.spare ? "spareToday" : "doneForDay"));
      html += trainFacts(v) + `</div>`;
    }
    return html;
  }

  function lineCard(r) {
    const own = D.patterns.filter(p => p.route === r);
    const maxStops = Math.max(...own.map(p => p.stops.length));
    const dirs = own.filter(p => p.stops.length === maxStops).filter((p, i, a) => a.findIndex(q => q.headsign === p.headsign) === i);
    const running = [...states.values()].filter(x => x.v.route === r && x.st.kind === "trip").length;
    let html = `<div class="card-head">${chip(r)}<div><div class="card-title">${mt("metroLine")} ${D.routes[r].name}</div>` +
      `<div class="card-sub">${mt("trainsRunning", { n: running })}</div></div></div>`;
    html += `<div class="card-actions"><button class="btn" data-action="only-line" data-line="${r}">${ST.filters.lines.size === 1 && ST.filters.lines.has(r) ? t("showAllLines") : t("showLineOnly")}</button></div>`;
    for (const p of dirs) {
      html += `<h4>${t("toward")} ${esc(headName(p.headsign))}</h4><ol class="stoplist compact">` +
        p.stops.map(id => `<li><span class="dot"></span><a href="#" class="grow" data-action="metro-station" data-id="${id}">${esc(stName(id))}</a></li>`).join("") + `</ol>`;
    }
    return html;
  }

  ST.on("action", (action, data) => {
    if (action === "metro-station") {
      const g = stationGroups.find(g => g.ids.includes(data.id));
      if (g) { openStation(g); ST.focus([g.lat, g.lon], 15); }
    } else if (action === "metro-line") {
      ST.openCard({ id: "line:" + data.line, render: () => lineCard(data.line) });
    }
  });

  // ---------- Search ----------
  ST.addSearch((q, raw) => {
    const out = [];
    for (const r of LINE_ORDER) {
      const name = D.routes[r].name.toLowerCase();
      if (name === q || name.replace("m", "") === q || ("метро " + name.replace("m", "")).startsWith(q) || ("m" + q) === name) {
        out.push({ score: 100, icon: chip(r), label: `${mt("metroLine")} ${D.routes[r].name}`,
          sub: [...new Set(D.patterns.filter(p => p.route === r).map(p => headName(p.headsign)))].slice(0, 2).join(" ⇄ "),
          action: () => ST.openCard({ id: "line:" + r, render: () => lineCard(r) }) });
      }
    }
    for (const g of stationGroups) {
      const hit = [0, 40, 52, 60][Math.max(ST.matchScore(q, stBg(g.ids[0])), ST.matchScore(q, stEn(g.ids[0])))];
      if (hit && q.length >= 2) out.push({ score: hit + 5, icon: ST.kindIcon("metro", 22), label: esc(stName(g.ids[0])),
        sub: `${t("station")} · ${[...g.lines].sort().map(chip).join(" ")}`,
        action: () => { openStation(g); ST.focus([g.lat, g.lon], 15); } });
    }
    void raw;
    return out;
  });

  // ---------- Trains ----------
  const trainMarkers = new Map(); // vehicle key -> {marker, cls, ...}
  const states = new Map();       // vehicle key -> {v, st, sec} as of the last frame
  window.metroDebug = { map, vehiclesFor, vehicleState, paths, pathAt, trainMarkers };
  // For the trip planner: the train drawn on timetable trip `id` (index in D.trips) at ms, if any.
  ST.metroTrains = {
    get delay() { return timetableDelay; },
    onTrip(id, ms) {
      const [date, sec] = vehicleDay(ms - timetableDelay * 1000);
      for (const v of vehiclesFor(date)) {
        const st = vehicleState(v, sec);
        if (st && st.kind === "trip" && st.leg.trip.id === id) return { ll: pathAt(st.P, st.d).ll, d: st.d, pd: st.leg.trip.p.pd };
      }
      return null;
    },
  };

  function trainIcon(route) {
    const r = D.routes[route];
    return L.divIcon({
      className: "veh-icon", iconSize: [26, 26], iconAnchor: [13, 13],
      html: `<div class="veh k-metro" style="--c:${r.color};--t:${r.text}"><div class="dir"></div><div class="dot">${r.name}</div></div>`,
    });
  }

  // ---------- Full-length train bodies ----------
  function hideBody(tm) {
    if (!tm.body) return;
    for (const l of tm.body) map.removeLayer(l);
    tm.body = null;
  }

  function drawBody(tm, v, st, cls) {
    const type = TRAIN_TYPES[v.set.type];
    const sections = trainSections(type, st);
    const w = Math.max(5, Math.min(16, 2.9 / mpp));
    const color = D.routes[v.route].color;
    const fill = cls === "parked" ? "#c4c7cc" : cls === "nonservice" ? "#ffffff" : color;
    const joints = sections.joints, nj = joints.length, outline = ST.dark ? "#e8eaed" : "#1d1f23";
    if (!tm.body || tm.body.length !== sections.length * 2 + nj * 2) {
      hideBody(tm);
      tm.body = [];
      const opts = { renderer: bodyRenderer, interactive: true, lineCap: "butt", lineJoin: "round" };
      for (let i = 0; i < sections.length; i++) {
        const o = L.polyline(sections[i], { ...opts, color: outline, weight: w + 3 }).addTo(map);
        const body = L.polyline(sections[i], { ...opts, color: fill, weight: w }).addTo(map);
        tm.body.push(o, body);
      }
      // Articulation bellows between the two sections of a car.
      for (const pts of joints) tm.body.push(L.polyline(pts, { ...opts, color: outline, weight: w * 0.7 + 3 }).addTo(map));
      for (const pts of joints) tm.body.push(L.polyline(pts, { ...opts, color: ST.dark ? "#59606b" : "#3b4048", weight: w * 0.7, dashArray: "2 1.5" }).addTo(map));
      for (const l of tm.body) l.on("click", () => openTrain(tm.key));
      tm.bodyStyle = "";
    }
    const style = `${w}|${fill}|${ST.dark}`;
    const base = sections.length * 2;
    joints.forEach((pts, i) => {
      tm.body[base + i].setLatLngs(pts);
      tm.body[base + nj + i].setLatLngs(pts);
      if (style !== tm.bodyStyle) {
        tm.body[base + i].setStyle({ weight: w * 0.7 + 3, color: outline });
        tm.body[base + nj + i].setStyle({ weight: w * 0.7, color: ST.dark ? "#59606b" : "#3b4048" });
      }
    });
    for (let i = 0; i < sections.length; i++) {
      tm.body[2 * i].setLatLngs(sections[i]);
      tm.body[2 * i + 1].setLatLngs(sections[i]);
      if (style !== tm.bodyStyle) {
        tm.body[2 * i].setStyle({ weight: w + 3, color: ST.dark ? "#e8eaed" : "#1d1f23" });
        tm.body[2 * i + 1].setStyle({ weight: w, color: fill });
      }
    }
    tm.bodyStyle = style;
    const lead = sections[0];
    return lead[Math.floor(lead.length / 2)];        // middle of the lead car (section)
  }

  function openTrain(key) {
    ST.openCard({ id: "train:" + key, render: () => trainCard(key) });
  }

  let counts = {}, nonService = 0;
  ST.addLayer({
    frame(ctx) {
      const ms = ctx.ms - timetableDelay * 1000;
      const [date, sec] = vehicleDay(ms);
      const vehicles = vehiclesFor(date);
      const zoom = ctx.zoom;
      const seen = new Set();
      counts = Object.fromEntries(LINE_ORDER.map(r => [r, 0]));
      const parked = [];
      nonService = 0;

      for (const v of vehicles) {
        const st = vehicleState(v, sec);
        if (!st) continue;
        if (st.kind === "depot") parked.push({ v, st });
        else if (st.kind === "trip") counts[v.route]++;
        else nonService++;
        if (!ST.routeVisible(v.route, "metro")) continue;
        // Parked depot trains are only drawn individually when zoomed in on the yard.
        if (st.kind === "depot" && zoom < 16) continue;

        const { ll, brg } = pathAt(st.P, st.d);
        const inView = ctx.view.contains(ll);
        let tm = trainMarkers.get(v.key);
        states.set(v.key, { v, st, sec });
        if (ctx.dots && !(ST.card && ST.card.id === "train:" + v.key)) {
          if (tm) { hideBody(tm); map.removeLayer(tm.marker); trainMarkers.delete(v.key); }
          if (inView && st.kind !== "depot") ctx.dot(ll, D.routes[v.route].color, () => openTrain(v.key), 4.6);
          continue;
        }
        if (!inView && !(tm && ST.card && ST.card.id === "train:" + v.key)) {
          if (tm) { hideBody(tm); map.removeLayer(tm.marker); trainMarkers.delete(v.key); }
          continue;
        }
        seen.add(v.key);
        if (!tm) {
          const marker = L.marker(ll, { icon: trainIcon(v.route), pane: "vehicles", keyboard: false }).addTo(map);
          tm = { marker, cls: "", brg: 0, key: v.key };
          marker.on("click", () => openTrain(v.key));
          trainMarkers.set(v.key, tm);
        } else {
          tm.marker.setLatLng(ll);
        }
        if (brg !== null) tm.brg = brg;
        tm.v = v; tm.st = st; tm.sec = sec;
        const el = tm.marker.getElement();
        if (el) {
          if (!tm.dirEl) { tm.dirEl = el.querySelector(".dir"); tm.vehEl = el.querySelector(".veh"); }
          tm.dirEl.style.transform = `rotate(${tm.brg}deg)`;
          // Line colour all day, except on the way to a depot or siding to rest (white) and resting there (grey).
          const cls = st.kind === "trip" ? (st.tp.atStop >= 0 ? "at-stop" : "") :
            (st.kind === "depot" || st.leg.parked) ? "parked" :
            (st.leg.status === "toDepot" || st.leg.status === "toSiding" || st.leg.status === "toStabling") ? "nonservice" : "";
          if (cls !== tm.cls) {
            tm.vehEl.classList.remove("at-stop", "parked", "nonservice");
            if (cls) tm.vehEl.classList.add(cls);
            tm.cls = cls;
          }
        }
        const withBody = ctx.bodies;
        if (withBody) tm.marker.setLatLng(drawBody(tm, v, st, tm.cls));
        else hideBody(tm);
        if (tm.vehEl && withBody !== tm.hasBody) { tm.vehEl.classList.toggle("has-body", withBody); tm.hasBody = withBody; }
        if (tm.vehEl) tm.vehEl.classList.toggle("selected", !!(ST.card && ST.card.id === "train:" + v.key));
        // Trains standing in a depot are just grey bodies; the marker appears when one moves off.
        const inDepot = st.kind === "depot";
        if (el && inDepot !== tm.inDepot) { el.style.display = inDepot ? "none" : ""; tm.inDepot = inDepot; }
      }
      for (const [key, tm] of trainMarkers) {
        if (!seen.has(key)) { hideBody(tm); map.removeLayer(tm.marker); trainMarkers.delete(key); }
      }
      if (ctx.slow) {
        lastParked = parked;
        for (const [key, m] of Object.entries(depotMarkers)) {
          const el = m.getElement();
          if (el) el.querySelector(".depot-count").textContent = parked.filter(x => x.st.leg.depot === key).length;
        }
      }
    },
  });

  ST.addCounts(() => [{
    icon: ST.kindIcon("metro", 20), label: t("kinds_metro"),
    n: Object.values(counts).reduce((a, b) => a + b, 0),
  }]);

  // ---------- Delay setting ----------
  const delayInput = document.getElementById("delay"), delayReset = document.getElementById("delay-reset");
  function syncDelay() {
    delayInput.value = timetableDelay;
    delayReset.disabled = timetableDelay === DEFAULT_DELAY;
  }
  function setDelay(v) {
    timetableDelay = Math.max(-600, Math.min(600, Math.round(v)));
    try { localStorage.setItem("metro.delay2", String(timetableDelay)); } catch (e) { /* storage unavailable */ }
    syncDelay();
    ST.invalidate();
  }
  delayInput.addEventListener("input", () => { if (delayInput.value !== "" && Number.isFinite(+delayInput.value)) setDelay(+delayInput.value); });
  delayInput.addEventListener("change", syncDelay);
  delayReset.addEventListener("click", () => setDelay(DEFAULT_DELAY));
  syncDelay();

  // ---------- Wiring ----------
  map.on("zoomend", updateZoomLayers);
  ST.on("theme", () => { drawOverview(); drawStations(); if (map.getZoom() >= 13) drawTracks(); });
  ST.on("lang", drawStations);
  ST.on("filter", () => {
    for (const r of LINE_ORDER) {
      if (ST.routeVisible(r, "metro")) lineLayers[r].addTo(overview); else overview.removeLayer(lineLayers[r]);
    }
  });
  drawOverview();
  drawStations();
  updateZoomLayers();
})();
