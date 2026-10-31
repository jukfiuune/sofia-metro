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
  const TZ = D.timezone;
  const LINE_ORDER = Object.keys(D.routes).sort();

  const UNLOAD = 30;           // s at the arrival platform before moving off
  const READY = 120;           // s at the departure platform before a run's first trip
  const REV_HOLD = 20;         // s to change ends when reversing
  const SHUNT_SPEED = 8;       // m/s for turnback moves (over switches)
  const DEPOT_SPEED = 11;      // m/s (~40 km/h) for empty runs on the running line
  const YARD_SPEED = 4;        // m/s (~15 km/h) on depot yard tracks and spurs
  const DEPOT_GAP = 25 * 60;   // layovers longer than this at a depot station go to the depot
  // Observed: real trains run about a minute behind the GTFS stop times (which the feed
  // marks as approximate, timepoint=0), so positions are computed this far behind the clock.
  // Adjustable in the panel; negative values run trains early.
  const DEFAULT_DELAY = 60;    // s
  let timetableDelay = DEFAULT_DELAY;
  try {
    const saved = localStorage.getItem("metro.delay");
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
    return { n, cum, len: cum.at(-1), rvd: rv.map(i => cum[i]), yl };
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

  const CAR_GAP = 0.9, SECTION_GAP = 0.35;
  /** Centre-lines of each car body section of a train centred at st.d. */
  function trainSections(type, st) {
    let [lo, hi] = travelPiece(st);
    if (hi - lo < 3) { lo = 0; hi = st.P.len; }
    const piece = [lo, hi], out = [];
    let s = st.d + type.length / 2;                 // front of the train
    for (const car of type.cars) {
      const sec = car / type.sections;
      for (let k = 0; k < type.sections; k++) {
        const gapFront = k === 0 ? CAR_GAP / 2 : SECTION_GAP / 2;
        const gapBack = k === type.sections - 1 ? CAR_GAP / 2 : SECTION_GAP / 2;
        const a = s - gapFront, b = s - sec + gapBack, pts = [];
        const steps = Math.max(2, Math.ceil((a - b) / 4));
        for (let i = 0; i <= steps; i++) pts.push(pieceAt(st.P, piece, a - (a - b) * i / steps));
        out.push(pts);
        s -= sec;
      }
    }
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
    rusich:  { name: "81-740.2/741.2 „Русич“", maker: "Metrovagonmash", cars: [28.15, 27.2, 28.15], sections: 2 },
    nomK:    { name: "81-717.4К/714.4К (modernised)", maker: "Metrovagonmash, modernised 2019–22", cars: [19.21, 19.21, 19.21, 19.21], sections: 1 },
    nom:     { name: "81-717.4/714.4 (original, 1990)", maker: "Metrovagonmash", cars: [19.21, 19.21, 19.21, 19.21], sections: 1 },
    skoda:   { name: "Škoda 21Mt/22Mt/23Mt", maker: "Škoda Group, 2025–26", cars: [20, 20, 20, 20], sections: 1 },
    inspiro: { name: "Siemens Inspiro Sofia", maker: "Siemens / Newag", cars: [20, 20, 20], sections: 1 },
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

  /** Give each vehicle run of the day a trainset. A set can do several runs whose
   *  out-of-depot windows don't overlap (e.g. a morning and an evening peak run). */
  function assignFleet(date, vehicles) {
    const rand = seededRandom(date);
    const window = v => {
      const out = v.legs.filter(l => l.kind !== "depot");
      const start = v.legs[0].kind === "depot" ? out[0].t0 : DAY_START;   // stabled outside: busy all day
      return [start, out.at(-1).t1];
    };
    const busyUntil = new Map();
    const order = vehicles.map(v => [v, ...window(v)]).sort((a, b) => a[1] - b[1]);
    for (const [v, start, end] of order) {
      const allowed = FLEET.filter(s => s.lines.includes(v.route));
      let free = allowed.filter(s => (busyUntil.get(s) ?? -1) + 600 <= start);
      if (!free.length) free = allowed;
      let r = rand() * free.reduce((a, s) => a + s.weight, 0), pick = free[0];
      for (const s of free) { r -= s.weight; if (r <= 0) { pick = s; break; } }
      v.set = pick;
      busyUntil.set(pick, Math.max(end, busyUntil.get(pick) ?? -1));
    }
  }

  // ---------- Vehicles (runs) per service day ----------
  const vehicleCache = new Map();

  function vehiclesFor(date) {
    if (vehicleCache.has(date)) return vehicleCache.get(date);
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
    assignFleet(date, list);
    if (vehicleCache.size > 4) vehicleCache.delete(vehicleCache.keys().next().value);
    vehicleCache.set(date, list);
    return list;
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

    /** Natural duration of a move along P, including reversal stops. */
    const moveTime = (P, speed) => (P.len - P.yl) / speed + P.yl / YARD_SPEED + P.rvd.length * REV_HOLD;

    /** Add move legs along P between t0 and t1, stopping at reversal points. */
    function addMove(P, t0, t1, status, extra) {
      const pieces = [];
      let last = 0;
      for (const r of P.rvd) { pieces.push([last, r]); last = r; }
      pieces.push([last, P.len]);
      const holdT = Math.min(REV_HOLD, (t1 - t0) * 0.2 / Math.max(1, P.rvd.length));
      const runT = (t1 - t0) - holdT * P.rvd.length;
      let t = t0;
      pieces.forEach(([a, b], i) => {
        const dt = P.len > 0 ? runT * (b - a) / P.len : 0;
        push(t, t + dt, { kind: "move", P, d0: a, d1: b, status, ...extra });
        t += dt;
        if (i < pieces.length - 1) {
          push(t, t + holdT, { kind: "hold", P, d: b, status: "Changing ends", ...extra });
          t += holdT;
        }
      });
    }

    const slotFor = depot => v.run % D.depots[depot].slots.length;
    const firstStop = trip => trip.p.stops[0];
    const lastStop = trip => trip.p.stops.at(-1);

    // Before the first trip.
    {
      const first = T[0], p = first.p, dep = first.start + p.dep[0];
      const nextInfo = { nextTrip: first };
      const depot = depotFor(v.route, firstStop(first));
      const outs = depot && D.depots[depot].out[p.s0];
      if (outs && outs[slotFor(depot)] != null) {
        const slot = slotFor(depot), P = paths[outs[slot]];
        const dt = moveTime(P, DEPOT_SPEED);
        push(DAY_START, dep - READY - dt, { kind: "depot", depot, node: D.depots[depot].slots[slot], ...nextInfo });
        addMove(P, dep - READY - dt, dep - READY, "Leaving depot", nextInfo);
      } else {
        const P = paths[D.stable.out[p.s0] ?? p.path];
        const dt = P === p.P ? 0 : moveTime(P, SHUNT_SPEED);
        push(DAY_START, dep - READY - dt, { kind: "hold", P, d: 0, parked: true, status: `Stabled overnight at ${stName(firstStop(first))}`, ...nextInfo });
        if (dt) addMove(P, dep - READY - dt, dep - READY, "Moving to platform", nextInfo);
      }
      push(Math.max(DAY_START, dep - READY), dep, { kind: "hold", P: p.P, d: 0, status: "Ready for first trip", stop: firstStop(first), ...nextInfo });
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
        push(ta, ta + UNLOAD, { ...arrived, status: "Terminating — passengers leaving" });
        const ins = depot && D.depots[depot].in[pA.s1];
        if (ins && ins[slotFor(depot)] != null) {
          const slot = slotFor(depot), P = paths[ins[slot]], dt = moveTime(P, DEPOT_SPEED);
          addMove(P, ta + UNLOAD, ta + UNLOAD + dt, "Returning to depot", {});
          push(ta + UNLOAD + dt, DAY_END, { kind: "depot", depot, node: D.depots[depot].slots[slot] });
        } else {
          const P = paths[D.stable.in[pA.s1] ?? pA.path];
          if (P === pA.P) push(ta + UNLOAD, DAY_END, { ...arrived, parked: true, status: `Stabled overnight at ${stName(endStop)}` });
          else {
            const dt = moveTime(P, SHUNT_SPEED);
            addMove(P, ta + UNLOAD, ta + UNLOAD + dt, "Running to stabling siding", {});
            push(ta + UNLOAD + dt, DAY_END, { kind: "hold", P, d: P.len, parked: true, status: `Stabled overnight at ${stName(endStop)}` });
          }
        }
        break;
      }

      const nextInfo = { nextTrip: B };
      const ins = depot && D.depots[depot].in[pA.s1], outs = depot && D.depots[depot].out[B.p.s0];
      const slot = depot ? slotFor(depot) : 0;
      if (depot && tb - ta > DEPOT_GAP && ins && outs && ins[slot] != null && outs[slot] != null) {
        const Pi = paths[ins[slot]], Po = paths[outs[slot]];
        const di = moveTime(Pi, DEPOT_SPEED), dout = moveTime(Po, DEPOT_SPEED);
        push(ta, ta + UNLOAD, { ...arrived, status: "Terminating — passengers leaving", ...nextInfo });
        addMove(Pi, ta + UNLOAD, ta + UNLOAD + di, "Going to depot", nextInfo);
        push(ta + UNLOAD + di, tb - READY - dout, { kind: "depot", depot, node: D.depots[depot].slots[slot], ...nextInfo });
        addMove(Po, tb - READY - dout, tb - READY, "Leaving depot", nextInfo);
        push(tb - READY, tb, { kind: "hold", P: B.p.P, d: 0, status: "Waiting to depart", stop: firstStop(B), ...nextInfo });
        continue;
      }

      // Turnback: the routed path tells whether the train runs into a tail track
      // and reverses (path with a reversal point beyond the station) or already
      // arrived on its departure platform (zero-length path, reverses in place).
      const P = paths[D.turns[`${patternIdx.get(pA)}>${patternIdx.get(B.p)}`]];
      const gap = tb - ta;
      if (!P || P.len < 5) {
        push(ta, tb, { kind: "hold", P: B.p.P, d: 0, status: "Waiting to depart", stop: firstStop(B), ...nextInfo });
        continue;
      }
      const u = Math.min(UNLOAD, gap * 0.15);
      const dt = Math.min(moveTime(P, SHUNT_SPEED), Math.max(gap - u - 20, gap * 0.5));
      push(ta, ta + u, { ...arrived, status: "Arrived — passengers leaving", ...nextInfo });
      addMove(P, ta + u, ta + u + dt, P.rvd.length ? "Reversing via tail track" : "Shunting", nextInfo);
      push(ta + u + dt, tb, { kind: "hold", P: B.p.P, d: 0, status: "Waiting to depart", stop: firstStop(B), ...nextInfo });
    }
    return legs;
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
      case "depot": return { leg, kind: "depot", node: leg.node };
    }
    return null;
  }

  // ---------- Time handling (always Sofia local time) ----------
  const fmtParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  function sofiaParts(ms) {
    const o = {};
    for (const { type, value } of fmtParts.formatToParts(new Date(ms))) o[type] = +value;
    return o; // year, month, day, hour, minute, second
  }
  const ymd = (y, m, d) => `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
  function shiftDay(p, days) {
    const dt = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
    return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  // Epoch ms for a Sofia wall-clock time.
  function sofiaToEpoch(y, mo, d, h, mi) {
    let guess = Date.UTC(y, mo - 1, d, h, mi);
    for (let i = 0; i < 2; i++) {
      const p = sofiaParts(guess);
      const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      guess += Date.UTC(y, mo - 1, d, h, mi) - asUtc;
    }
    return guess;
  }
  const hhmm = s => {
    s = ((Math.round(s) % 86400) + 86400) % 86400;
    return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}`;
  };

  // Simulated clock
  let simBase = Date.now(), realBase = performance.now(), speed = 1, live = true;
  const simNow = () => simBase + (performance.now() - realBase) * speed;
  function setSim(ms, newSpeed = speed) { simBase = ms; realBase = performance.now(); speed = newSpeed; }

  // Formatting Intl parts is the slow part of a frame; cache per whole second.
  let partsCacheKey = -1, partsCache = null;
  function clockAt(ms) {
    const whole = Math.floor(ms / 1000);
    if (whole !== partsCacheKey) { partsCacheKey = whole; partsCache = sofiaParts(whole * 1000); }
    const p = partsCache;
    return { p, sec: p.hour * 3600 + p.minute * 60 + p.second + (ms - whole * 1000) / 1000 };
  }

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

  // ---------- Names ----------
  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s\-.(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
      .replace(/\bIii\b/g, "III").replace(/\bIi\b/g, "II").replace(/(^|\s)Ндк(?=\s|$)/g, "$1НДК");
  }
  function stName(id) { return titleCase(D.stations[id].name); }
  const stEn = id => D.stations[id].en ? titleCase(D.stations[id].en) : "";

  // ---------- Map ----------
  const map = L.map("map", { zoomControl: false, minZoom: 10, maxZoom: 19 });
  L.control.zoom({ position: "topright" }).addTo(map);
  L.control.scale({ position: "bottomright", imperial: false }).addTo(map);

  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, className: "base-tiles",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  map.createPane("lines").style.zIndex = 410;
  map.createPane("tracks").style.zIndex = 415;
  map.createPane("stations").style.zIndex = 420;
  map.createPane("bodies").style.zIndex = 630;
  map.createPane("trains").style.zIndex = 640;
  const bodyRenderer = L.canvas({ pane: "bodies", padding: 0.2 });

  // Overview lines (zoomed out): one representative track path per line. Track shared
  // with an already-drawn line is dashed, so overlapping lines (M1 / M4) stay visible.
  const drawnCells = new Set();
  const CELL = 40; // metres
  const cellOf = (lat, lon) => [Math.round(lon * KX / CELL), Math.round(lat * KY / CELL)];
  const nearDrawn = (lat, lon) => {
    const [cx, cy] = cellOf(lat, lon);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (drawnCells.has(`${cx + dx},${cy + dy}`)) return true;
    return false;
  };

  const overview = L.layerGroup().addTo(map);
  const lineLayers = {};
  const bounds = L.latLngBounds([]);
  for (const r of LINE_ORDER) {
    const route = D.routes[r];
    const pts = paths[route.line].n.map(i => [N[i][0], N[i][1]]);
    const group = L.layerGroup().addTo(overview);
    lineLayers[r] = group;
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
      bounds.extend(pt);
    }
    for (const run of runs) {
      if (run.pts.length < 2) continue;
      L.polyline(run.pts, { pane: "lines", color: dark ? "#000" : "#fff", weight: 9, opacity: run.shared ? 0 : 0.9, interactive: false }).addTo(group);
      L.polyline(run.pts, {
        pane: "lines", color: route.color, weight: 6, opacity: 1, interactive: false,
        dashArray: run.shared ? "10 10" : null, lineCap: run.shared ? "butt" : "round",
      }).addTo(group);
    }
    for (const pt of pts) { const [cx, cy] = cellOf(pt[0], pt[1]); drawnCells.add(`${cx},${cy}`); }
  }
  const wide = window.matchMedia("(min-width: 601px)").matches;
  map.fitBounds(bounds, { paddingTopLeft: [wide ? 320 : 20, 20], paddingBottomRight: [20, wide ? 20 : 80] });

  // Detailed track layer (zoomed in): every OSM track, coloured by the lines using it,
  // grey for tail tracks, crossovers, sidings and depot yards.
  const trackLayer = L.layerGroup();
  function drawTracks() {
    trackLayer.clearLayers();
    for (const t of D.tracks) {
      const pts = t.n.map(nodeLL);
      const revenue = t.r.length > 0;
      const yard = t.s === "yard";
      L.polyline(pts, {
        pane: "tracks", interactive: false, lineCap: "butt",
        color: revenue ? D.routes[t.r[0]].color : (dark ? "#8a9099" : "#5f6670"),
        weight: revenue ? 4 : (yard ? 1.5 : 2.5), opacity: revenue ? 1 : 0.9,
      }).addTo(trackLayer);
      if (t.r.length > 1) {
        L.polyline(pts, { pane: "tracks", interactive: false, lineCap: "butt", color: D.routes[t.r[1]].color, weight: 4, dashArray: "8 8" }).addTo(trackLayer);
      }
    }
  }
  function updateZoomLayers() {
    updateScale();
    const z = map.getZoom();
    if (z >= 15) { map.removeLayer(overview); } else if (!map.hasLayer(overview)) overview.addTo(map);
    if (z >= 13) { drawTracks(); if (!map.hasLayer(trackLayer)) trackLayer.addTo(map); } else map.removeLayer(trackLayer);
    document.getElementById("map").classList.toggle("hide-labels", z < 13);
  }

  // Stations: merge platforms with the same name that are close together into one marker.
  const stationIds = Object.keys(D.stations);
  const stationGroups = [];
  for (const id of stationIds) {
    const s = D.stations[id];
    const [lat, lon] = s.plat || [s.lat, s.lon];
    let g = stationGroups.find(g => Math.hypot((g.lat - lat) * KY, (g.lon - lon) * KX) < 350 &&
      (g.name.replace(/\s+II$/, "") === s.name.replace(/\s+II$/, "") || g.parent === s.parent));
    if (!g) { g = { ids: [], lines: new Set(), lat, lon, name: s.name, parent: s.parent }; stationGroups.push(g); }
    g.ids.push(id);
    s.lines.forEach(l => g.lines.add(l));
  }
  let openStation = null;
  for (const g of stationGroups) {
    const interchange = g.lines.size > 1 && !(g.lines.size === 2 && g.lines.has("M1") && g.lines.has("M4"));
    const m = L.circleMarker([g.lat, g.lon], {
      pane: "stations", radius: interchange ? 7 : 5, weight: interchange ? 3 : 2,
      color: dark ? "#e8eaed" : "#1d1f23", fillColor: dark ? "#15171a" : "#fff", fillOpacity: 0.85,
    }).addTo(map);
    m.bindTooltip(titleCase(g.name), { permanent: true, direction: "right", offset: [8, 0], className: "station-label" });
    m.bindPopup(() => stationPopup(g), { maxWidth: 320 });
    m.on("popupopen", () => { openStation = { g, m }; });
    m.on("popupclose", () => { if (openStation && openStation.g === g) openStation = null; });
  }

  map.on("zoomend", updateZoomLayers);
  updateZoomLayers();
  // Handy for debugging from the console.
  window.metroDebug = { map, vehiclesFor, vehicleState, paths, pathAt };

  const badge = r => `<span class="popup-badge" style="background:${D.routes[r].color};color:${D.routes[r].text}">${D.routes[r].name}</span>`;

  function stationPopup(g) {
    const ms = simNow();
    const horizon = 45 * 60;
    const rows = new Map();
    for (const [date, sec] of serviceDays(ms)) {
      for (const trip of trips) {
        if (!calendars[trip.cal].has(date)) continue;
        const p = trip.p;
        for (const id of g.ids) {
          const i = p.stops.indexOf(id);
          if (i < 0 || i === p.stops.length - 1) continue;
          const t = trip.start + p.dep[i];
          if (t < sec - 20 || t > sec + horizon) continue;
          const key = `${p.route}|${p.headsign}`;
          if (!rows.has(key)) rows.set(key, { route: p.route, head: p.headsign, times: [] });
          rows.get(key).times.push({ t, wait: t - sec });
        }
      }
    }
    const list = [...rows.values()].sort((a, b) => a.route.localeCompare(b.route) || a.head.localeCompare(b.head));
    let html = `<div class="popup"><div class="popup-title">${titleCase(g.name)}</div>`;
    html += `<div class="popup-sub">${[...g.lines].sort().map(badge).join("")} ${stEn(g.ids[0])}</div>`;
    if (!list.length) html += `<div class="muted">No scheduled departures in the next 45 min.</div>`;
    else {
      html += "<table>";
      for (const r of list) {
        r.times.sort((a, b) => a.t - b.t);
        const next = r.times.slice(0, 3).map(x => {
          const m = Math.round(x.wait / 60);
          return m <= 0 ? "now" : `${m} min`;
        }).join(", ");
        html += `<tr><td>${badge(r.route)}→ ${titleCase(r.head)}</td><td class="t">${next}</td></tr>`;
      }
      html += "</table>";
    }
    html += `<div class="muted" style="margin-top:6px;font-size:11px">Scheduled departures</div></div>`;
    return html;
  }

  // ---------- Depots ----------
  const depotMarkers = {};
  let openDepot = null;
  for (const [key, dp] of Object.entries(D.depots)) {
    const m = L.marker([dp.lat, dp.lon], {
      pane: "stations", keyboard: false,
      icon: L.divIcon({ className: "depot-icon", iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="depot">D<span class="depot-count">0</span></div>` }),
    }).addTo(map);
    m.bindTooltip(dp.en, { direction: "top", offset: [0, -14] });
    m.bindPopup("", { maxWidth: 320 });
    m.on("popupopen", () => { openDepot = key; });
    m.on("popupclose", () => { if (openDepot === key) openDepot = null; });
    depotMarkers[key] = m;
  }

  function depotPopup(key, parked) {
    const dp = D.depots[key];
    let html = `<div class="popup"><div class="popup-title">${dp.name}</div><div class="popup-sub">${dp.en}</div>`;
    const list = parked.filter(x => x.st.leg.depot === key);
    if (!list.length) html += `<div class="muted">No trains parked here now.</div>`;
    else {
      const next = x => x.st.leg.nextTrip ? x.st.leg.nextTrip.start : 1e9;
      list.sort((a, b) => next(a) - next(b));
      html += `<div style="margin-bottom:4px"><b>${list.length}</b> trains parked</div><table>`;
      for (const { v, st } of list.slice(0, 12)) {
        const n = st.leg.nextTrip;
        html += `<tr><td>${badge(v.route)} run ${v.run}</td><td class="t">${n ? "out " + hhmm(n.start + n.p.dep[0]) : "done for the day"}</td></tr>`;
      }
      if (list.length > 12) html += `<tr><td class="muted" colspan="2">+${list.length - 12} more</td></tr>`;
      html += "</table>";
    }
    return html + "</div>";
  }

  // ---------- Trains ----------
  const visible = Object.fromEntries(LINE_ORDER.map(r => [r, true]));
  const trainMarkers = new Map(); // vehicle key -> {marker, cls, ...}
  window.metroDebug.trainMarkers = trainMarkers;
  let openTrain = null;

  function trainIcon(route) {
    const r = D.routes[route];
    return L.divIcon({
      className: "train-icon", iconSize: [22, 22], iconAnchor: [11, 11],
      html: `<div class="train" style="--c:${r.color};--t:${r.text}"><div class="dir"></div><div class="dot">${r.name.replace("M", "")}</div></div>`,
    });
  }

  function trainRow(v) {
    const t = TRAIN_TYPES[v.set.type];
    const cars = t.sections > 1 ? `${t.cars.length} cars × ${t.sections} sections` : `${t.cars.length} cars`;
    return `<tr><td>Train</td><td class="t">${t.name}</td></tr>` +
      `<tr><td></td><td class="t muted">${v.set.id} · ${cars} · ${t.length.toFixed(1)} m</td></tr>`;
  }

  function trainPopup(v, st, sec) {
    const r = v.route, leg = st.leg;
    let html = `<div class="popup">`;
    if (st.kind === "trip") {
      const trip = leg.trip, p = trip.p, tp = st.tp, t = st.t;
      html += `<div class="popup-title">${badge(r)} → ${titleCase(p.headsign)}</div>`;
      html += `<div class="popup-sub">In service · run ${v.run} · estimated from timetable</div><table>`;
      html += trainRow(v);
      if (tp.atStop >= 0) {
        html += `<tr><td>${tp.atStop === 0 ? "Departing" : "At station"}</td><td class="t"><b>${stName(p.stops[tp.atStop])}</b></td></tr>`;
      } else {
        html += `<tr><td>Left</td><td class="t">${stName(p.stops[tp.prev])}</td></tr>`;
        const eta = Math.max(0, Math.round(p.arr[tp.next] - t));
        html += `<tr><td>Next</td><td class="t"><b>${stName(p.stops[tp.next])}</b> · ${eta < 60 ? eta + " s" : Math.round(eta / 60) + " min"}</td></tr>`;
        html += `<tr><td>Speed</td><td class="t">≈ ${Math.round(tp.v * 3.6)} km/h</td></tr>`;
      }
      const last = p.stops.length - 1;
      html += `<tr><td>From</td><td class="t">${stName(p.stops[0])} ${hhmm(trip.start + p.dep[0])}</td></tr>`;
      html += `<tr><td>To</td><td class="t">${stName(p.stops[last])} ${hhmm(trip.start + p.arr[last])}</td></tr>`;
      if (p.xo) html += `<tr><td colspan="2" class="muted">Crosses over to the departure track before ${stName(p.stops[last])}</td></tr>`;
    } else {
      const status = st.kind === "depot" ? `Parked in ${D.depots[leg.depot].en}` : leg.status;
      html += `<div class="popup-title">${badge(r)} ${status}</div>`;
      html += `<div class="popup-sub">Not in service · run ${v.run} · simulated move</div><table>`;
      html += trainRow(v);
      if (leg.stop) html += `<tr><td>At</td><td class="t"><b>${stName(leg.stop)}</b></td></tr>`;
      const n = leg.nextTrip;
      if (n) {
        const dep = n.start + n.p.dep[0];
        const wait = Math.max(0, Math.round((dep - sec) / 60));
        html += `<tr><td>Next trip</td><td class="t">→ ${titleCase(n.p.headsign)}</td></tr>`;
        html += `<tr><td>Departs</td><td class="t">${stName(n.p.stops[0])} ${hhmm(dep)}${wait ? ` · ${wait} min` : ""}</td></tr>`;
      } else {
        html += `<tr><td colspan="2" class="muted">Finished for the day</td></tr>`;
      }
    }
    return html + "</table></div>";
  }

  // ---------- Full-length train bodies ----------
  const BODY_ZOOM = 16;
  let showBodies = false;
  try { showBodies = localStorage.getItem("metro.bodies") === "1"; } catch (e) { /* storage unavailable */ }
  const bodiesWanted = () => showBodies || map.getZoom() >= BODY_ZOOM;

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
    if (!tm.body || tm.body.length !== sections.length * 2) {
      hideBody(tm);
      tm.body = [];
      for (let i = 0; i < sections.length; i++) {
        const opts = { renderer: bodyRenderer, interactive: true, lineCap: "butt", lineJoin: "round" };
        const outline = L.polyline(sections[i], { ...opts, color: dark ? "#e8eaed" : "#1d1f23", weight: w + 3 }).addTo(map);
        const body = L.polyline(sections[i], { ...opts, color: fill, weight: w }).addTo(map);
        for (const l of [outline, body]) l.on("click", () => tm.marker.openPopup());
        tm.body.push(outline, body);
      }
      tm.bodyStyle = "";
    }
    const style = `${w}|${fill}`;
    for (let i = 0; i < sections.length; i++) {
      tm.body[2 * i].setLatLngs(sections[i]);
      tm.body[2 * i + 1].setLatLngs(sections[i]);
      if (style !== tm.bodyStyle) {
        tm.body[2 * i].setStyle({ weight: w + 3 });
        tm.body[2 * i + 1].setStyle({ weight: w, color: fill });
      }
    }
    tm.bodyStyle = style;
    const lead = sections[0];
    return lead[Math.floor(lead.length / 2)];        // middle of the lead car (section)
  }

  // Redraw only as often as the fastest train moves about half a pixel (at least 4× a second
  // for the clock); zoomed out at 1× that is a few times a second instead of every frame.
  const V_FASTEST = 80 / 3.6;
  let lastSlow = 0, lastDraw = 0, dirty = true;
  const invalidate = () => { dirty = true; };
  map.on("move zoom", invalidate);
  document.getElementById("panel").addEventListener("input", invalidate);
  document.getElementById("panel").addEventListener("click", invalidate);
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const interval = Math.min(250, 500 * mpp / (V_FASTEST * speed));
    if (!dirty && now - lastDraw < interval) return;
    dirty = false;
    lastDraw = now;

    const clockMs = simNow();
    const ms = clockMs - timetableDelay * 1000;
    const [date, sec] = vehicleDay(ms);
    const vehicles = vehiclesFor(date);
    const zoom = map.getZoom();
    const seen = new Set();
    const counts = Object.fromEntries(LINE_ORDER.map(r => [r, 0]));
    const parked = [];
    const slow = now - lastSlow > 240;
    let nonService = 0;
    const bodies = bodiesWanted();
    const view = bodies ? map.getBounds().pad(0.2) : null;

    for (const v of vehicles) {
      const st = vehicleState(v, sec);
      if (!st) continue;
      if (st.kind === "depot") parked.push({ v, st });
      else if (st.kind === "trip") counts[v.route]++;
      else nonService++;
      if (!visible[v.route]) continue;
      // Parked depot trains are only drawn individually when zoomed in on the yard.
      if (st.kind === "depot" && zoom < 16) continue;

      let ll, brg = null;
      if (st.kind === "depot") ll = nodeLL(st.node);
      else ({ ll, brg } = pathAt(st.P, st.d));
      seen.add(v.key);

      let tm = trainMarkers.get(v.key);
      if (!tm) {
        const marker = L.marker(ll, { icon: trainIcon(v.route), pane: "trains", keyboard: false }).addTo(map);
        tm = { marker, cls: "", brg: 0 };
        const key = v.key;
        marker.bindPopup("", { maxWidth: 320, autoPan: false });
        marker.on("popupopen", () => { openTrain = key; marker.setPopupContent(trainPopup(tm.v, tm.st, tm.sec)); });
        marker.on("popupclose", () => { if (openTrain === key) openTrain = null; });
        trainMarkers.set(v.key, tm);
      } else {
        tm.marker.setLatLng(ll);
      }
      if (brg !== null) tm.brg = brg;
      tm.v = v; tm.st = st; tm.sec = sec;
      const el = tm.marker.getElement();
      if (el) {
        if (!tm.dirEl) { tm.dirEl = el.querySelector(".dir"); tm.trainEl = el.querySelector(".train"); }
        tm.dirEl.style.transform = `rotate(${tm.brg}deg)`;
        const cls = st.kind === "trip" ? (st.tp.atStop >= 0 ? "at-station" : "") :
          (st.kind === "depot" || st.leg.parked) ? "parked" : "nonservice";
        if (cls !== tm.cls) {
          tm.trainEl.classList.remove("at-station", "parked", "nonservice");
          if (cls) tm.trainEl.classList.add(cls);
          tm.cls = cls;
        }
      }
      const withBody = bodies && st.kind !== "depot" && view.contains(ll);
      if (withBody) {
        // Number and arrow ride on the lead car instead of the round marker.
        tm.marker.setLatLng(drawBody(tm, v, st, tm.cls));
      } else hideBody(tm);
      if (tm.trainEl && withBody !== tm.hasBody) { tm.trainEl.classList.toggle("has-body", withBody); tm.hasBody = withBody; }
      if (slow && openTrain === v.key) tm.marker.setPopupContent(trainPopup(v, st, sec));
    }
    for (const [key, tm] of trainMarkers) {
      if (!seen.has(key)) { hideBody(tm); map.removeLayer(tm.marker); trainMarkers.delete(key); }
    }

    if (slow) {
      lastSlow = now;
      for (const [key, m] of Object.entries(depotMarkers)) {
        const n = parked.filter(x => x.st.leg.depot === key).length;
        const el = m.getElement();
        if (el) el.querySelector(".depot-count").textContent = n;
        if (openDepot === key) m.setPopupContent(depotPopup(key, parked));
      }
      if (openStation) openStation.m.setPopupContent(stationPopup(openStation.g));
      renderCounts(counts, parked.length, nonService);
      renderClock(clockMs, counts);
    }
  }

  // ---------- Panel ----------
  const linesEl = document.getElementById("lines");
  const countEls = {};
  for (const r of LINE_ORDER) {
    const route = D.routes[r];
    const own = D.patterns.filter(p => p.route === r);
    const maxStops = Math.max(...own.map(p => p.stops.length));
    const ends = [...new Set(own.filter(p => p.stops.length === maxStops).map(p => p.headsign))].sort();
    const row = document.createElement("div");
    row.className = "line-row";
    row.title = "Show / hide this line's trains";
    row.innerHTML = `<span class="line-badge" style="background:${route.color};color:${route.text}">${route.name}</span>
      <span class="line-name">${ends.map(titleCase).join(" ⇄ ")}</span><span class="line-count">0</span>`;
    row.addEventListener("click", () => {
      visible[r] = !visible[r];
      row.classList.toggle("off", !visible[r]);
      if (visible[r]) lineLayers[r].addTo(overview); else overview.removeLayer(lineLayers[r]);
    });
    linesEl.appendChild(row);
    countEls[r] = row.querySelector(".line-count");
  }
  const bodyBox = document.getElementById("show-bodies");
  bodyBox.checked = showBodies;
  bodyBox.addEventListener("change", () => {
    showBodies = bodyBox.checked;
    try { localStorage.setItem("metro.bodies", showBodies ? "1" : "0"); } catch (e) { /* storage unavailable */ }
  });

  const fleetEl = document.getElementById("fleet");
  function renderCounts(counts, inDepot, nonService) {
    for (const r of LINE_ORDER) countEls[r].textContent = counts[r];
    fleetEl.innerHTML = `<span><span class="swatch nonservice"></span>${nonService} turning back / out of service</span>` +
      `<span><span class="swatch depot">D</span>${inDepot} in depots</span>`;
  }

  const clockTime = document.getElementById("clock-time");
  const clockDate = document.getElementById("clock-date");
  const clockMode = document.getElementById("clock-mode");
  const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });
  function renderClock(ms, counts) {
    const { p } = clockAt(ms);
    clockTime.textContent = [p.hour, p.minute, p.second].map(v => String(v).padStart(2, "0")).join(":");
    clockDate.textContent = dateFmt.format(new Date(ms)) + " · Sofia time";
    let mode = live && speed === 1 ? "● Now (timetable)" : `Simulated time · ${speed}×`;
    const today = ymd(p.year, p.month, p.day);
    if (today < D.feed.start || today > D.feed.end) mode += " · outside timetable validity";
    else if (Object.values(counts).every(c => c === 0)) mode += " · no trains in service";
    clockMode.textContent = mode;
  }

  const simInput = document.getElementById("sim-time");
  const liveBtn = document.getElementById("live");
  const speedBtns = [...document.querySelectorAll("#speed button")];
  function syncInputs() {
    const p = sofiaParts(simNow());
    simInput.value = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    liveBtn.classList.toggle("is-live", live && speed === 1);
    speedBtns.forEach(b => b.classList.toggle("active", +b.dataset.speed === speed));
  }
  simInput.addEventListener("change", () => {
    const m = simInput.value.match(/^(\d+)-(\d+)-(\d+)T(\d+):(\d+)/);
    if (!m) return;
    live = false;
    setSim(sofiaToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5]));
    syncInputs();
  });
  liveBtn.addEventListener("click", () => { live = true; setSim(Date.now(), 1); syncInputs(); });
  speedBtns.forEach(b => b.addEventListener("click", () => {
    const s = +b.dataset.speed;
    if (s !== 1) live = false;
    setSim(simNow(), s);
    syncInputs();
  }));
  const delayInput = document.getElementById("delay");
  const delayReset = document.getElementById("delay-reset");
  function syncDelay() {
    delayInput.value = timetableDelay;
    delayReset.disabled = timetableDelay === DEFAULT_DELAY;
  }
  function setDelay(v) {
    timetableDelay = Math.max(-600, Math.min(600, Math.round(v)));
    try { localStorage.setItem("metro.delay", String(timetableDelay)); } catch (e) { /* storage unavailable */ }
    syncDelay();
  }
  delayInput.addEventListener("input", () => { if (delayInput.value !== "" && Number.isFinite(+delayInput.value)) setDelay(+delayInput.value); });
  delayInput.addEventListener("change", syncDelay);
  delayReset.addEventListener("click", () => setDelay(DEFAULT_DELAY));
  syncDelay();
  document.getElementById("collapse").addEventListener("click", () =>
    document.getElementById("panel").classList.toggle("collapsed"));
  if (window.matchMedia("(max-width: 600px)").matches) document.getElementById("panel").classList.add("collapsed");

  const fmtDate = s => `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)}`;
  document.getElementById("source").innerHTML =
    `Timetable: official GTFS feed of the <a href="https://www.sofiatraffic.bg/" target="_blank" rel="noopener">Sofia Urban Mobility Center</a>, ` +
    `valid ${fmtDate(D.feed.start)}–${fmtDate(D.feed.end)}. Track layout © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors. ` +
    `Data built ${D.built.slice(0, 10)}. Turnbacks and depot moves are simulated.`;

  // ---------- Loop ----------
  syncInputs();
  setInterval(() => { if (document.activeElement !== simInput) syncInputs(); }, 5000);
  requestAnimationFrame(frame);
})();
