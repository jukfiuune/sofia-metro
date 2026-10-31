/* Simulated buses, trams and trolleybuses for any date and time.
 *
 * Every vehicle duty of the day (GTFS block) is driven through travel times
 * learned from recordings (data/sim.js, built by tools/build_sim.py): each stop-to-
 * stop segment takes its free-flow time times the slow-down for that day type and
 * hour, each stop its typical dwell. Vehicles leave the nearest depot of their kind
 * before their first trip, wait at termini for their next departure, return to the
 * depot during long breaks and at the end of the day. Lateness builds up and is
 * absorbed at layovers, as in reality.
 */
(function () {
  "use strict";

  const S = window.SIM_DATA, X = ST.transit;
  const DAY_START = 3 * 3600;
  const DEADHEAD = 25 / 3.6;           // m/s for empty runs (straight line x 1.35)
  const READY = 4 * 60;                // s at the first stop before departure
  const BREAK_TO_DEPOT = 75 * 60;
  const DEFAULT_DWELL = 15;
  const LAT0 = 42.69, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 111320;
  const xy = (lat, lon) => [(lon - 23.32) * KX, (lat - LAT0) * KY];
  const ll = (x, y) => [LAT0 + y / KY, 23.32 + x / KX];

  // ---------- Data ----------
  const base = new Date(Date.UTC(+S.dateBase.slice(0, 4), +S.dateBase.slice(4, 6) - 1, +S.dateBase.slice(6, 8)));
  const dayIndex = date => Math.round((Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)) - base) / 86400000);
  const patterns = S.patterns.map(p => {
    const tp = X.PATTERNS[p.sh];
    const stops = p.s ? p.s.map(s => typeof s === "number" ? s : -1) : tp.s;
    return { shape: p.sh, stops, d: p.d || tp.d, t: p.t, g: p.g, route: tp ? tp.r : null, head: tp ? tp.h : "" };
  });
  const depots = S.depots.map((d, i) => ({ ...d, i, xy: xy(d.lat, d.lon), kind: Object.keys(d.kinds).sort((a, b) => d.kinds[b] - d.kinds[a])[0] }));
  const factorAt = (str, hour) => {
    if (!str) return null;
    for (let k = 0; k < 24; k++) {                        // nearest hour with data
      for (const h of [hour - k, hour + k]) {
        const c = str[((h % 24) + 24) % 24];
        if (c && c !== "!") return 1 + (c.charCodeAt(0) - 48) * 0.05;
      }
    }
    return null;
  };
  const dwellAt = (stop, dtype, hour) => {
    const s = S.dwell[stop];
    if (!s) return DEFAULT_DWELL;
    const c = s[dtype][hour];
    return c && c !== "!" ? (c.charCodeAt(0) - 48) * 2 : DEFAULT_DWELL;
  };

  // ---------- Duties for one service day ----------
  /** Profile column: 0 weekday, 1 saturday, 2 sunday. */
  function dayType(date) {
    const wd = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8))).getUTCDay();
    return wd === 0 ? 2 : wd === 6 ? 1 : 0;
  }
  const cache = new Map();
  function dutiesFor(date) {
    if (cache.has(date)) return cache.get(date);
    const k = dayIndex(date);
    const dtype = dayType(date);
    const byDuty = new Map();
    if (k >= 0) for (const [pi, start, cal, duty] of S.trips) {
      if (S.calendars[cal][k] !== "1") continue;
      if (!byDuty.has(duty)) byDuty.set(duty, []);
      byDuty.get(duty).push({ p: patterns[pi], start });
    }
    const list = [];
    for (const [duty, trips] of byDuty) {
      trips.sort((a, b) => a.start - b.start);
      const v = plan(duty, trips, dtype);
      if (v) list.push(v);
    }
    const out = { date, list, byStop: null, dtype, byName: new Map(list.map(v => [v.name, v])) };
    if (cache.size > 3) cache.delete(cache.keys().next().value);
    cache.set(date, out);
    return out;
  }

  /** Run time (s) of segment i-1 -> i of pattern p, starting at service-day second t. */
  function segmentTime(p, i, t, dtype) {
    const prof = p.g[i - 1] >= 0 ? S.profiles[p.g[i - 1]] : null;
    const f = prof ? factorAt(prof[1 + dtype], Math.floor((t % 86400) / 3600)) : null;
    return Math.max(10, prof && f ? prof[0] * f : Math.max(20, (p.t[i] - p.t[i - 1]) - DEFAULT_DWELL));
  }

  /**
   * Legs: {t0, t1, type: "shape"|"line"|"hold", ...}, and predicted stop times per trip.
   * With `from` = {k, s, t} the plan starts mid-day from a real position: trip k,
   * s metres along its shape, at service-day second t (a live vehicle's forecast).
   */
  function plan(duty, trips, dtype, from) {
    const first = trips[0].p;
    if (!first.route || !X.ROUTES[first.route]) return null;
    const route = first.route, kind = X.kindOf(route), kindBase = X.ROUTES[route].kind;
    const stopXY = i => { const s = X.STOPS[i]; return s ? xy(s.lat, s.lon) : null; };
    const startXY = stopXY(first.stops[0]);
    const depot = depots.filter(d => d.kind === kindBase)
      .sort((a, b) => Math.hypot(a.xy[0] - startXY[0], a.xy[1] - startXY[1]) - Math.hypot(b.xy[0] - startXY[0], b.xy[1] - startXY[1]))[0];
    const legs = [], runs = [];
    let t;
    const deadhead = (t0, a, b) => {
      const dur = Math.hypot(b[0] - a[0], b[1] - a[1]) * 1.35 / DEADHEAD + 60;
      legs.push({ type: "line", t0, t1: t0 + dur, a, b });
      return t0 + dur;
    };
    if (from) t = from.t;
    else if (depot) {
      const out = Math.hypot(depot.xy[0] - startXY[0], depot.xy[1] - startXY[1]) * 1.35 / DEADHEAD + 60;
      t = trips[0].start - READY - out;
      legs.push({ type: "hold", t0: DAY_START, t1: t, at: depot.xy, depot: depot.i, status: "depot" });
      t = deadhead(t, depot.xy, startXY);
    } else t = trips[0].start - READY;

    trips.forEach((tr, k) => {
      const p = tr.p, n = p.stops.length;
      if (from && k < from.k) { runs.push({ p, start: tr.start, times: null }); return; }
      const times = new Array(n).fill(null);           // predicted departure from stop 0, arrival at others
      let i0 = 1, s0 = null;
      if (from && k === from.k) {
        // Mid-trip: continue from the live position to the next stop.
        i0 = Math.max(1, p.d.findIndex(d => d > from.s + 1));
        if (i0 < 1 || p.d[i0] == null) i0 = n - 1;
        s0 = Math.min(from.s, p.d[i0]);
      } else {
        const begin = Math.max(t, tr.start);
        legs.push({ type: "hold", t0: t, t1: begin, at: stopXY(p.stops[0]), status: k === 0 ? "ready" : "layover", run: runs.length, i: 0 });
        t = begin;
        times[0] = t;
      }
      for (let i = i0; i < n; i++) {
        const full = segmentTime(p, i, t, dtype);
        const a = i === i0 && s0 != null ? s0 : p.d[i - 1];
        const frac = p.d[i] > p.d[i - 1] ? (p.d[i] - a) / (p.d[i] - p.d[i - 1]) : 1;
        const run = Math.max(1, full * Math.max(0, Math.min(1, frac)));
        legs.push({ type: "shape", t0: t, t1: t + run, shape: p.shape, s0: a, s1: p.d[i], run: runs.length, i });
        t += run;
        times.push(t);
        if (i < n - 1) {
          const dw = dwellAt(p.stops[i], dtype, Math.floor((t % 86400) / 3600));
          legs.push({ type: "hold", t0: t, t1: t + dw, at: stopXY(p.stops[i]), status: "stop", run: runs.length, i });
          t += dw;
        }
      }
      runs.push({ p, start: tr.start, times });
      const next = trips[k + 1], endXY = stopXY(p.stops[n - 1]);
      if (!next) {
        legs.push({ type: "hold", t0: t, t1: t + 60, at: endXY, status: "terminating", run: runs.length - 1, i: n - 1 });
        if (depot) {
          t = deadhead(t + 60, endXY, depot.xy);
          legs.push({ type: "hold", t0: t, t1: DAY_START + 86400 + 4 * 3600, at: depot.xy, depot: depot.i, status: "depot" });
        }
        return;
      }
      const nextXY = stopXY(next.p.stops[0]);
      const gap = next.start - t;
      if (depot && gap > BREAK_TO_DEPOT && Math.hypot(endXY[0] - depot.xy[0], endXY[1] - depot.xy[1]) < 6000) {
        t = deadhead(t + 60, endXY, depot.xy);
        const back = Math.hypot(depot.xy[0] - nextXY[0], depot.xy[1] - nextXY[1]) * 1.35 / DEADHEAD + 60;
        const leave = Math.max(t, next.start - READY - back);
        legs.push({ type: "hold", t0: t, t1: leave, at: depot.xy, depot: depot.i, status: "depot" });
        t = deadhead(leave, depot.xy, nextXY);
      } else if (Math.hypot(endXY[0] - nextXY[0], endXY[1] - nextXY[1]) > 50) {
        t = deadhead(t, endXY, nextXY);
      }
    });
    return { id: "sim:" + duty, duty, name: S.duties[duty], route, kind, kindBase, legs, runs, li: 0, depot: depot ? depot.i : null };
  }

  // ---------- State at a time ----------
  function stateAt(v, sec) {
    const legs = v.legs;
    let i = v.li;
    if (i >= legs.length || legs[i].t0 > sec) i = 0;
    while (i < legs.length && legs[i].t1 <= sec) i++;
    v.li = i;
    const leg = legs[i];
    if (!leg || leg.t0 > sec) return null;
    const f = (sec - leg.t0) / Math.max(1e-6, leg.t1 - leg.t0);
    v.leg = leg;
    v.runIdx = leg.run;
    const run = leg.run != null ? v.runs[leg.run] : null;
    v.routeId = run ? run.p.route : v.route;
    v.shapeId = run ? run.p.shape : null;
    v.pattern = run ? X.PATTERNS[run.p.shape] || null : null;
    v.simPattern = run ? run.p : null;
    if (leg.type === "shape") {
      const e = f * f * (3 - 2 * f);
      v.sDisp = leg.s0 + (leg.s1 - leg.s0) * e;
      const sh = X.shape(leg.shape);
      const a = X.along(sh, v.sDisp);
      v.ll = a.ll; v.brg = a.brg; v.onShape = true;
      v.speed = (leg.s1 - leg.s0) / (leg.t1 - leg.t0) * 6 * f * (1 - f) * 3.6;
    } else if (leg.type === "line") {
      const x = leg.a[0] + (leg.b[0] - leg.a[0]) * f, y = leg.a[1] + (leg.b[1] - leg.a[1]) * f;
      v.ll = ll(x, y); v.brg = Math.atan2(leg.b[0] - leg.a[0], leg.b[1] - leg.a[1]) * 180 / Math.PI;
      v.onShape = false; v.sDisp = null; v.speed = DEADHEAD * 3.6;
    } else {
      v.ll = ll(leg.at[0], leg.at[1]); v.onShape = false; v.speed = 0;
      v.sDisp = run && leg.status !== "depot" ? run.p.d[leg.i] : null;
      if (v.sDisp != null) v.onShape = true;
    }
    v.status = leg.type === "line" ? (leg.b === (depots[v.depot] || {}).xy ? "toDepot" : "deadhead") : leg.type === "hold" ? leg.status : "moving";
    return v;
  }

  /** Service day and seconds since its midnight for an epoch time (days change at 03:00). */
  function serviceDay(ms) {
    const { p, sec } = ST.clockAt(ms);
    return sec >= DAY_START ? [ST.ymd(p.year, p.month, p.day), sec] : [ST.shiftDay(p, -1), sec + 86400];
  }

  // When the clock leaves real time, live vehicles carry on from their real positions:
  // their forecasts replace their duties' plans from that moment on.
  let handover = null;      // {date, sec, byDuty: Map(duty name -> forecast vehicle)}
  function setHandover(date, sec, byDuty) { handover = byDuty && byDuty.size ? { date, sec, byDuty } : null; }

  function vehiclesAt(ms) {
    const [date, sec] = serviceDay(ms);
    const day = dutiesFor(date);
    const ho = handover && handover.date === date && sec >= handover.sec ? handover.byDuty : null;
    const out = [];
    for (const base of day.list) {
      const v = (ho && ho.get(base.name)) || base;
      if (stateAt(v, sec)) { v.sec = sec; out.push(v); }
    }
    return out;
  }

  /** Predicted departures at a stop: [{time (epoch ms), route, head, v}] for the next `horizon` s. */
  function departures(stopIdx, ms, horizon = 3600) {
    const [date, sec] = serviceDay(ms);
    const day = dutiesFor(date);
    if (!day.byStop) {
      day.byStop = new Map();
      for (const v of day.list) v.runs.forEach((r, ri) => r.p.stops.forEach((s, i) => {
        if (i === r.p.stops.length - 1) return;
        if (!day.byStop.has(s)) day.byStop.set(s, []);
        day.byStop.get(s).push({ v, ri, i });
      }));
    }
    const midnight = ms - sec * 1000;
    return (day.byStop.get(stopIdx) || []).map(x => {
      const r = x.v.runs[x.ri];
      return { t: r.times[x.i], sched: r.start + r.p.t[x.i], route: r.p.route, head: r.p.head, v: x.v };
    }).filter(x => x.t >= sec - 30 && x.t <= sec + horizon).sort((a, b) => a.t - b.t)
      .map(x => ({ ...x, time: midnight + x.t * 1000, delay: x.t - x.sched }));
  }

  function parkedAt(depotIdx, ms) {
    const [date, sec] = serviceDay(ms);
    return dutiesFor(date).list.filter(v => { const s = stateAt(v, sec); return s && s.leg.type === "hold" && s.leg.depot === depotIdx; });
  }

  /**
   * Forecast for a live vehicle: its duty re-planned from where it is now (trip
   * `tripId`, s metres along the shape, at epoch ms), with the same travel-time
   * model as the simulation. Returns a vehicle-like object usable with stateAt(),
   * or null if the duty or trip can't be found.
   */
  function forecast(tripId, s, ms) {
    const duty = dutyOfTrip(tripId, ms);
    if (!duty) return null;
    const [, sec] = serviceDay(ms);
    const shapeId = tripId.split("-")[1];
    // The duty's trip on this shape whose timetable best fits the vehicle's position now.
    let k = -1, best = Infinity;
    duty.runs.forEach((r, i) => {
      if (r.p.shape !== shapeId) return;
      const j = Math.max(0, r.p.d.findIndex(d => d >= s));
      const err = Math.abs(r.start + r.p.t[j] - sec);
      if (err < best) { best = err; k = i; }
    });
    if (k < 0 || best > 3 * 3600) return null;
    const trips = duty.runs.map(r => ({ p: r.p, start: r.start }));
    const v = plan(duty.duty, trips, dayType(serviceDay(ms)[0]), { k, s, t: sec });
    if (v) { v.id = "fc:" + tripId; v.runIdx = k; v.sec = sec; }
    return v;
  }

  /** The simulated duty a live trip belongs to: GTFS block_id = route + run + service id. */
  function dutyOfTrip(tripId, ms) {
    const [route, , run, , svc] = tripId.split("-");
    const day = dutiesFor(serviceDay(ms)[0]);
    return day.byName.get(`${route}${run}${svc}`) || day.byName.get(`${route}-run${run}`) || null;
  }

  ST.sim = { ready: true, label: S.label, depots, vehiclesAt, departures, parkedAt, serviceDay, dutiesFor, dutyOfTrip, forecast, stateAt, setHandover };
  ST.emit("sim");
})();
