/* Live buses, trams and trolleybuses from the official GTFS-realtime feed of the
 * Sofia Urban Mobility Center (gtfs.sofiatraffic.bg, CORS-enabled).
 *
 * Each vehicle reports about every 5 s. Its trip_id names the shape it runs on, so
 * every GPS fix is snapped to that route shape and the vehicle is drawn a few
 * seconds behind real time, gliding along the shape between two real fixes. */
(function () {
  "use strict";

  const TD = window.TRANSIT_DATA;
  const map = ST.map, t = ST.t;
  const FEED = "https://gtfs.sofiatraffic.bg/api/v1/";
  const POLL = 5000;            // ms between vehicle-position fetches
  const TRIP_POLL = 20000;      // ms between trip-update fetches (only while a card needs them)
  const LAG = 6000;             // ms: vehicles are shown this far behind the latest fix
  const SNAP = 45;              // m: fixes further than this from the shape are drawn unsnapped
  const STALE = 90;             // s without a new fix: continues on its forecast (or fades)
  const LOST = 300;             // s without a fix and no forecast: hidden
  const GONE = 900;             // s without a new fix: removed (forecast continues until then)

  // ---------- Minimal protobuf reader (GTFS-realtime) ----------
  function readVarint(b, pos) {
    let lo = 0, shift = 0, byte;
    do {
      byte = b[pos.i++];
      if (shift < 28) lo |= (byte & 0x7f) << shift; else lo += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while (byte & 0x80);
    if (shift > 35 && lo >= 2 ** 63) return lo - 2 ** 64;   // negative int32/int64 (10-byte varint)
    return lo >>> 0 === lo ? lo : lo;
  }
  /** Parse one message into {field: [values]}; bytes values are Uint8Array views. */
  function msg(b) {
    const out = {}, pos = { i: 0 };
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    while (pos.i < b.length) {
      const key = readVarint(b, pos), f = key >>> 3, wt = key & 7;
      let v;
      if (wt === 0) v = readVarint(b, pos);
      else if (wt === 1) { v = dv.getFloat64(pos.i, true); pos.i += 8; }
      else if (wt === 5) { v = dv.getFloat32(pos.i, true); pos.i += 4; }
      else if (wt === 2) { const len = readVarint(b, pos); v = b.subarray(pos.i, pos.i + len); pos.i += len; }
      else break;
      (out[f] || (out[f] = [])).push(v);
    }
    return out;
  }
  const dec = new TextDecoder();
  const str = v => v ? dec.decode(v) : "";
  const int32 = v => v > 0x7fffffff ? v - 0x100000000 : v;

  // ---------- Static data ----------
  const ROUTES = TD.routes;
  const kindOf = id => ROUTES[id] ? (ROUTES[id].night ? "night" : ROUTES[id].kind) : "bus";
  const baseKind = id => ROUTES[id] ? ROUTES[id].kind : "bus";
  const STOPS = TD.stops.map(([id, code, name, en, lat, lon, routes]) => ({ id, code, name, en, lat, lon, routes }));
  const stopById = new Map(STOPS.map(s => [s.id, s]));
  const stopIndex = new Map(STOPS.map((s, i) => [s.id, i]));
  const PATTERNS = TD.patterns;               // shapeId -> {r, h, s: stop indices, d: distances}
  const lineInfo = id => ({ id, name: ROUTES[id].name, kind: kindOf(id), color: ROUTES[id].color, text: ROUTES[id].text });
  const KIND_ORDER = { tram: 0, trolley: 1, bus: 2, night: 3 };
  const routeIds = Object.keys(ROUTES).sort((a, b) =>
    KIND_ORDER[kindOf(a)] - KIND_ORDER[kindOf(b)] || (parseInt(ROUTES[a].name) || 999) - (parseInt(ROUTES[b].name) || 999) || ROUTES[a].name.localeCompare(ROUTES[b].name));
  ST.registerLines(routeIds.map(lineInfo));
  const chip = id => ST.lineChip(lineInfo(id));

  const LAT0 = 42.69, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 111320;

  // Route shapes are decoded lazily from Google encoded polylines.
  const shapeCache = new Map();
  function shape(id) {
    if (shapeCache.has(id)) return shapeCache.get(id);
    const enc = window.TRANSIT_SHAPES && window.TRANSIT_SHAPES[id];
    if (!enc) return null;
    const pts = [];
    let i = 0, lat = 0, lon = 0;
    while (i < enc.length) {
      for (const k of [0, 1]) {
        let res = 0, sh = 0, b;
        do { b = enc.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
        const d = res & 1 ? ~(res >> 1) : res >> 1;
        if (k === 0) lat += d; else lon += d;
      }
      pts.push([lat / 1e5, lon / 1e5]);
    }
    const x = pts.map(p => (p[1] - 23.32) * KX), y = pts.map(p => (p[0] - LAT0) * KY);
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(x[k] - x[k - 1], y[k] - y[k - 1]));
    const s = { id, pts, x, y, cum, len: cum.at(-1) };
    shapeCache.set(id, s);
    return s;
  }

  /** Nearest point on the shape to (lat, lon), searching s in [lo, hi]. */
  function project(sh, lat, lon, lo = 0, hi = Infinity) {
    const px = (lon - 23.32) * KX, py = (lat - LAT0) * KY;
    let best = Infinity, bestS = 0;
    for (let k = 0; k < sh.pts.length - 1; k++) {
      if (sh.cum[k + 1] < lo || sh.cum[k] > hi) continue;
      const x1 = sh.x[k], y1 = sh.y[k], dx = sh.x[k + 1] - x1, dy = sh.y[k + 1] - y1;
      const L2 = dx * dx + dy * dy;
      const f = L2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2)) : 0;
      const e = Math.hypot(px - x1 - dx * f, py - y1 - dy * f);
      if (e < best) { best = e; bestS = sh.cum[k] + Math.sqrt(L2) * f; }
    }
    return { s: bestS, err: best };
  }

  /** Point and heading at distance s along a shape (continuing straight past the ends). */
  function along(sh, s) {
    const n = sh.pts.length;
    let lo = 0, hi = n - 1;
    const ss = Math.max(0, Math.min(sh.len, s));
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (sh.cum[mid] <= ss) lo = mid; else hi = mid; }
    const seg = sh.cum[hi] - sh.cum[lo] || 1;
    const f = (s - sh.cum[lo]) / seg;
    const a = sh.pts[lo], b = sh.pts[hi];
    return { ll: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f],
      brg: Math.atan2((b[1] - a[1]) * KX, (b[0] - a[0]) * KY) * 180 / Math.PI };
  }

  // ---------- Names ----------
  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s\-.(„"/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
      .replace(/\b(Ж\.к|Кв|Ул|Бул|Пл|Ж\.к\.)\b/g, m => m.toLowerCase())
      .replace(/(^|\s)(Ндк|Мбал|Умбал|Нбу|Ту|Унсс|Бан|Цгм)(?=\s|$|\.)/g, (m, a, b) => a + b.toUpperCase());
  }
  // Bulgarian streamlined transliteration (official system) for English mode.
  const TR = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
    р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sht", ъ: "a", ь: "y", ю: "yu", я: "ya" };
  function translit(s) {
    return s.replace(/[а-яА-Я]/g, ch => {
      const low = ch.toLowerCase(), r = TR[low] ?? ch;
      return ch === low ? r : r.charAt(0).toUpperCase() + r.slice(1);
    });
  }
  const enByName = new Map(STOPS.filter(s => s.en).map(s => [s.name, s.en]));
  const placeName = bg => ST.lang === "bg" ? titleCase(bg) : (enByName.get(bg) ? titleCase(enByName.get(bg)) : translit(titleCase(bg)));
  const stopName = s => placeName(s.name);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fact = (label, value) => `<div class="fact"><span>${label}</span><b>${value}</b></div>`;
  const minsText = s => s < 60 ? (s < 20 ? t("nowShort") : `${Math.round(s)} ${t("sec")}`) : `${Math.round(s / 60)} ${t("min")}`;

  // ---------- Fleet (models by fleet number) ----------
  const DEFAULT_SECTIONS = { bus: [12], trolley: [12], tram: [15, 15] };
  function modelFor(v) {
    const F = window.FLEET;
    const num = parseInt(v.id.replace(/^\D+/, ""), 10);
    const m = F && F.lookup ? F.lookup(v.kindBase, num) : null;
    return m;
  }
  function sectionsFor(v) {
    const m = v.model;
    if (m && m.sections && m.sections.length) {
      const one = m.sections;
      return m.coupled > 1 ? Array.from({ length: m.coupled }, () => one).flat() : one;
    }
    return DEFAULT_SECTIONS[v.kindBase] || [12];
  }

  // ---------- Vehicles ----------
  const vehicles = new Map();   // vehicle id -> state
  let feedTime = 0, lastOk = 0, lastFail = 0, fetching = false;

  function prefixKind(id) { return id.startsWith("TM") ? "tram" : id.startsWith("TB") ? "trolley" : "bus"; }

  function ingestPositions(buf) {
    const feed = msg(new Uint8Array(buf));
    const header = feed[1] ? msg(feed[1][0]) : {};
    feedTime = (header[3] ? header[3][0] : Date.now() / 1000) * 1000;
    const seen = new Set();
    for (const e of feed[2] || []) {
      const ent = msg(e);
      if (!ent[4]) continue;
      const vp = msg(ent[4][0]);
      const trip = vp[1] ? msg(vp[1][0]) : {};
      const pos = vp[2] ? msg(vp[2][0]) : null;
      const veh = vp[8] ? msg(vp[8][0]) : {};
      if (!pos) continue;
      const id = str(veh[1] && veh[1][0]) || str(ent[1] && ent[1][0]);
      const tripId = str(trip[1] && trip[1][0]);
      const routeId = str(trip[5] && trip[5][0]) || tripId.split("-")[0];
      const ts = (vp[5] ? vp[5][0] : feedTime / 1000) * 1000;
      seen.add(id);
      let v = vehicles.get(id);
      if (!v) {
        v = { id, fixes: [], kindBase: prefixKind(id) };
        v.model = modelFor(v);
        vehicles.set(id, v);
      }
      if (v.tripId !== tripId) {
        v.tripId = tripId;
        v.routeId = routeId;
        v.shapeId = tripId.split("-")[1] || "";
        v.pattern = PATTERNS[v.shapeId] || null;
        v.fixes = [];
        v.sDisp = null;
      }
      v.kind = kindOf(routeId);
      v.occupancy = vp[9] ? vp[9][0] : null;
      v.stopId = vp[7] ? str(vp[7][0]) : null;
      v.status = vp[4] ? vp[4][0] : null;
      v.speed = pos[5] ? pos[5][0] : null;              // km/h in this feed
      v.bearingFeed = pos[3] ? pos[3][0] : null;
      const last = v.fixes.at(-1);
      if (last && last.t >= ts) continue;
      const fix = { t: ts, lat: pos[1][0], lon: pos[2][0], s: null };
      const sh = v.pattern ? shape(v.shapeId) : null;
      if (sh) {
        // Search ahead of the last snapped fix first (shapes can pass the same street twice).
        const prev = [...v.fixes].reverse().find(f => f.s !== null);
        let p = prev ? project(sh, fix.lat, fix.lon, prev.s - 60, prev.s + 2500) : null;
        if (!p || p.err > SNAP) p = project(sh, fix.lat, fix.lon);
        if (p.err <= SNAP) fix.s = prev && p.s < prev.s && prev.s - p.s < 40 ? prev.s : p.s;   // GPS jitter backwards
      }
      v.fixes.push(fix);
      if (v.fixes.length > 6) v.fixes.shift();
    }
    for (const [id, v] of vehicles) {
      if (!seen.has(id) && feedTime - (v.fixes.at(-1)?.t || 0) > GONE * 1000) vehicles.delete(id);
    }
  }

  async function poll() {
    if (fetching || document.hidden || !ST.clock.isRealtime()) return;
    fetching = true;
    try {
      const r = await fetch(FEED + "vehicle-positions", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      ingestPositions(await r.arrayBuffer());
      lastOk = Date.now();
      ST.invalidate();
    } catch (e) {
      lastFail = Date.now();
    } finally {
      fetching = false;
      updateFeedState();
    }
  }
  function updateFeedState() {
    if (!ST.clock.isRealtime()) return ST.setFeedState("off", t("liveHidden"));
    const age = (Date.now() - lastOk) / 1000;
    if (!lastOk) ST.setFeedState(lastFail ? "error" : "wait", lastFail ? t("liveError") : "");
    else if (age > 30) ST.setFeedState("error", t("liveError"));
    else if ((Date.now() - feedTime) / 1000 > 60) ST.setFeedState("stale", t("liveStale"));
    else ST.setFeedState("ok", t("live"));
  }
  setInterval(poll, POLL);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  ST.on("clock", () => { updateFeedState(); poll(); });
  poll();

  // ---------- Trip updates (arrival predictions), fetched on demand ----------
  let tripUpdates = null, tuTime = 0, tuFetching = false;
  async function fetchTripUpdates(force) {
    if (tuFetching || (!force && Date.now() - tuTime < TRIP_POLL)) return;
    tuFetching = true;
    try {
      const r = await fetch(FEED + "trip-updates", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      const feed = msg(new Uint8Array(await r.arrayBuffer()));
      const byTrip = new Map(), byStop = new Map();
      for (const e of feed[2] || []) {
        const ent = msg(e);
        if (!ent[3]) continue;
        const tu = msg(ent[3][0]);
        const trip = msg(tu[1][0]);
        const tripId = str(trip[1] && trip[1][0]);
        const routeId = str(trip[5] && trip[5][0]) || tripId.split("-")[0];
        const stops = [];
        for (const raw of tu[2] || []) {
          const s = msg(raw);
          const ev = s[2] ? msg(s[2][0]) : s[3] ? msg(s[3][0]) : null;
          const time = ev && ev[2] ? ev[2][0] * 1000 : null;
          const delay = ev && ev[1] ? int32(ev[1][0]) : null;
          const stopId = str(s[4] && s[4][0]);
          if (s[5] && s[5][0] === 1) continue;                 // SKIPPED
          stops.push({ seq: s[1] ? s[1][0] : null, stopId, time, delay });
        }
        const rec = { tripId, routeId, shapeId: tripId.split("-")[1], stops, delay: tu[5] ? int32(tu[5][0]) : null };
        byTrip.set(tripId, rec);
        for (const st of stops) {
          if (!st.time) continue;
          let arr = byStop.get(st.stopId);
          if (!arr) byStop.set(st.stopId, arr = []);
          arr.push({ rec, st });
        }
      }
      tripUpdates = { byTrip, byStop };
      tuTime = Date.now();
      ST.renderCard(true);
    } catch (e) { /* keep the previous data */ } finally { tuFetching = false; }
  }

  // ---------- Display position ----------
  function targetS(v, T) {
    const f = v.fixes;
    let i = f.length - 1;
    while (i > 0 && f[i].t > T) i--;
    const a = f[i], b = f[i + 1];
    if (a.s === null || (b && b.s === null)) return null;
    if (b && T <= b.t && T >= a.t) return a.s + (b.s - a.s) * (T - a.t) / (b.t - a.t);
    if (T < a.t) return a.s;
    // Past the newest fix: keep going at the last speed for a few seconds, never past the next stop.
    const p = f[i - 1];
    if (!p || p.s === null) return a.s;
    const vel = Math.max(0, Math.min(25, (a.s - p.s) / ((a.t - p.t) / 1000)));
    let s = a.s + vel * Math.min(6, (T - a.t) / 1000);
    const nextStop = v.pattern ? v.pattern.d.find(d => d > a.s + 5) : null;
    if (nextStop != null) s = Math.min(s, nextStop);
    return s;
  }

  /** Forecast for a live vehicle from its latest snapped fix (cached until the next fix). */
  function forecastOf(v) {
    if (!ST.sim || !v.tripId) return null;
    const f = [...v.fixes].reverse().find(x => x.s !== null);
    if (!f) return null;
    if (v.fcKey !== f.t) { v.fcKey = f.t; v.fc = ST.sim.forecast(v.tripId, f.s, f.t); }
    return v.fc;
  }

  /** Where a vehicle whose GPS has gone quiet should be now, from its forecast. */
  function estimate(v, now) {
    const fc = forecastOf(v);
    if (!fc) return false;
    const [, sec] = ST.sim.serviceDay(now);
    const st = ST.sim.stateAt(fc, sec);
    if (!st || ["depot", "toDepot", "deadhead", "terminating"].includes(st.status)) return false;
    v.ll = st.ll; v.brg = st.brg; v.sDisp = st.sDisp; v.onShape = st.onShape && st.shapeId === v.shapeId;
    if (st.shapeId && st.shapeId !== v.shapeId) v.onShape = false;
    return true;
  }

  function displayState(v, now) {
    const T = now - LAG;
    const sh = v.pattern ? shape(v.shapeId) : null;
    const target = sh ? targetS(v, T) : null;
    if (sh && target !== null) {
      if (v.sDisp == null || Math.abs(target - v.sDisp) > 400) v.sDisp = target;
      else if (target > v.sDisp - 25) v.sDisp += (target - v.sDisp) * Math.min(1, (now - (v.lastNow || now)) / 400 + 0.15);
      v.lastNow = now;
      const a = along(sh, v.sDisp);
      v.ll = a.ll; v.brg = a.brg; v.onShape = true;
      return v;
    }
    // Unsnapped: interpolate the raw fixes.
    const f = v.fixes;
    let i = f.length - 1;
    while (i > 0 && f[i].t > T) i--;
    const a = f[i], b = f[i + 1];
    const k = b ? Math.max(0, Math.min(1, (T - a.t) / (b.t - a.t))) : 0;
    const lat = b ? a.lat + (b.lat - a.lat) * k : a.lat, lon = b ? a.lon + (b.lon - a.lon) * k : a.lon;
    if (b) v.brg = Math.atan2((b.lon - a.lon) * KX, (b.lat - a.lat) * KY) * 180 / Math.PI;
    else if (v.bearingFeed != null) v.brg = v.bearingFeed;
    v.ll = [lat, lon]; v.onShape = false; v.sDisp = null;
    return v;
  }

  // ---------- Markers and bodies ----------
  const bodyRenderer = L.canvas({ pane: "bodies", padding: 0.2 });
  const markers = new Map();
  function vehIcon(v) {
    const r = ROUTES[v.routeId];
    const name = r ? r.name : (v.routeId || "?").replace(/^(TM|TB|A)/, "");
    return L.divIcon({
      className: "veh-icon", iconSize: [26, 26], iconAnchor: [13, 13],
      html: `<div class="veh k-${v.kind}" style="--c:${r ? r.color : "#6c757d"};--t:${r ? r.text : "#fff"}"><div class="dir"></div><div class="dot">${esc(name)}</div></div>`,
    });
  }
  function hideBody(m) { if (m.body) { for (const l of m.body) map.removeLayer(l); m.body = null; } }

  // The feed position is the front of the vehicle: standing at a stop, 12 m and 18 m
  // vehicles alike report within ~2 m of the stop pole. So bodies extend backwards from
  // it, and are drawn on the right-hand side of the road (shapes follow the centre line).
  const GAP = 0.9, RIGHT = 1.7, FRONT = 0.5;
  const bodyLength = v => { const s = sectionsFor(v); return s.reduce((a, b) => a + b, 0) + GAP * (s.length - 1); };
  function offsetLL(sh, s, right) {
    const a = along(sh, s), r = a.brg * Math.PI / 180;
    return [a.ll[0] - Math.sin(r) * right / KY, a.ll[1] + Math.cos(r) * right / KX];
  }
  const BELLOWS = ST.dark ? "#59606b" : "#3b4048";
  function drawBody(m, v, front, mpp) {
    const sh = shape(v.shapeId);
    const secs = sectionsFor(v);
    const w = Math.max(4, Math.min(14, 2.55 / mpp));
    const line = (a, b) => {
      const pts = [], steps = Math.max(1, Math.ceil((a - b) / 3));
      for (let i = 0; i <= steps; i++) pts.push(offsetLL(sh, a - (a - b) * i / steps, RIGHT));
      return pts;
    };
    // Body sections, with the articulation (bellows) between them as narrower dark joints.
    let s = front;
    const lines = [], joints = [];
    secs.forEach((len, i) => {
      lines.push(line(s, s - len));
      s -= len;
      if (i < secs.length - 1) { joints.push(line(s + 0.15, s - GAP - 0.15)); s -= GAP; }
    });
    const color = ROUTES[v.routeId] ? ROUTES[v.routeId].color : "#6c757d";
    const outline = ST.dark ? "#e8eaed" : "#1d1f23";
    const n = lines.length * 2 + joints.length * 2;
    if (!m.body || m.body.length !== n) {
      hideBody(m);
      m.body = [];
      const opts = { renderer: bodyRenderer, interactive: true, lineCap: "butt", lineJoin: "round" };
      for (const pts of joints) m.body.push(L.polyline(pts, { ...opts, color: outline, weight: w * 0.7 + 3 }).addTo(map));
      for (const pts of lines) {
        m.body.push(L.polyline(pts, { ...opts, color: outline, weight: w + 3 }).addTo(map));
        m.body.push(L.polyline(pts, { ...opts, color, weight: w }).addTo(map));
      }
      for (const pts of joints) m.body.push(L.polyline(pts, { ...opts, color: BELLOWS, weight: w * 0.7, dashArray: "2 1.5" }).addTo(map));
      for (const l of m.body) l.on("click", () => openVehicle(v.id));
      m.bodyStyle = "";
    }
    const style = `${w}|${color}|${ST.dark}`, nj = joints.length;
    joints.forEach((pts, i) => {
      m.body[i].setLatLngs(pts);
      m.body[nj + lines.length * 2 + i].setLatLngs(pts);
      if (style !== m.bodyStyle) {
        m.body[i].setStyle({ weight: w * 0.7 + 3, color: outline });
        m.body[nj + lines.length * 2 + i].setStyle({ weight: w * 0.7, color: ST.dark ? "#59606b" : "#3b4048" });
      }
    });
    lines.forEach((pts, i) => {
      m.body[nj + 2 * i].setLatLngs(pts);
      m.body[nj + 2 * i + 1].setLatLngs(pts);
      if (style !== m.bodyStyle) {
        m.body[nj + 2 * i].setStyle({ weight: w + 3, color: outline });
        m.body[nj + 2 * i + 1].setStyle({ weight: w, color });
      }
    });
    m.bodyStyle = style;
    return lines[0][Math.floor(lines[0].length / 2)];
  }

  /** GPS error can put a queued vehicle's front inside the one ahead; draw it just behind instead. */
  function separateQueues(list) {
    const xy = b => [(b.v.ll[1] - 23.32) * KX, (b.v.ll[0] - LAT0) * KY];
    for (let pass = 0; pass < 2; pass++) {
      list.sort((a, b) => b.front - a.front);
      for (const a of list) for (const b of list) {
        if (a === b) continue;
        let dBrg = Math.abs(a.v.brg - b.v.brg) % 360;
        if (dBrg > 180) dBrg = 360 - dBrg;
        if (dBrg > 35) continue;
        const [ax, ay] = xy(a), [bx, by] = xy(b);
        const r = a.v.brg * Math.PI / 180, hx = Math.sin(r), hy = Math.cos(r);
        const dx = ax - bx, dy = ay - by;
        const ahead = dx * hx + dy * hy - (a.front - a.v.sDisp) + (b.front - b.v.sDisp);   // a's front ahead of b's front
        const lateral = Math.abs(dx * hy - dy * hx);
        const need = a.len + 1.0;
        if (lateral < 2.5 && ahead >= 0 && ahead < need) b.front -= need - ahead;
      }
    }
  }

  const counts = { tram: 0, trolley: 0, bus: 0, night: 0 };
  let selectedId = null, lastSim = null;
  const OUT_OF_SERVICE = new Set(["depot", "toDepot", "deadhead"]);

  // ---------- Simulation (any time other than now) ----------
  let simLoading = false;
  function loadSim(quiet) {
    if (simLoading) return;
    simLoading = true;
    const v = (document.querySelector('script[src*="js/live.js"]').src.match(/\?v=\d+/) || [""])[0];
    const add = src => new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.body.appendChild(s);
    });
    if (!quiet) ST.toast(t("simLoading"));
    add("data/sim.js" + v).then(() => add("js/sim.js" + v)).then(() => { if (!quiet) ST.toast(null); }, () => { simLoading = false; if (!quiet) ST.toast(t("simFailed")); });
  }
  ST.on("sim", () => { drawDepots(); ST.invalidate(); });
  setTimeout(() => { if (!document.hidden) loadSim(true); }, 2500);

  // Depots (from the analysis), with the vehicles the simulation has parked there.
  const depotMarkers = [];
  function drawDepots() {
    for (const d of ST.sim.depots) {
      const m = L.marker([d.lat, d.lon], {
        pane: "stations", keyboard: false,
        icon: L.divIcon({ className: "depot-icon", iconSize: [30, 30], iconAnchor: [15, 15],
          html: `<div class="depot k-${d.kind}">${ST.kindIcon(d.kind, 18)}<span class="depot-count">0</span></div>` }),
      });
      m.on("click", () => ST.openCard({ id: "sdepot:" + d.i, render: () => depotCard(d) }));
      depotMarkers.push(m);
    }
  }
  function updateDepots(ctx) {
    if (!ST.sim) return;
    const show = !ST.clock.isRealtime();
    ST.sim.depots.forEach((d, i) => {
      const m = depotMarkers[i];
      if (!m) return;
      if (show && !map.hasLayer(m)) m.addTo(map);
      if (!show && map.hasLayer(m)) map.removeLayer(m);
      if (show && m.getElement()) m.getElement().querySelector(".depot-count").textContent = ST.sim.parkedAt(i, ctx.ms).length;
    });
  }
  function depotCard(d) {
    const parked = ST.sim.parkedAt(d.i, ST.clock.now());
    const byRoute = new Map();
    for (const v of parked) byRoute.set(v.route, (byRoute.get(v.route) || 0) + 1);
    let html = `<div class="card-head"><span class="kind-badge">${ST.kindIcon(d.kind, 22)}</span><div><div class="card-title">${t("depot")}</div>` +
      `<div class="card-sub">${t("kinds_" + d.kind)} · ${t("parkedN", { n: parked.length })} · ${t("simulated")}</div></div></div>`;
    html += `<div class="chips-row">${[...byRoute].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${chip(r)}<span class="muted small">×${n}</span>`).join(" ")}</div>`;
    return html + `<p class="small muted">${t("depotNote")}</p>`;
  }

  ST.addLayer({
    frame(ctx) {
      const realtime = ST.clock.isRealtime();
      const now = Date.now();
      const seen = new Set();
      const bodies = [];
      for (const k in counts) counts[k] = 0;
      // Real time: live GPS. Any other time: the simulation (loaded on first use).
      let list = null;
      if (realtime) list = vehicles.values();
      else if (ST.sim) list = ST.sim.vehiclesAt(ctx.ms);
      else loadSim();
      const sim = !realtime;
      if (realtime && ST.sim && ST.display.untracked) {
        // Scheduled duties with no live vehicle: shown hollow as "scheduled, no GPS".
        const tracked = new Set();
        for (const v of vehicles.values()) if (v.tripId) { const d = ST.sim.dutyOfTrip(v.tripId, ctx.ms); if (d) tracked.add(d.name); }
        const extra = ST.sim.vehiclesAt(ctx.ms).filter(v => !tracked.has(v.name) && !OUT_OF_SERVICE.has(v.status) && v.status !== "terminating");
        extra.forEach(v => { v.untracked = true; });
        lastSim = new Map(extra.map(v => [v.id, v]));
        list = [...vehicles.values(), ...extra];
      }
      if (sim && list) { lastSim = new Map(list.map(v => [v.id, v])); for (const v of lastSim.values()) v.untracked = false; }
      if (list) {
        for (const v of list) {
          const ghost = !!v.untracked && realtime;
          if (!sim && !ghost && !v.fixes.length) continue;
          const age = sim || ghost ? 0 : (feedTime - v.fixes.at(-1).t) / 1000;
          const service = sim || ghost ? !OUT_OF_SERVICE.has(v.status) : age < STALE;
          if (service && !ghost) counts[v.kind] = (counts[v.kind] || 0) + 1;
          if (!ST.routeVisible(v.routeId, v.kind) && v.id !== selectedId) continue;
          // Vehicles parked in a depot are only drawn when zoomed in on it.
          if (sim && v.status === "depot" && ctx.zoom < 16 && v.id !== selectedId) continue;
          let estimated = false;
          if (!sim && !ghost) {
            if (age >= STALE && (estimated = estimate(v, now))) { /* position from forecast */ }
            else if (age >= LOST) continue;
            else displayState(v, now);
          }
          let m = markers.get(v.id);
          if (ctx.dots && v.id !== selectedId) {
            if (m) { hideBody(m); map.removeLayer(m.marker); markers.delete(v.id); }
            if (ctx.view.contains(v.ll)) ctx.dot(v.ll, ROUTES[v.routeId] ? ROUTES[v.routeId].color : "#6c757d", () => openVehicle(v.id),
              ghost || (age >= STALE && !estimated) ? 2.4 : undefined);
            continue;
          }
          if (!ctx.view.contains(v.ll) && v.id !== selectedId) {
            if (m) { hideBody(m); map.removeLayer(m.marker); markers.delete(v.id); }
            continue;
          }
          seen.add(v.id);
          if (!m || m.routeId !== v.routeId) {
            if (m) { hideBody(m); map.removeLayer(m.marker); }
            const marker = L.marker(v.ll, { icon: vehIcon(v), pane: "vehicles", keyboard: false }).addTo(map);
            marker.on("click", () => openVehicle(v.id));
            m = { marker, routeId: v.routeId };
            markers.set(v.id, m);
          }
          const withBody = ctx.bodies && v.onShape && (age < STALE || estimated) && !v.untracked;
          if (withBody) bodies.push({ v, m, front: v.sDisp + FRONT, len: bodyLength(v) });
          else { hideBody(m); m.marker.setLatLng(v.ll); }
          const el = m.marker.getElement();
          if (el) {
            if (!m.dirEl) { m.dirEl = el.querySelector(".dir"); m.vehEl = el.querySelector(".veh"); }
            m.dirEl.style.transform = `rotate(${v.brg || 0}deg)`;
            const state = v.untracked ? "untracked " : sim ? (v.status === "depot" ? "parked " : service ? "" : "nonservice ")
              : estimated ? "estimated " : age >= STALE ? "stale " : "";
            const cls = `${state}${withBody ? "has-body " : ""}${v.id === selectedId ? "selected" : ""}`;
            if (cls !== m.cls) { m.vehEl.className = `veh k-${v.kind} ${cls}`; m.cls = cls; }
          }
        }
        separateQueues(bodies);
        for (const b of bodies) b.m.marker.setLatLng(drawBody(b.m, b.v, b.front, ctx.mpp));
      }
      for (const [id, m] of markers) {
        if (!seen.has(id)) { hideBody(m); map.removeLayer(m.marker); markers.delete(id); }
      }
      if (ctx.slow) { updateFeedState(); updateDepots(ctx); }
    },
  });

  ST.addCounts(() => ["tram", "trolley", "bus", "night"].map(k => ({ icon: ST.kindIcon(k, 20), label: t("kinds_" + k), n: counts[k] || 0 })));

  // ---------- Route highlight ----------
  const routeLayer = L.layerGroup().addTo(map);
  let highlighted = "";
  function highlight(shapeIds, color) {
    const key = shapeIds.join(",") + color + ST.dark;
    if (key === highlighted) return;
    highlighted = key;
    routeLayer.clearLayers();
    for (const id of shapeIds) {
      const sh = shape(id);
      if (!sh) continue;
      L.polyline(sh.pts, { pane: "routes", color: ST.dark ? "#000" : "#fff", weight: 9, opacity: 0.9, interactive: false }).addTo(routeLayer);
      L.polyline(sh.pts, { pane: "routes", color, weight: 5, opacity: 0.95, interactive: false }).addTo(routeLayer);
      const p = PATTERNS[id];
      for (const si of p.s) {
        const s = STOPS[si];
        L.circleMarker([s.lat, s.lon], { pane: "routes", radius: 4, weight: 2, color, fillColor: "#fff", fillOpacity: 1 })
          .on("click", () => openStop(s.id)).addTo(routeLayer);
      }
    }
  }
  function clearHighlight() { routeLayer.clearLayers(); highlighted = ""; }
  ST.on("cardclose", () => { clearHighlight(); selectedId = null; ST.invalidate(); });

  // ---------- Cards ----------
  const occText = o => o == null || o > 6 ? null : t("occ_" + o);
  function modelFacts(v) {
    const m = v.model;
    let html = fact(t("fleetNo"), esc(v.id.replace(/^\D+/, "")));
    if (!m) return html + fact(t("model"), t("unknownModel"));
    html += fact(t("model"), esc(m.model) + (m.years ? ` <span class="muted">(${esc(m.years)})</span>` : ""));
    const total = m.length_m || sectionsFor(v).reduce((a, b) => a + b, 0);
    if (total) html += fact(t("length"), `${(+total).toFixed(1)} m${m.coupled > 1 ? ` × ${m.coupled}` : ""}${sectionsFor(v).length > 1 ? ` · ${sectionsFor(v).length} ${ST.lang === "bg" ? "секции" : "sections"}` : ""}`);
    if (m.low_floor != null) html += fact(t("lowFloor"), m.low_floor === "partial" ? t("partialLowFloor") : m.low_floor ? t("yes") : t("no"));
    if (m.ac != null) html += fact(t("ac"), m.ac ? t("yes") : t("no"));
    return html;
  }

  function simCard(id) {
    const v = lastSim && lastSim.get(id);
    if (!v) return null;
    const r = ROUTES[v.routeId], sp = v.simPattern, run = v.runIdx != null ? v.runs[v.runIdx] : null;
    const toTime = s => ST.hhmmEpoch(ST.clock.now() - (v.sec - s) * 1000);
    let html = `<div class="card-head">${r ? chip(v.routeId) : ""}<div><div class="card-title">${sp && !OUT_OF_SERVICE.has(v.status) ? `${t("toward")} ${esc(placeName(sp.head))}` : t("st_" + v.status)}</div>` +
      `<div class="card-sub">${t("kind_" + v.kind)} · ${t("simulated")} · ${t("duty")} ${esc(v.duty)}</div></div></div><div class="facts">`;
    html += fact(t("state"), t("st_" + v.status));
    let next = -1;
    if (run && v.leg.i != null) next = v.leg.type === "shape" ? v.leg.i : v.leg.i;
    if (run && next >= 0 && next < run.p.stops.length && !OUT_OF_SERVICE.has(v.status)) {
      const st = STOPS[run.p.stops[next]];
      const delay = run.times[next] - (run.start + run.p.t[next]);
      html += fact(t("nextStop"), `${st ? esc(stopName(st)) : ""} · ${toTime(run.times[next])}`);
      html += fact(t("delay"), Math.abs(delay) < 60 ? t("onTime") : delay > 0 ? t("late", { m: Math.round(delay / 60) }) : t("early", { m: Math.round(-delay / 60) }));
    }
    if (v.speed) html += fact(t("speed"), `${Math.round(v.speed)} ${t("kmh")}`);
    html += `</div><p class="small muted">${v.untracked ? t("untrackedNote") + " " : ""}${t("simNote", { src: esc(ST.sim.label || "") })}</p>`;
    if (r) html += `<div class="card-actions"><button class="btn" data-action="live-line" data-line="${v.routeId}">${t("line")} ${esc(r.name)}</button></div>`;
    if (run) {
      html += `<h4>${t("stopsOnRoute")}</h4><ol class="stoplist">`;
      run.p.stops.forEach((si, i) => {
        const st = STOPS[si];
        if (!st) return;
        const cls = next < 0 ? "" : i < next ? "past" : i === next ? "current" : "";
        html += `<li class="${cls}"><span class="dot"></span><a href="#" class="grow" data-action="live-stop" data-id="${st.id}">${esc(stopName(st))}</a><span class="t">${toTime(run.times[i])}</span></li>`;
      });
      html += `</ol>`;
    }
    return html;
  }

  function vehicleCard(id) {
    if (id.startsWith("sim:")) return simCard(id);
    const v = vehicles.get(id);
    if (!v) return null;
    const r = ROUTES[v.routeId], p = v.pattern;
    const age = Math.max(0, Math.round((Date.now() - v.fixes.at(-1).t) / 1000));
    let html = `<div class="card-head">${r ? chip(v.routeId) : ""}<div><div class="card-title">${p ? `${t("toward")} ${esc(placeName(p.h))}` : esc(v.routeId)}</div>` +
      `<div class="card-sub">${t("kind_" + v.kind)} · ${esc(v.id.replace(/^\D+/, ""))} · ${t("lastUpdate", { s: age })}</div></div></div>`;
    if (age >= STALE) html += `<p class="small warn-note">${t("gpsLost", { m: Math.round(age / 60) })}</p>`;
    html += `<div class="facts">`;
    const tu = tripUpdates && tripUpdates.byTrip.get(v.tripId);
    // Next stop from the snapped position along the pattern.
    let nextIdx = -1;
    if (p && v.sDisp != null) nextIdx = p.d.findIndex(d => d > v.sDisp - 15);
    if (nextIdx >= 0) {
      const st = STOPS[p.s[nextIdx]];
      const pred = tu && tu.stops.find(x => x.stopId === st.id);
      html += fact(t("nextStop"), `${esc(stopName(st))}${pred && pred.time ? ` · ${minsText((pred.time - Date.now()) / 1000)}` : ""}`);
    }
    if (v.speed != null) html += fact(t("speed"), `${Math.round(v.speed)} ${t("kmh")}`);
    const delay = tu && (tu.delay ?? tu.stops.find(x => x.delay)?.delay);
    if (delay) html += fact(t("delay"), Math.abs(delay) < 60 ? t("onTime") : delay > 0 ? t("late", { m: Math.round(delay / 60) }) : t("early", { m: Math.round(-delay / 60) }));
    const occ = occText(v.occupancy);
    if (occ) html += fact(t("occupancy"), `<span class="occ occ-${v.occupancy}"></span>${occ}`);
    html += modelFacts(v) + `</div>`;
    const num = v.id.replace(/^\D+/, "");
    const issue = "https://github.com/jukfiuune/sofia-metro/issues/new?" + new URLSearchParams({
      title: `Wrong model: ${t("kind_" + v.kindBase)} ${num}`,
      body: `Vehicle ${v.id} (line ${r ? r.name : v.routeId}) is shown as: ${v.model ? v.model.model : "unknown"}\n\nActual model / how you know:\n`,
    });
    html += `<p class="small muted report">${t("wrongModel")} <a href="${issue}" target="_blank" rel="noopener">${t("reportIt")}</a></p>`;
    if (r) html += `<div class="card-actions"><button class="btn" data-action="live-line" data-line="${v.routeId}">${t("line")} ${esc(r.name)}</button></div>`;
    // Forecast from the simulation: remaining stops where official predictions are
    // missing (marked ≈), and the vehicle's next trips.
    const fc = forecastOf(v);
    const fcRun = fc && fc.runIdx != null ? fc.runs[fc.runIdx] : null;
    const fcClock = s => Date.now() - (fc.sec - s) * 1000;
    if (fc) {
      const nextRuns = fc.runs.slice(fc.runIdx + 1).filter(r => r.times && r.times[0] != null).slice(0, 3);
      if (nextRuns.length) {
        html += `<h4>${t("nextTrips")}</h4><div class="rows">`;
        for (const r of nextRuns) {
          const late = r.times[0] - r.start;
          html += `<div class="row-item">${ROUTES[r.p.route] ? chip(r.p.route) : ""}<span class="grow">${t("toward")} ${esc(placeName(r.p.head))}</span>` +
            `<span class="t">≈ ${ST.hhmmEpoch(fcClock(r.times[0]))}${late >= 60 ? ` <span class="muted small">+${Math.round(late / 60)}</span>` : ""}</span></div>`;
        }
        html += `</div>`;
      }
    }
    if (p) {
      html += `<h4>${t("stopsOnRoute")}</h4><ol class="stoplist">`;
      p.s.forEach((si, i) => {
        const st = STOPS[si];
        const cls = nextIdx < 0 ? "" : i < nextIdx ? "past" : i === nextIdx ? "current" : "";
        const pred = tu && tu.stops.find(x => x.stopId === st.id);
        const fcT = fcRun && fcRun.times[i] != null ? fcClock(fcRun.times[i]) : null;
        const time = i < nextIdx ? "" : pred && pred.time ? ST.hhmmEpoch(pred.time) : fcT ? `≈ ${ST.hhmmEpoch(fcT)}` : "";
        html += `<li class="${cls}"><span class="dot"></span><a href="#" class="grow" data-action="live-stop" data-id="${st.id}">${esc(stopName(st))}</a><span class="t">${time}</span></li>`;
      });
      html += `</ol>`;
    }
    return html;
  }

  function openVehicle(id) {
    const sim = id.startsWith("sim:");
    const v = sim ? lastSim && lastSim.get(id) : vehicles.get(id);
    if (!v) return;
    selectedId = id;
    if (!sim) fetchTripUpdates(true);
    ST.openCard({
      id: "veh:" + id,
      render: () => { if (!sim) fetchTripUpdates(); return vehicleCard(id); },
      after: () => { if (v.pattern && ROUTES[v.routeId]) highlight([v.shapeId], ROUTES[v.routeId].color); },
      onClose: () => { selectedId = null; clearHighlight(); },
    });
    ST.invalidate();
  }

  function stopCard(id) {
    const s = stopById.get(id);
    if (!s) return null;
    let html = `<div class="card-head"><span class="kind-badge">${ST.kindIcon(baseKind(s.routes[0]) || "bus", 22)}</span><div><div class="card-title">${esc(stopName(s))}</div>` +
      `<div class="card-sub">${t("stop")} ${esc(s.code)}</div></div></div>`;
    html += `<div class="chips-row">${s.routes.slice().sort((a, b) => routeIds.indexOf(a) - routeIds.indexOf(b)).map(r =>
      `<a href="#" data-action="live-line" data-line="${r}">${chip(r)}</a>`).join("")}</div>`;
    html += `<h4>${t("departures")}</h4>`;
    if (!ST.clock.isRealtime()) {
      // Simulated time: departures predicted by the simulation.
      if (!ST.sim) return html + `<p class="muted">…</p>`;
      const list = ST.sim.departures(stopIndex.get(id), ST.clock.now()).slice(0, 25);
      if (!list.length) return html + `<p class="muted">${t("noDepartures")}</p>`;
      const now = ST.clock.now();
      html += `<div class="rows">`;
      for (const x of list) {
        const late = x.delay >= 60 ? ` <span class="muted small">+${Math.round(x.delay / 60)}</span>` : "";
        html += `<div class="row-item" data-action="live-veh" data-id="${x.v.id}">${ROUTES[x.route] ? chip(x.route) : ""}` +
          `<span class="grow">${esc(placeName(x.head))}</span><span class="t">${minsText((x.time - now) / 1000)}${late}</span></div>`;
      }
      return html + `</div><p class="small muted">${t("simNote", { src: esc(ST.sim.label || "") })}</p>`;
    }
    if (!tripUpdates) return html + `<p class="muted">…</p>`;
    const now = Date.now();
    const list = (tripUpdates.byStop.get(id) || []).filter(x => x.st.time > now - 30000 && x.st.time < now + 3600000)
      .sort((a, b) => a.st.time - b.st.time).slice(0, 25);
    // Forecast rows for duties the official predictions don't cover (yet).
    const fcRows = [];
    if (ST.sim) {
      const covered = new Set(list.map(({ rec }) => `${rec.routeId}|${rec.shapeId}|${Math.round(rec.stops.find(x => x.stopId === id).time / 600000)}`));
      for (const x of ST.sim.departures(stopIndex.get(id), now)) {
        const key = `${x.route}|${x.v.runs[0].p.shape}`;
        void key;
        const bucket = Math.round(x.time / 600000);
        const dup = [...covered].some(c => c.startsWith(`${x.route}|`) && Math.abs(+c.split("|")[2] - bucket) <= 1);
        if (!dup) fcRows.push(x);
      }
    }
    if (!list.length && !fcRows.length) return html + `<p class="muted">${t("noDepartures")}</p>`;
    const byTrip = new Map([...vehicles.values()].map(v => [v.tripId, v]));
    html += `<div class="rows">`;
    for (const { rec, st } of list) {
      const p = PATTERNS[rec.shapeId];
      const veh = byTrip.get(rec.tripId);
      const last = p && STOPS[p.s.at(-1)].id === id;
      if (last) continue;
      html += `<div class="row-item${veh ? " live" : ""}"${veh ? ` data-action="live-veh" data-id="${veh.id}"` : ""}>${ROUTES[rec.routeId] ? chip(rec.routeId) : esc(rec.routeId)}` +
        `<span class="grow">${p ? esc(placeName(p.h)) : ""}</span>` +
        `<span class="t">${minsText((st.time - now) / 1000)}${veh ? ' <span class="rt" title="' + t("realtime") + '"></span>' : ""}</span></div>`;
    }
    for (const x of fcRows.slice(0, Math.max(0, 25 - list.length))) {
      html += `<div class="row-item forecast">${ROUTES[x.route] ? chip(x.route) : ""}<span class="grow">${esc(placeName(x.head))}</span>` +
        `<span class="t">≈ ${minsText((x.time - now) / 1000)}</span></div>`;
    }
    if (fcRows.length) html += `<p class="small muted">≈ ${t("forecastNote")}</p>`;
    return html + `</div>`;
  }
  function openStop(id) {
    const s = stopById.get(id);
    fetchTripUpdates(true);
    ST.openCard({ id: "stop:" + id, render: () => { fetchTripUpdates(); return stopCard(id); }, onClose: clearHighlight });
    if (s) ST.focus([s.lat, s.lon]);
  }

  function lineDirections(r) {
    const own = Object.entries(PATTERNS).filter(([, p]) => p.r === r);
    const best = new Map();
    for (const [sid, p] of own) if (!best.has(p.h) || p.s.length > best.get(p.h)[1].s.length) best.set(p.h, [sid, p]);
    return [...best.values()];
  }
  function lineCard(r) {
    const route = ROUTES[r];
    const dirs = lineDirections(r);
    const n = [...vehicles.values()].filter(v => v.routeId === r).length;
    let html = `<div class="card-head">${chip(r)}<div><div class="card-title">${t("kind_" + kindOf(r))} ${esc(route.name)}</div>` +
      `<div class="card-sub">${t("vehiclesOnLine", { n })}</div></div></div>`;
    const only = ST.filters.lines.size === 1 && ST.filters.lines.has(r);
    html += `<div class="card-actions"><button class="btn" data-action="only-line" data-line="${r}">${only ? t("showAllLines") : t("showLineOnly")}</button></div>`;
    for (const [, p] of dirs) {
      html += `<details><summary>${t("toward")} ${esc(placeName(p.h))} <span class="muted">· ${p.s.length}</span></summary><ol class="stoplist compact">` +
        p.s.map(si => `<li><span class="dot"></span><a href="#" class="grow" data-action="live-stop" data-id="${STOPS[si].id}">${esc(stopName(STOPS[si]))}</a></li>`).join("") + `</ol></details>`;
    }
    return html;
  }
  function openLine(r) {
    const dirs = lineDirections(r);
    ST.openCard({
      id: "line:" + r, render: () => lineCard(r),
      after: () => highlight(dirs.map(([sid]) => sid), ROUTES[r].color),
      onClose: clearHighlight,
    });
    const b = L.latLngBounds([]);
    for (const [sid] of dirs) { const sh = shape(sid); if (sh) sh.pts.forEach(p => b.extend(p)); }
    if (b.isValid()) map.fitBounds(b, { padding: [40, 40], maxZoom: 15 });
  }

  ST.on("action", (action, data) => {
    if (action === "live-stop") openStop(data.id);
    else if (action === "live-line") openLine(data.line);
    else if (action === "live-veh") {
      const v = data.id.startsWith("sim:") ? lastSim && lastSim.get(data.id) : vehicles.get(data.id);
      if (v) { openVehicle(data.id); ST.focus(v.ll || [v.fixes.at(-1).lat, v.fixes.at(-1).lon]); }
    }
  });

  // ---------- Stops layer ----------
  const stopRenderer = L.canvas({ pane: "stops", padding: 0.3 });
  const stopLayer = L.layerGroup();
  const STOP_ZOOM = 15.5;
  function drawStops() {
    stopLayer.clearLayers();
    for (const s of STOPS) {
      const k = s.routes.length ? baseKind(s.routes[0]) : "bus";
      L.circleMarker([s.lat, s.lon], {
        renderer: stopRenderer, radius: 4.5, weight: 2, color: ST.KIND_COLORS[k], fillColor: ST.dark ? "#16191e" : "#fff", fillOpacity: 1,
      }).on("click", () => openStop(s.id)).bindTooltip(() => esc(stopName(s)), { direction: "top", offset: [0, -4] }).addTo(stopLayer);
    }
  }
  function updateStops() {
    const show = ST.display.stops && map.getZoom() >= STOP_ZOOM;
    if (show && !map.hasLayer(stopLayer)) stopLayer.addTo(map);
    if (!show && map.hasLayer(stopLayer)) map.removeLayer(stopLayer);
  }
  map.on("zoomend", updateStops);
  ST.on("stops", updateStops);
  ST.on("theme", () => { drawStops(); highlighted = ""; ST.renderCard(true); });
  drawStops();
  updateStops();

  // ---------- Search ----------
  ST.addSearch((q) => {
    const out = [];
    const qLine = q.replace(/^(трамвай|тролейбус|автобус|tram|trolleybus|trolley|bus|тм|тб|tm|tb|a|а)\s*/i, "").trim();
    const kindWord = /^(трамвай|tram|тм|tm)/.test(q) ? "tram" : /^(тролейбус|trolley|тб|tb)/.test(q) ? "trolley" : /^(автобус|bus)/.test(q) ? "bus" : null;
    for (const r of routeIds) {
      const name = ST.norm(ROUTES[r].name);
      if (kindWord && baseKind(r) !== kindWord) continue;
      if (name === qLine || (qLine.length >= 1 && name.startsWith(qLine))) {
        const dirs = lineDirections(r).map(([, p]) => placeName(p.h));
        out.push({ score: name === qLine ? 95 : 70, icon: chip(r), label: `${t("kind_" + kindOf(r))} ${esc(ROUTES[r].name)}`,
          sub: esc(dirs.slice(0, 2).join(" ⇄ ")), action: () => openLine(r) });
      }
    }
    if (/^\d{3,4}$/.test(q)) {
      for (const v of vehicles.values()) {
        if (v.id.replace(/^\D+/, "") === q || (q.length === 4 && v.id.endsWith(q))) {
          out.push({ score: 98, icon: ST.kindIcon(v.kindBase, 22), label: `${t("kind_" + v.kindBase)} ${esc(v.id.replace(/^\D+/, ""))}`,
            sub: ROUTES[v.routeId] ? `${chip(v.routeId)} ${t("toward")} ${v.pattern ? esc(placeName(v.pattern.h)) : ""}` : "",
            action: () => { openVehicle(v.id); ST.focus(v.ll || [v.fixes.at(-1).lat, v.fixes.at(-1).lon], 16); } });
        }
      }
      for (const s of STOPS) if (s.code === q.padStart(4, "0")) out.push({ score: 90, icon: ST.kindIcon(baseKind(s.routes[0]) || "bus", 22),
        label: esc(stopName(s)), sub: `${t("stop")} ${s.code}`, action: () => { openStop(s.id); ST.focus([s.lat, s.lon], 16.5); } });
    }
    if (q.length >= 2 && !/^\d+$/.test(q)) {
      const seenNames = new Map();
      for (const s of STOPS) {
        const m = Math.max(ST.matchScore(q, s.name), ST.matchScore(q, s.en || ""), ST.matchScore(q, translit(s.name)));
        const sc = [0, 35, 48, 55][m];
        if (!sc) continue;
        const n = seenNames.get(s.name) || 0;
        seenNames.set(s.name, n + 1);
        if (n >= 4) continue;
        out.push({ score: sc, icon: ST.kindIcon(baseKind(s.routes[0]) || "bus", 22), label: esc(stopName(s)),
          sub: `${t("stop")} ${s.code} · ${s.routes.slice(0, 6).map(chip).join(" ")}`,
          action: () => { openStop(s.id); ST.focus([s.lat, s.lon], 16.5); } });
      }
    }
    return out;
  });

  // Shared with the simulation (js/sim.js).
  ST.transit = { ROUTES, STOPS, PATTERNS, shape, along, kindOf };

  window.liveDebug = { vehicles, shape, project, PATTERNS, fetchTripUpdates, get tripUpdates() { return tripUpdates; } };
})();
