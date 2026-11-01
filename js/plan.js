/* Trip planner: door-to-door trips by foot, bus, tram, trolleybus and metro.
 *
 * Walking uses the pedestrian network from OpenStreetMap (data/walk.js, built by
 * tools/build_walk.py): main roads have two sides and are crossed at lights and
 * crossings, or anywhere if jaywalking is allowed. Vehicle times are the
 * simulation's predictions (learned travel times; live vehicles carry on from where
 * they are now) and the metro timetable. Trips are found with the connection scan
 * algorithm; a trip can also be played on the map with the simulation clock.
 */
(function () {
  "use strict";

  const t = ST.t, map = ST.map;
  const WALK = 1.3, RUN = 2.8;                  // m/s
  const BOARD = 30;                             // s at the stop before the vehicle arrives
  const STATION = 120;                          // s from the street to a metro platform
  const ACCESS = 1200;                          // s of walking to or from the first and last stop at most
  const TRANSFER = 480;                         // s of walking between two stops at most
  const HORIZON = 3 * 3600;
  const MAX_RUN = 400;                          // m of running at most in one walk
  const LAT0 = 42.69, LON0 = 23.32, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 111320;
  const xy = ll => [(ll[1] - LON0) * KX, (ll[0] - LAT0) * KY];
  const ll = (x, y) => [LAT0 + y / KY, LON0 + x / KX];


  // ---------- Panel ----------
  const rail = document.getElementById("rail");
  const btn = document.createElement("button");
  btn.className = "rail-btn"; btn.dataset.panel = "plan"; btn.dataset.i18nTitle = "plan";
  btn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/></svg>';
  rail.insertBefore(btn, rail.children[1]);
  btn.addEventListener("click", () => ST.showPanel(document.getElementById("panel-plan").hidden ? "plan" : null));
  const panel = document.createElement("section");
  panel.className = "panel"; panel.id = "panel-plan"; panel.hidden = true;
  panel.innerHTML = `
    <div class="panel-head"><h2 data-i18n="plan"></h2><button class="icon-btn panel-close" aria-label="Close">✕</button></div>
    <div class="panel-body" id="plan-body">
      <div id="plan-form">
        <div class="plan-ends">
          <div class="plan-end"><span class="pin a">A</span><input type="search" id="plan-from" autocomplete="off" data-i18n-placeholder="fromPh"></div>
          <div class="plan-end"><span class="pin b">B</span><input type="search" id="plan-to" autocomplete="off" data-i18n-placeholder="toPh"></div>
          <button class="icon-btn" id="plan-swap" data-i18n-title="swap">⇅</button>
        </div>
        <div id="plan-suggest" class="list plan-suggest" hidden></div>
        <div class="seg" id="plan-when"><button data-when="now" data-i18n="leaveNow"></button><button data-when="at" data-i18n="departAt"></button></div>
        <div class="row" id="plan-at-row" hidden><input type="datetime-local" id="plan-at" step="60"></div>
        <label class="check"><input type="checkbox" id="plan-run"> <span data-i18n="allowRun"></span></label>
        <label class="check"><input type="checkbox" id="plan-jay"> <span data-i18n="allowJaywalk"></span></label>
        <p class="hint" id="plan-jay-note" data-i18n="jaywalkNote" hidden></p>
        <button class="btn primary plan-go" id="plan-go" data-i18n="findTrips"></button>
      </div>
      <div id="plan-results"></div>
    </div>`;
  document.body.insertBefore(panel, document.getElementById("card"));
  ST.addStrings({
    plan: ["Маршрут", "Directions"], from: ["От", "From"], to: ["До", "To"],
    fromPh: ["Начална точка", "Start"], toPh: ["Крайна точка", "Destination"],
    myLocation: ["Моето местоположение", "My location"], pickOnMap: ["Посочи на картата", "Pick on the map"],
    pickHint: ["Докоснете картата, за да изберете точка", "Tap the map to choose a point"],
    mapPoint: ["Точка на картата", "Point on the map"], swap: ["Размени", "Swap"],
    leaveNow: ["Тръгване сега", "Leave now"], departAt: ["Тръгване в", "Depart at"],
    allowRun: ["Мога да тичам", "I can run"], allowJaywalk: ["Пресичане на неразрешени места", "Cross anywhere (jaywalking)"],
    jaywalkNote: ["Пресичането извън пешеходните пътеки е забранено и опасно.", "Crossing away from crossings is against the rules and dangerous."],
    findTrips: ["Намери маршрут", "Find trips"], planning: ["Търсене…", "Searching…"],
    planLoading: ["Зареждане на пешеходната мрежа…", "Loading the walking network…"],
    noTrips: ["Не е намерен маршрут", "No trip found"], walkOnly: ["Пеша", "On foot"],
    walkMin: ["{m} мин пеша", "{m} min walk"], walkTo: ["Пеша до {p}", "Walk to {p}"],
    runTo: ["Тичане до {p}", "Run to {p}"], runPart: ["тичайте последните {d} м", "run the last {d} m"],
    needsRun: ["Изисква тичане", "Needs running"], hasJaywalk: ["Пресичане извън пътека", "Jaywalking"],
    rideTo: ["до {p}", "to {p}"], stopsN: ["{n} спирки", "{n} stops"], waitN: ["изчакване {m} мин", "wait {m} min"],
    transfersN: ["{n} прекачвания", "{n} transfers"], transfer1: ["1 прекачване", "1 transfer"], noTransfer: ["без прекачване", "no transfers"],
    arrive: ["Пристигане", "Arrive"], back: ["Назад", "Back"], simulate: ["Симулирай пътуването", "Simulate the trip"],
    stopSim: ["Спри симулацията", "Stop simulation"], destination: ["Пристигане", "Arrive"],
    crossings: ["пресичания: {n}", "crossings: {n}"], predicted: ["по прогноза", "predicted"],
    youAreHere: ["Вие", "You"],
    changeTo: ["Прекачване на {l} — {p}", "Change to {l} at {p}"], throughStation: ["през станцията", "inside the station"],
    missed: ["Превозното средство е изпуснато — търся нов маршрут", "Missed the vehicle — finding a new trip"],
    newTrip: ["Нов маршрут", "New trip"],
  });
  panel.querySelector(".panel-close").addEventListener("click", () => ST.showPanel(null));
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  const opts = { run: ST.store.get("plan.run", false), jay: ST.store.get("plan.jay", false), when: "now" };
  $("plan-run").checked = opts.run; $("plan-jay").checked = opts.jay; $("plan-jay-note").hidden = !opts.jay;
  $("plan-run").addEventListener("change", e => { opts.run = e.target.checked; ST.store.set("plan.run", opts.run); });
  $("plan-jay").addEventListener("change", e => { opts.jay = e.target.checked; ST.store.set("plan.jay", opts.jay); $("plan-jay-note").hidden = !opts.jay; });
  function setWhen(w) {
    opts.when = w;
    document.querySelectorAll("#plan-when button").forEach(b => b.classList.toggle("active", b.dataset.when === w));
    $("plan-at-row").hidden = w !== "at";
    if (w === "at" && !$("plan-at").value) {
      const p = ST.sofiaParts(ST.clock.now());
      $("plan-at").value = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    }
  }
  $("plan-when").addEventListener("click", e => { const b = e.target.closest("[data-when]"); if (b) setWhen(b.dataset.when); });
  setWhen("now");

  // ---------- Places ----------
  const ends = { a: null, b: null };            // {ll, label, stop?}
  const pins = {};
  let picking = null, activeInput = null;
  function setEnd(which, place) {
    ends[which] = place;
    $(which === "a" ? "plan-from" : "plan-to").value = place ? place.label : "";
    if (pins[which]) { map.removeLayer(pins[which]); pins[which] = null; }
    if (place) {
      pins[which] = L.marker(place.ll, {
        pane: "selected", draggable: true,
        icon: L.divIcon({ className: "plan-pin", html: `<span class="pin ${which}">${which.toUpperCase()}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      }).addTo(map);
      pins[which].on("dragend", () => {
        const p = pins[which].getLatLng();
        ends[which] = { ll: [p.lat, p.lng], label: t("mapPoint") };
        $(which === "a" ? "plan-from" : "plan-to").value = ends[which].label;
        if (results) search();
      });
    }
  }
  $("plan-swap").addEventListener("click", () => { const a = ends.a, b = ends.b; setEnd("a", b); setEnd("b", a); if (results) search(); });
  map.on("click", e => {
    if (!picking) return;
    setEnd(picking, { ll: [e.latlng.lat, e.latlng.lng], label: t("mapPoint") });
    picking = null;
    document.body.classList.remove("plan-picking");
    ST.toast(null);
    ST.showPanel("plan");
  });

  function placeResults(q) {
    const out = [];
    out.push({ label: t("myLocation"), icon: "◎", act: w => locate(w) });
    out.push({ label: t("pickOnMap"), icon: "⌖", act: w => { picking = w; document.body.classList.add("plan-picking"); ST.toast(t("pickHint")); if (window.matchMedia("(max-width: 700px)").matches) ST.showPanel(null); } });
    if (q.length < 2) return out;
    const X = ST.transit, seen = new Map();
    for (const st of metroStations()) {
      const sc = ST.matchScore(q, st.name) || ST.matchScore(q, st.en || "");
      if (sc) out.push({ score: sc + 1, label: st.label, sub: t("station"), icon: ST.kindIcon("metro", 20), place: { ll: st.ll, label: st.label } });
    }
    X.STOPS.forEach((s, i) => {
      const sc = ST.matchScore(q, s.name) || ST.matchScore(q, s.en || "") || (s.code === q.padStart(4, "0") ? 3 : 0);
      if (!sc) return;
      const name = X.stopName(s);
      const prev = seen.get(name);
      if (prev) { prev.sub += `, ${s.code}`; return; }
      const r = { score: sc, label: name, sub: `${t("stop")} ${s.code}`, icon: ST.kindIcon(X.kindOf(s.routes[0]) === "night" ? "bus" : (X.ROUTES[s.routes[0]] || {}).kind || "bus", 20), place: { ll: [s.lat, s.lon], label: name } };
      seen.set(name, r);
      out.push(r);
    });
    return out.slice(0, 2).concat(out.slice(2).sort((a, b) => b.score - a.score).slice(0, 25));
  }
  let suggestions = [];
  function suggest(which) {
    activeInput = which;
    const q = ST.norm($(which === "a" ? "plan-from" : "plan-to").value);
    suggestions = placeResults(q);
    const el = $("plan-suggest");
    el.hidden = false;
    el.innerHTML = suggestions.map((r, i) => `<button class="result" data-i="${i}"><span class="plan-sicon">${r.icon || ""}</span><span class="result-text"><span class="result-label">${esc(r.label)}</span>${r.sub ? `<span class="result-sub">${esc(r.sub)}</span>` : ""}</span></button>`).join("");
  }
  for (const w of ["a", "b"]) {
    const inp = $(w === "a" ? "plan-from" : "plan-to");
    inp.addEventListener("focus", () => { inp.select(); suggest(w); });
    inp.addEventListener("input", () => suggest(w));
    inp.addEventListener("keydown", e => { if (e.key === "Enter" && suggestions[2]) choose(2); });
  }
  function choose(i) {
    const r = suggestions[i];
    $("plan-suggest").hidden = true;
    if (r.act) r.act(activeInput);
    else { setEnd(activeInput, r.place); ST.focus(r.place.ll, 15); }
  }
  $("plan-suggest").addEventListener("mousedown", e => e.preventDefault());
  $("plan-suggest").addEventListener("click", e => { const b = e.target.closest(".result"); if (b) choose(+b.dataset.i); });
  document.addEventListener("click", e => { if (!e.target.closest(".plan-ends, #plan-suggest")) $("plan-suggest").hidden = true; });
  function locate(which) {
    if (!navigator.geolocation) return ST.toast(t("locateFailed"));
    ST.toast(t("locating"));
    navigator.geolocation.getCurrentPosition(pos => {
      setEnd(which, { ll: [pos.coords.latitude, pos.coords.longitude], label: t("myLocation") });
      ST.toast(null);
    }, () => ST.toast(t("locateFailed")), { enableHighAccuracy: true, timeout: 10000 });
  }

  // ---------- Data loading ----------
  const MD = window.METRO_DATA;
  let stations = null;
  function metroStations() {
    if (!stations) stations = Object.entries(MD.stations).map(([id, s]) => ({
      id, name: s.name, en: s.en, ll: s.plat || [s.lat, s.lon],
      get label() { return (ST.lang === "bg" ? ST.transit.placeName(s.name) : s.en) + " (" + t("kind_metro") + ")"; },
    }));
    return stations;
  }
  function addScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.body.appendChild(s);
    });
  }
  let ready = null;
  function load() {
    if (ready) return ready;
    const v = (document.querySelector('script[src*="js/plan.js"]').src.match(/\?v=\d+/) || [""])[0];
    const sim = ST.sim ? Promise.resolve() : new Promise(res => { ST.on("sim", res); ST.transit.loadSim(true); });
    ready = Promise.all([window.WALK_DATA ? null : addScript("data/walk.js" + v), sim]).then(buildWalk);
    ready.catch(() => { ready = null; });
    return ready;
  }

  // ---------- Walking network ----------
  let W = null;
  function buildWalk() {
    if (W) return;
    const D = window.WALK_DATA, F = D.flags;
    const n = D.nodes.length / 2, m = D.edges.length / 5;
    const nx = new Float64Array(n), ny = new Float64Array(n);
    for (let i = 0; i < n; i++) { nx[i] = D.nodes[2 * i]; ny[i] = D.nodes[2 * i + 1]; }
    const ea = new Int32Array(m), eb = new Int32Array(m), elen = new Float64Array(m), ewait = new Float64Array(m), ef = new Int32Array(m);
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) {
      ea[e] = D.edges[5 * e]; eb[e] = D.edges[5 * e + 1]; elen[e] = D.edges[5 * e + 2]; ewait[e] = D.edges[5 * e + 3]; ef[e] = D.edges[5 * e + 4];
      deg[ea[e] + 1]++; deg[eb[e] + 1]++;
    }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const adj = new Int32Array(2 * m), fill = deg.slice(0, n);
    for (let e = 0; e < m; e++) { adj[fill[ea[e]]++] = e; adj[fill[eb[e]]++] = e; }
    // Edge shapes as point lists (x, y), from node a to node b.
    const shapeOf = e => {
      const pts = [[nx[ea[e]], ny[ea[e]]]];
      let x = nx[ea[e]], y = ny[ea[e]];
      for (let k = D.geoStart[e]; k < D.geoStart[e + 1]; k++) { x += D.geo[2 * k]; y += D.geo[2 * k + 1]; pts.push([x, y]); }
      pts.push([nx[eb[e]], ny[eb[e]]]);
      return pts;
    };
    // Grid of edges for snapping points to the network: not crossings, and not road sides
    // without a pavement (often a dual carriageway's median side).
    const CELL = 150, grid = new Map();
    const crossFlags = F.signal | F.marked | F.jaywalk | F.roadside;
    for (let e = 0; e < m; e++) {
      if (ef[e] & crossFlags) continue;
      const pts = shapeOf(e);
      const cells = new Set();
      for (const [x, y] of pts) cells.add(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`);
      for (let k = 1; k < pts.length; k++) {      // long straight segments cross cells in between
        const [x0, y0] = pts[k - 1], [x1, y1] = pts[k], steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL / 2));
        for (let s = 1; s < steps; s++) cells.add(`${Math.floor((x0 + (x1 - x0) * s / steps) / CELL)},${Math.floor((y0 + (y1 - y0) * s / steps) / CELL)}`);
      }
      for (const c of cells) { let a = grid.get(c); if (!a) grid.set(c, a = []); a.push(e); }
    }
    W = { n, m, nx, ny, ea, eb, elen, ewait, ef, adj, deg, shapeOf, grid, CELL, F,
      dist: new Float64Array(n).fill(Infinity), prev: new Int32Array(n).fill(-1), seed: new Int32Array(n), touched: [] };
  }

  /** Nearest point of the walking network: {e, d (m off the network), fa, fb (m along the edge to a / b), pt}. */
  const snapCache = new Map();
  function snap(p) {
    const key = p[0].toFixed(6) + "," + p[1].toFixed(6);
    if (snapCache.has(key)) return snapCache.get(key);
    const [px, py] = xy(p);
    let best = null;
    for (let r = 0; r <= 8 && !best; r++) {
      const cx = Math.floor(px / W.CELL), cy = Math.floor(py / W.CELL);
      const seen = new Set();
      for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++) {
        for (const e of W.grid.get(`${i},${j}`) || []) {
          if (seen.has(e)) continue;
          seen.add(e);
          const pts = W.shapeOf(e);
          let along = 0;
          const total = pts.reduce((s, q, k) => k ? s + Math.hypot(q[0] - pts[k - 1][0], q[1] - pts[k - 1][1]) : 0, 0) || 1;
          for (let k = 1; k < pts.length; k++) {
            const [x0, y0] = pts[k - 1], dx = pts[k][0] - x0, dy = pts[k][1] - y0, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
            const f = L2 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / L2)) : 0;
            const d = Math.hypot(px - x0 - dx * f, py - y0 - dy * f);
            if (!best || d < best.d) {
              const frac = (along + L * f) / total;    // edge cost is shared out by geometric length
              best = { e, d, fa: frac * W.elen[e], fb: (1 - frac) * W.elen[e], pt: [x0 + dx * f, y0 + dy * f] };
            }
            along += L;
          }
        }
      }
    }
    snapCache.set(key, best);
    return best;
  }

  // Binary heap of (cost, node).
  const heap = { k: new Float64Array(1 << 16), v: new Int32Array(1 << 16), n: 0 };
  function hpush(k, v) {
    if (heap.n >= heap.k.length) {
      const k2 = new Float64Array(heap.k.length * 2), v2 = new Int32Array(heap.k.length * 2);
      k2.set(heap.k); v2.set(heap.v); heap.k = k2; heap.v = v2;
    }
    let i = heap.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap.k[p] <= k) break;
      heap.k[i] = heap.k[p]; heap.v[i] = heap.v[p]; i = p;
    }
    heap.k[i] = k; heap.v[i] = v;
  }
  function hpop() {
    const v = heap.v[0], last = --heap.n, k = heap.k[last], lv = heap.v[last];
    let i = 0;
    while (true) {
      let c = 2 * i + 1;
      if (c >= heap.n) break;
      if (c + 1 < heap.n && heap.k[c + 1] < heap.k[c]) c++;
      if (heap.k[c] >= k) break;
      heap.k[i] = heap.k[c]; heap.v[i] = heap.v[c]; i = c;
    }
    heap.k[i] = k; heap.v[i] = lv;
    return v;
  }
  const edgeCost = (e, mode) => W.elen[e] / mode.speed + W.ewait[e];
  const allowed = (e, mode) => mode.jay || !(W.ef[e] & W.F.jaywalk);

  /**
   * Dijkstra from snapped points (a place can have several, like a station's entrances);
   * fills W.dist / W.prev (seconds) up to `limit`, and W.seed: which source a start node came from.
   */
  function walkFrom(sns, mode, limit) {
    for (const i of W.touched) { W.dist[i] = Infinity; W.prev[i] = -1; }
    W.touched = [];
    heap.n = 0;
    const seed = (node, c, k) => { if (c < W.dist[node]) { if (W.dist[node] === Infinity) W.touched.push(node); W.dist[node] = c; W.prev[node] = -2; W.seed[node] = k; hpush(c, node); } };
    sns.forEach((sn, k) => {
      const off = sn.d / mode.speed;
      seed(W.ea[sn.e], off + sn.fa / mode.speed, k);
      seed(W.eb[sn.e], off + sn.fb / mode.speed, k);
    });
    while (heap.n) {
      const kk = heap.k[0], u = hpop();
      if (kk > W.dist[u]) continue;
      if (kk > limit) break;
      for (let k = W.deg[u]; k < W.deg[u + 1]; k++) {
        const e = W.adj[k];
        if (!allowed(e, mode)) continue;
        const v = W.ea[e] === u ? W.eb[e] : W.ea[e];
        const c = kk + edgeCost(e, mode);
        if (c < W.dist[v]) {
          if (W.dist[v] === Infinity) W.touched.push(v);
          W.dist[v] = c; W.prev[v] = e; hpush(c, v);
        }
      }
    }
  }
  /** Walking time (s) from the last walkFrom() sources to a snapped point. */
  function timeTo(sn, mode, srcs) {
    const off = sn.d / mode.speed;
    let best = Math.min(W.dist[W.ea[sn.e]] + sn.fa / mode.speed, W.dist[W.eb[sn.e]] + sn.fb / mode.speed);
    for (const src of srcs) if (src.e === sn.e) best = Math.min(best, (Math.abs(src.fa - sn.fa) + src.d) / mode.speed);
    return best + off;
  }

  /**
   * Walking path between two places, each a list of points (a station has one per entrance):
   * {pts (lat/lon), len (m), time (s at mode speed), cross: {signal, marked, jaywalk}}.
   */
  function walkPath(PA, PB, mode) {
    const A = PA.map(p => [p, snap(p)]).filter(x => x[1]), B = PB.map(p => [p, snap(p)]).filter(x => x[1]);
    const cross = { signal: 0, marked: 0, jaywalk: 0 };
    if (!A.length || !B.length) {
      const [ax, ay] = xy(PA[0]), [bx, by] = xy(PB[0]), len = Math.hypot(ax - bx, ay - by) * 1.3;
      return { pts: [PA[0], PB[0]], len, time: len / mode.speed, cross };
    }
    let far = 0;
    for (const [pa] of A) for (const [pb] of B) { const [ax, ay] = xy(pa), [bx, by] = xy(pb); far = Math.max(far, Math.hypot(ax - bx, ay - by)); }
    const sas = A.map(x => x[1]);
    walkFrom(sas, mode, far * 1.3 * 2.5 / mode.speed + 900);
    // Best end point, and whether it is reached along one edge straight from a start point.
    let best = null;
    for (const [pb, sb] of B) {
      const viaA = W.dist[W.ea[sb.e]] + sb.fa / mode.speed, viaB = W.dist[W.eb[sb.e]] + sb.fb / mode.speed;
      const cand = [[viaA, "a"], [viaB, "b"]];
      A.forEach(([, sa], k) => { if (sa.e === sb.e) cand.push([(Math.abs(sa.fa - sb.fa) + sa.d) / mode.speed, "same", k]); });
      for (const [c, how, k] of cand) {
        const tt = c + sb.d / mode.speed;
        if (!best || tt < best.time) best = { time: tt, how, k, pb, sb };
      }
    }
    const { pb, sb } = best;
    let pts, len = sb.d, pa;
    if (best.how === "same") {
      const sa = A[best.k][1];
      pa = A[best.k][0];
      pts = [ll(...sa.pt), ll(...sb.pt)];
      len += sa.d + Math.abs(sa.fa - sb.fa);
    } else {
      let node = best.how === "a" ? W.ea[sb.e] : W.eb[sb.e];
      len += best.how === "a" ? sb.fa : sb.fb;
      const pe = W.shapeOf(sb.e);
      const tail = W.ea[sb.e] === node ? cut(pe, sb.pt, true) : cut(pe, sb.pt, false).reverse();
      const chain = [];
      while (W.prev[node] >= 0) {
        const e = W.prev[node];
        let sh = W.shapeOf(e);
        if (W.eb[e] !== node) sh = sh.reverse();
        chain.push(sh);
        len += W.elen[e];
        if (W.ef[e] & W.F.signal) cross.signal++;
        if (W.ef[e] & W.F.marked) cross.marked++;
        if (W.ef[e] & W.F.jaywalk) cross.jaywalk++;
        node = W.ea[e] === node ? W.eb[e] : W.ea[e];
      }
      const [pa0, sa] = A[W.seed[node]];
      pa = pa0;
      const ps = W.shapeOf(sa.e);
      const first = W.ea[sa.e] === node ? cut(ps, sa.pt, true).reverse() : cut(ps, sa.pt, false);
      len += sa.d + (W.ea[sa.e] === node ? sa.fa : sa.fb);
      const all = [...first];
      for (let k = chain.length - 1; k >= 0; k--) all.push(...chain[k]);
      all.push(...tail);
      pts = all.map(p => ll(...p));
    }
    return { pts: [pa, ...pts, pb], len, time: best.time, cross };
  }
  /** Part of an edge shape from its start to point p (fromStart) or from p to its end. */
  function cut(pts, p, fromStart) {
    let best = 0, bd = Infinity;
    for (let k = 1; k < pts.length; k++) {
      const [x0, y0] = pts[k - 1], dx = pts[k][0] - x0, dy = pts[k][1] - y0, L2 = dx * dx + dy * dy;
      const f = L2 ? Math.max(0, Math.min(1, ((p[0] - x0) * dx + (p[1] - y0) * dy) / L2)) : 0;
      const d = Math.hypot(p[0] - x0 - dx * f, p[1] - y0 - dy * f);
      if (d < bd) { bd = d; best = k; }
    }
    return fromStart ? [...pts.slice(0, best), p] : [p, ...pts.slice(best)];
  }

  // ---------- Stops ----------
  // Unified stop index: transit stops, then metro stations.
  let STOPS = null, stopGrid = null;
  const SG = 250;
  function stops() {
    if (STOPS) return STOPS;
    const X = ST.transit;
    STOPS = X.STOPS.map((s, i) => ({ i, ll: [s.lat, s.lon], name: () => X.stopName(s), code: s.code, metro: false }));
    // A metro station is reached through any of its entrances (or its platform when none are mapped).
    const ent = (window.WALK_DATA && WALK_DATA.entrances) || {};
    for (const st of metroStations()) STOPS.push({ i: STOPS.length, ll: st.ll, pts: ent[st.id] && ent[st.id].length ? ent[st.id] : [st.ll], name: () => st.label, metro: true, mid: st.id });
    stopGrid = new Map();
    for (const s of STOPS) {
      if (!s.pts) s.pts = [s.ll];
      s.xy = xy(s.ll);
      const c = `${Math.floor(s.xy[0] / SG)},${Math.floor(s.xy[1] / SG)}`;
      let a = stopGrid.get(c); if (!a) stopGrid.set(c, a = []); a.push(s);
    }
    return STOPS;
  }
  const metroIndex = id => stops().find(s => s.mid === id).i;
  /** Stops with a point (entrance) within `radius` m of any of the points P. */
  function stopsNear(P, radius) {
    const out = new Set(), reach = radius + 400;          // station entrances lie up to 400 m from its centre
    for (const p of P) {
      const [x, y] = xy(p), r = Math.ceil(reach / SG), cx = Math.floor(x / SG), cy = Math.floor(y / SG);
      for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++)
        for (const s of stopGrid.get(`${i},${j}`) || [])
          if (Math.hypot(s.xy[0] - x, s.xy[1] - y) <= reach && s.pts.some(q => { const [qx, qy] = xy(q); return Math.hypot(qx - x, qy - y) <= radius; })) out.add(s);
    }
    return [...out];
  }
  /** Walking times from a place (list of points) to the stops around it: [[stop index, seconds]]. */
  function access(P, mode, limit) {
    const sns = P.map(snap).filter(Boolean);
    if (!sns.length) return [];
    walkFrom(sns, mode, limit);
    const out = [];
    for (const s of stopsNear(P, limit * mode.speed / 1.1)) {
      let w = Infinity;
      for (const q of s.pts) { const ss = snap(q); if (ss) w = Math.min(w, timeTo(ss, mode, sns)); }
      if (w <= limit) out.push([s.i, w + (s.metro ? STATION : 0)]);
    }
    return out;
  }
  /**
   * Interchanges: metro stations of different lines within 250 m (Сердика / Сердика 2, НДК / НДК 2,
   * Орлов мост / Софийски университет) are joined by passages inside the station, so changing
   * there takes a minute plus the corridor, without going out to the street and back in.
   */
  const INTERCHANGE = 250;
  function interchange(a, b) {
    const S = stops(), A = S[a], B = S[b];
    if (!A.metro || !B.metro) return null;
    const d = Math.hypot(A.xy[0] - B.xy[0], A.xy[1] - B.xy[1]);
    return d <= INTERCHANGE ? 60 + d * 1.5 / WALK : null;
  }
  const footCache = new Map();
  function footpaths(si, mode) {
    const key = `${mode.speed}|${mode.jay ? 1 : 0}`;
    let c = footCache.get(key);
    if (!c) footCache.set(key, c = new Map());
    if (!c.has(si)) {
      const s = stops()[si];
      // Out of a metro station first (STATION), then walk; access() adds STATION into others.
      const list = access(s.pts, mode, TRANSFER * WALK / mode.speed).filter(([j]) => j !== si).map(([j, w]) => [j, w + (s.metro ? STATION : 0)]);
      if (s.metro) for (const o of stops()) {
        const w = o.metro && o.i !== si ? interchange(si, o.i) : null;
        if (w == null) continue;
        const e = list.find(x => x[0] === o.i);
        if (e) e[1] = Math.min(e[1], w); else list.push([o.i, w]);
      }
      c.set(si, list);
    }
    return c.get(si);
  }

  // ---------- Connections ----------
  // Each connection: from stop, to stop, departure and arrival (s of the service day), trip key, position in trip.
  let conns = null;
  function connections(date, live) {
    const key = date + (live ? "|live" + Math.floor(Date.now() / 30000) : "") + "|" + (ST.metroTrains ? ST.metroTrains.delay : 0);
    if (conns && conns.key === key) return conns;
    const X = ST.transit, day = ST.sim.dutiesFor(date);
    const fc = live ? X.liveForecasts(Date.now()) : null;
    const list = [], trips = [];
    for (const base of day.list) {
      const v = (fc && fc.get(base.name)) || base;
      v.runs.forEach((r, ri) => {
        if (!r.times) return;
        const tk = trips.length;
        trips.push({ kind: "sim", v, ri, route: r.p.route, head: r.p.head, p: r.p, live: v !== base && !!v.live });
        for (let i = 0; i < r.p.stops.length - 1; i++) {
          const a = r.p.stops[i], b = r.p.stops[i + 1];
          if (a < 0 || b < 0 || r.times[i] == null || r.times[i + 1] == null) continue;
          list.push([a, b, r.times[i], r.times[i + 1], tk, i]);
        }
      });
    }
    // Metro, from the timetable.
    const cal = MD.calendars.map(c => new Set(c));
    // Trains run late by the metro delay setting, as they are drawn.
    const late = ST.metroTrains ? ST.metroTrains.delay : 0;
    MD.trips.forEach(([pi, start, ci], id) => {
      if (!cal[ci].has(date)) return;
      const p = MD.patterns[pi], tk = trips.length;
      trips.push({ kind: "metro", id, route: p.route, head: p.headsign, p, start: start + late });
      for (let i = 0; i < p.stops.length - 1; i++)
        list.push([metroIndex(p.stops[i]), metroIndex(p.stops[i + 1]), start + late + p.arr[i] + (p.dw ? p.dw[i] : 0), start + late + p.arr[i + 1], tk, i]);
    });
    list.sort((a, b) => a[2] - b[2]);
    conns = { key, list, trips };
    return conns;
  }

  // ---------- Connection scan ----------
  /**
   * Earliest arrival from point A at second t0 of the service day.
   * `penalty`: extra seconds per change of vehicle (for trips with fewer transfers).
   */
  function scan(C, A, B, t0, mode, penalty, reach = ACCESS) {
    const N = stops().length;
    const arr = new Float64Array(N).fill(Infinity), byVeh = new Float64Array(N).fill(Infinity);
    const how = new Array(N).fill(null);        // best arrival: {veh} or {foot: from stop | -1 for the origin, w, at}
    const howVeh = new Array(N).fill(null);     // best arrival by vehicle: {conn, enter}
    const tripIn = new Map();                     // trip -> connection index boarded
    // Running covers the same distances as walking, only faster.
    const lim = reach * WALK / mode.speed;
    const accA = access([A], mode, lim), accB = new Map(access([B], mode, lim));
    for (const [s, w] of accA) if (t0 + w < arr[s]) { arr[s] = t0 + w; how[s] = { foot: -1, w }; }
    let best = Infinity, end = null;
    const list = C.list;
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid][2] < t0) lo = mid + 1; else hi = mid; }
    for (let k = lo; k < list.length; k++) {
      const c = list[k];
      if (c[2] > best || c[2] > t0 + HORIZON) break;
      const [a, b, dep, at, tk] = c;
      if (!tripIn.has(tk)) {
        const viaVeh = how[a] && how[a].veh;
        const need = BOARD + (viaVeh || (how[a] && how[a].foot >= 0) ? penalty : 0);
        if (arr[a] + need > dep) continue;
        tripIn.set(tk, k);
      }
      if (at < byVeh[b]) {
        byVeh[b] = at;
        howVeh[b] = { conn: k, enter: tripIn.get(tk) };
        if (at < arr[b]) { arr[b] = at; how[b] = { veh: true }; }
        const eg = accB.get(b);
        if (eg != null && at + eg < best) { best = at + eg; end = { s: b, w: eg }; }
        for (const [s2, w] of footpaths(b, mode)) {
          if (at + w < arr[s2]) { arr[s2] = at + w; how[s2] = { foot: b, w, at }; }
          const eg2 = accB.get(s2);
          if (eg2 != null && at + w + eg2 < best) { best = at + w + eg2; end = { s: s2, w: eg2, foot: b, fw: w, at }; }
        }
      }
    }
    if (!end) return null;
    // Walk the chain back. A stop is left by vehicle (howVeh) or reached by any means (how).
    const legs = [];
    let s = end.s;
    legs.push({ type: "walk", from: s, to: "B", t0: best - end.w, t1: best });
    if (end.foot != null) { legs[0] = { type: "walk", from: end.foot, to: "B", t0: end.at, t1: best }; s = end.foot; }
    for (let guard = 0, veh = true; guard < 50; guard++) {
      if (veh) {
        const h = howVeh[s], c = list[h.conn], e = list[h.enter];
        legs.push({ type: "ride", trip: e[4], from: e[0], to: c[1], i0: e[5], i1: c[5] + 1, t0: e[2], t1: c[3] });
        s = e[0];
        veh = false;
        continue;
      }
      const h = how[s];
      if (!h) return null;
      if (h.veh) { veh = true; continue; }
      if (h.foot === -1) { legs.push({ type: "walk", from: "A", to: s, t0: arr[s] - h.w, t1: arr[s] }); break; }
      legs.push({ type: "walk", from: h.foot, to: s, t0: h.at, t1: h.at + h.w });
      s = h.foot;
      veh = true;
    }
    legs.reverse();
    return { legs, arrive: best };
  }

  // ---------- Search ----------
  let results = null, shown = null;
  const resultsEl = $("plan-results");
  $("plan-go").addEventListener("click", () => { stopSim(); search(); });
  async function search(atMs) {
    $("plan-suggest").hidden = true;
    if (!ends.a || !ends.b) { resultsEl.innerHTML = `<div class="empty">${t("noTrips")}</div>`; return; }
    resultsEl.innerHTML = `<div class="empty">${t(W ? "planning" : "planLoading")}</div>`;
    try { await load(); } catch (e) { resultsEl.innerHTML = `<div class="empty">${t("simFailed")}</div>`; return; }
    await new Promise(r => setTimeout(r, 20));
    let ms;
    const live = !atMs && opts.when === "now" && ST.clock.isRealtime();
    if (atMs) ms = atMs;
    else if (opts.when === "now") ms = ST.clock.now();
    else {
      const m = $("plan-at").value.match(/^(\d+)-(\d+)-(\d+)T(\d+):(\d+)/);
      if (!m) return;
      ms = sofiaToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5]);
    }
    const [date, sec] = ST.sim.serviceDay(ms);
    const C = connections(date, live);
    const midnight = ms - sec * 1000;
    const walkMode = { speed: WALK, jay: opts.jay }, runMode = { speed: RUN, jay: opts.jay };
    let found = [];
    const add = (j, ran) => {
      if (!j) return;
      const sig = j.legs.filter(l => l.type === "ride").map(l => `${l.trip}`).join(",");
      if (found.some(f => f.sig === sig)) return;
      j.sig = sig; j.ran = ran; found.push(j);
    };
    let first = scan(C, ends.a.ll, ends.b.ll, sec, walkMode, 0);
    // Far from any stop: look further.
    if (!first) first = scan(C, ends.a.ll, ends.b.ll, sec, walkMode, 0, 2.5 * ACCESS);
    add(first, false);
    add(scan(C, ends.a.ll, ends.b.ll, sec, walkMode, 480), false);
    // Later departures.
    // Later departures: leave just too late for the previous trip's first vehicle.
    let after = first;
    for (let k = 0; k < 3 && after; k++) {
      const r = after.legs.find(l => l.type === "ride");
      if (!r) break;
      const w = after.legs[0].type === "walk" ? after.legs[0].t1 - after.legs[0].t0 : 0;
      after = scan(C, ends.a.ll, ends.b.ll, Math.max(sec, r.t0 - BOARD - w + 1), walkMode, 0);
      add(after, false);
    }
    if (opts.run) {
      const fast = scan(C, ends.a.ll, ends.b.ll, sec, runMode, 0);
      if (fast && (!first || fast.arrive < first.arrive - 30)) add(fast, true);
    }
    // On foot all the way.
    const direct = walkPath([ends.a.ll], [ends.b.ll], walkMode);
    if (direct.time < 75 * 60) found.push({ legs: [{ type: "walk", from: "A", to: "B", t0: sec, t1: sec + direct.time }], arrive: sec + direct.time, walkOnly: true, sig: "walk" });
    for (const j of found) finish(j, walkMode, runMode, midnight, sec);
    // Nobody sprints a kilometre for a bus: drop trips that need more than MAX_RUN of running in one go.
    found = found.filter(j => j.legs.every(l => !l.run || l.run <= MAX_RUN) && (opts.run || !j.needsRun));
    found.sort((a, b) => a.arrive - b.arrive);
    // Drop repeats (other vehicles of the same lines at the same times) and trips another
    // beats: leaving no earlier, arriving no later, with no more changes and no more running.
    const seen = new Set();
    const uniq = found.filter(j => {
      const k = j.legs.map(l => l.type === "ride" ? `${lineOf(l).name}@${Math.round(l.t0 / 60)}` : "w").join(">") + Math.round(j.depart / 60);
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    const beats = (o, j) => o.depart >= j.depart && o.arrive <= j.arrive && o.transfers <= j.transfers && (!o.needsRun || j.needsRun)
      && (o.depart > j.depart || o.arrive < j.arrive || o.transfers < j.transfers);
    results = uniq.filter(j => j.walkOnly || !uniq.some(o => o !== j && !o.walkOnly && beats(o, j)));
    results = results.slice(0, 6);
    results.midnight = midnight; results.date = date;
    renderResults();
  }
  function sofiaToEpoch(y, mo, d, h, mi) {
    let guess = Date.UTC(y, mo - 1, d, h, mi);
    for (let i = 0; i < 2; i++) {
      const p = ST.sofiaParts(guess);
      guess += Date.UTC(y, mo - 1, d, h, mi) - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    }
    return guess;
  }

  /** Fill in places, walking paths, waits and where running is needed. */
  function finish(j, walkMode, runMode, midnight, sec) {
    const S = stops(), X = ST.transit;
    const place = s => s === "A" ? [ends.a.ll] : s === "B" ? [ends.b.ll] : S[s].pts;
    j.midnight = midnight;
    j.transfers = Math.max(0, j.legs.filter(l => l.type === "ride").length - 1);
    for (let k = 0; k < j.legs.length; k++) {
      const l = j.legs[k];
      if (l.type === "walk" && l.from !== "A" && l.to !== "B" && interchange(l.from, l.to) != null) {
        // A change inside the metro: straight through the passage.
        const a = S[l.from], b = S[l.to], w = interchange(l.from, l.to);
        l.change = true;
        l.path = { pts: [a.ll, b.ll], len: Math.hypot(a.xy[0] - b.xy[0], a.xy[1] - b.xy[1]), time: w, cross: { signal: 0, marked: 0, jaywalk: 0 } };
        l.walkTime = w; l.runTime = w;
        const next = j.legs[k + 1];
        l.t1 = next ? Math.min(next.t0, l.t0 + w) : l.t0 + w;
        continue;
      }
      if (l.type === "walk") {
        const path = walkPath(place(l.from), place(l.to), walkMode);
        l.path = path;
        l.metroOut = l.from !== "A" && l.from !== "B" && S[l.from].metro;
        l.metroIn = l.to !== "A" && l.to !== "B" && S[l.to].metro;
        const extra = (l.metroOut ? STATION : 0) + (l.metroIn ? STATION : 0);
        l.walkTime = path.time + extra;
        l.runTime = path.len / runMode.speed + (path.time - path.len / walkMode.speed) + extra;
        const next = j.legs[k + 1];
        // Time the leg may take: until the next vehicle (with the boarding margin), or as planned.
        l.avail = next ? next.t0 - BOARD - l.t0 : Infinity;
        // The first walk starts as late as it can, but not before the time asked for.
        if (k === 0 && next) { l.avail = next.t0 - BOARD - sec; l.t0 = Math.max(sec, next.t0 - BOARD - l.walkTime); }
        if (l.walkTime > l.avail + 5) {
          const f = Math.min(1, (l.walkTime - l.avail) / Math.max(1, l.walkTime - l.runTime));
          l.run = Math.round(path.len * f / 10) * 10;
          j.needsRun = true;
        }
        l.t1 = next ? Math.min(next.t0, l.t0 + Math.min(l.walkTime, l.avail)) : l.t0 + l.walkTime;
        if (path.cross.jaywalk) j.jaywalk = true;
      }
    }
    j.depart = j.legs[0].t0;
    j.arrive = j.legs[j.legs.length - 1].t1;
  }

  // ---------- Rendering ----------
  const fmt = s => ST.hhmm(s);
  const mins = s => Math.max(0, Math.round(s / 60));
  function tripOf(l) { return conns.trips[l.trip]; }
  function lineOf(l) {
    const tr = tripOf(l);
    if (tr.kind === "metro") {
      const r = MD.routes[tr.route];
      return { name: r.name, kind: "metro", color: r.color, text: r.text || "#fff" };
    }
    return ST.transit.lineInfo(tr.route);
  }
  function headOf(l) {
    const tr = tripOf(l);
    return ST.transit.placeName(tr.head || "");
  }
  function placeLabel(s) {
    if (s === "A") return ends.a.label;
    if (s === "B") return ends.b.label;
    return stops()[s].name();
  }
  function summary(j) {
    const chips = j.legs.map(l => l.type === "ride" ? ST.lineChip(lineOf(l))
      : l.change ? '<span class="plan-walk">⇄</span>' : `<span class="plan-walk">🚶${mins(l.t1 - l.t0)}</span>`).join('<span class="plan-sep">›</span>');
    const flags = [j.needsRun ? `<span class="plan-flag run">${t("needsRun")}</span>` : "", j.jaywalk ? `<span class="plan-flag jay">${t("hasJaywalk")}</span>` : ""].join("");
    return `<div class="plan-times"><b>${fmt(j.depart)} – ${fmt(j.arrive)}</b><span>${mins(j.arrive - j.depart)} ${t("min")}</span></div>
      <div class="plan-chips">${chips}</div>
      <div class="plan-meta">${j.walkOnly ? t("walkOnly") : j.transfers === 1 ? t("transfer1") : j.transfers ? t("transfersN", { n: j.transfers }) : t("noTransfer")}${flags}</div>`;
  }
  function renderResults() {
    clearDrawing();
    if (!results.length) { resultsEl.innerHTML = `<div class="empty">${t("noTrips")}</div>`; return; }
    resultsEl.innerHTML = `<h3>${results.length > 1 ? "" : ""}</h3>` + results.map((j, i) =>
      `<button class="plan-trip" data-i="${i}">${summary(j)}</button>`).join("");
    shown = null;
  }
  resultsEl.addEventListener("click", e => {
    const b = e.target.closest("[data-i]");
    if (b && b.classList.contains("plan-trip")) { showTrip(results[+b.dataset.i]); return; }
    const a = e.target.closest("[data-plan]");
    if (!a) return;
    if (a.dataset.plan === "back") { stopSim(); renderResults(); $("plan-form").hidden = false; }
    if (a.dataset.plan === "sim") simActive ? stopSim() : startSim(shown);
    if (a.dataset.plan === "leg") { const l = shown.legs[+a.dataset.k]; fitLeg(l); }
  });

  function showTrip(j) {
    shown = j;
    $("plan-form").hidden = true;
    const steps = [];
    j.legs.forEach((l, k) => {
      if (l.change) {
        const nx = j.legs[k + 1], line = nx && nx.type === "ride" ? lineOf(nx) : null;
        steps.push(`<div class="plan-step walk" data-plan="leg" data-k="${k}"><span class="plan-time">${fmt(l.t0)}</span>
          <span class="plan-ico">⇄</span><span class="grow"><b>${esc(t("changeTo", { l: line ? line.name : "", p: placeLabel(l.to) }))}</b>
          <span class="plan-sub">${t("throughStation")} · ${mins(l.t1 - l.t0)} ${t("min")}</span></span></div>`);
        return;
      }
      if (l.type === "walk") {
        const to = l.to === "B" ? ends.b.label : placeLabel(l.to);
        const cr = l.path.cross.signal + l.path.cross.marked + l.path.cross.jaywalk;
        const sub = [`${Math.round(l.path.len / 10) * 10} m`, `${mins(l.t1 - l.t0)} ${t("min")}`, cr ? t("crossings", { n: cr }) : "",
          l.path.cross.jaywalk ? `<span class="plan-flag jay">${t("hasJaywalk")}</span>` : "",
          l.run ? `<span class="plan-flag run">${t("runPart", { d: l.run })}</span>` : ""].filter(Boolean).join(" · ");
        steps.push(`<div class="plan-step walk${l.run ? " running" : ""}" data-plan="leg" data-k="${k}"><span class="plan-time">${fmt(l.t0)}</span>
          <span class="plan-ico">${l.run ? "🏃" : "🚶"}</span><span class="grow"><b>${esc(t(l.run ? "runTo" : "walkTo", { p: to }))}</b><span class="plan-sub">${sub}</span></span></div>`);
        const next = j.legs[k + 1];
        if (next && next.t0 - BOARD - l.t1 > 90) steps.push(`<div class="plan-step wait"><span class="plan-time"></span><span class="plan-ico">⏱</span><span class="grow plan-sub">${t("waitN", { m: mins(next.t0 - l.t1) })}</span></div>`);
      } else {
        const tr = tripOf(l), line = lineOf(l);
        steps.push(`<div class="plan-step ride" data-plan="leg" data-k="${k}" style="--c:${line.color}"><span class="plan-time">${fmt(l.t0)}</span>
          <span class="plan-ico">${ST.lineChip(line)}</span><span class="grow"><b>${esc(placeLabel(l.from))}</b>
          <span class="plan-sub">${t("toward")} ${esc(headOf(l))} · ${t("stopsN", { n: l.i1 - l.i0 })}${tr.kind !== "metro" ? ` · ${t(tr.live ? "realtime" : "predicted")}` : ""}</span>
          <span class="plan-off">${fmt(l.t1)} ${esc(placeLabel(l.to))}</span></span></div>`);
      }
    });
    steps.push(`<div class="plan-step end"><span class="plan-time">${fmt(j.arrive)}</span><span class="plan-ico"><span class="pin b">B</span></span><span class="grow"><b>${esc(ends.b.label)}</b></span></div>`);
    resultsEl.innerHTML = `<div class="plan-detail-head"><button class="btn" data-plan="back">‹ ${t("back")}</button>
      <button class="btn primary" data-plan="sim" id="plan-sim-btn">${t(simActive ? "stopSim" : "simulate")}</button></div>
      <div class="plan-trip static">${summary(j)}</div><div class="plan-steps">${steps.join("")}</div>`;
    draw(j);
  }

  // ---------- Map drawing ----------
  const layer = L.layerGroup().addTo(map);
  function clearDrawing() { layer.clearLayers(); }
  function ridePoints(l) {
    const tr = tripOf(l);
    if (tr.kind === "metro") {
      const pts = [];
      for (let i = l.i0; i < l.i1; i++) pts.push(stops()[metroIndex(tr.p.stops[i])].ll);
      pts.push(stops()[metroIndex(tr.p.stops[l.i1])].ll);
      return metroTrack(tr.p, l.i0, l.i1) || pts;
    }
    const sh = ST.transit.shape(tr.p.shape);
    const d0 = tr.p.d[l.i0], d1 = tr.p.d[l.i1];
    if (!sh) return [stops()[l.from].ll, stops()[l.to].ll];
    const pts = [ST.transit.along(sh, d0).ll];
    for (let k = 0; k < sh.pts.length; k++) if (sh.cum[k] > d0 && sh.cum[k] < d1) pts.push(sh.pts[k]);
    pts.push(ST.transit.along(sh, d1).ll);
    return pts;
  }
  // Metro track between two stations of a pattern, from the metro track paths.
  function metroTrack(p, i0, i1) {
    if (p.path == null || !p.pd || !MD.paths[p.path]) return null;
    const ids = MD.paths[p.path][0] || MD.paths[p.path];
    const nodes = (Array.isArray(ids[0]) ? ids[0] : ids).map(n => MD.nodes[n]).filter(Boolean);
    if (nodes.length < 2) return null;
    const cum = [0];
    for (let k = 1; k < nodes.length; k++) {
      const a = xy(nodes[k - 1]), b = xy(nodes[k]);
      cum.push(cum[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const d0 = p.pd[i0], d1 = p.pd[i1], out = [];
    for (let k = 0; k < nodes.length; k++) if (cum[k] >= d0 - 1 && cum[k] <= d1 + 1) out.push([nodes[k][0], nodes[k][1]]);
    return out.length >= 2 ? out : null;
  }
  function draw(j) {
    clearDrawing();
    const all = [];
    j.legs.forEach(l => {
      if (l.type === "walk") {
        const pts = l.path.pts;
        all.push(...pts);
        L.polyline(pts, { pane: "routes", color: "#fff", weight: 7, opacity: 0.9, interactive: false }).addTo(layer);
        L.polyline(pts, { pane: "routes", color: "#555b66", weight: 4, dashArray: "2 7", lineCap: "round", interactive: false }).addTo(layer);
        if (l.run) {
          // The running part: the last l.run metres.
          const part = tailPart(pts, l.run);
          L.polyline(part, { pane: "routes", color: "#e8590c", weight: 5, dashArray: "8 6", interactive: false }).addTo(layer);
        }
      } else {
        const pts = ridePoints(l), line = lineOf(l);
        all.push(...pts);
        L.polyline(pts, { pane: "routes", color: "#fff", weight: 9, opacity: 0.9, interactive: false }).addTo(layer);
        L.polyline(pts, { pane: "routes", color: line.color, weight: 6, interactive: false }).addTo(layer);
        for (const p of [pts[0], pts[pts.length - 1]])
          L.circleMarker(p, { pane: "routes", radius: 5, weight: 2, color: line.color, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(layer);
      }
    });
    if (all.length) map.fitBounds(L.latLngBounds(all).pad(0.15), { paddingTopLeft: [window.matchMedia("(max-width: 700px)").matches ? 0 : 420, 40] });
  }
  function tailPart(pts, metres) {
    const out = [pts[pts.length - 1]];
    let left = metres;
    for (let k = pts.length - 1; k > 0 && left > 0; k--) {
      const a = xy(pts[k]), b = xy(pts[k - 1]), d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d >= left) { const f = left / d; out.push(ll(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)); break; }
      out.push(pts[k - 1]); left -= d;
    }
    return out.reverse();
  }
  function fitLeg(l) {
    const pts = l.type === "walk" ? l.path.pts : ridePoints(l);
    map.fitBounds(L.latLngBounds(pts).pad(0.3), { paddingTopLeft: [window.matchMedia("(max-width: 700px)").matches ? 0 : 420, 40] });
  }

  // ---------- Simulating a trip ----------
  // The marker walks its walks in the planned time and rides the vehicle actually drawn on
  // the map: it waits at the stop until that vehicle comes, stays on it, and gets off when it
  // reaches the alighting stop. If the vehicle has already left, the trip is planned again
  // from that stop at that moment, and the marker carries on with the new trip.
  let simActive = false, me = null, follow = true, run = null;
  const newRun = j => ({ k: 0, start: j.legs[0].t0, last: -Infinity, busy: false });
  function startSim(j) {
    if (!j) return;
    simActive = true;
    follow = true;
    run = newRun(j);
    ST.clock.live = false;
    ST.clock.set(j.midnight + (j.depart - 60) * 1000, 10);
    ST.emit("clock"); ST.invalidate();
    if (!me) me = L.marker(ends.a.ll, { pane: "selected", interactive: false,
      icon: L.divIcon({ className: "plan-me", html: '<span class="plan-me-dot"></span>', iconSize: [22, 22], iconAnchor: [11, 11] }) });
    me.addTo(map);
    const b = $("plan-sim-btn"); if (b) b.textContent = t("stopSim");
  }
  function stopSim() {
    if (!simActive) return;
    simActive = false;
    if (me) map.removeLayer(me);
    ST.clock.live = true; ST.clock.set(Date.now(), 1);
    ST.emit("clock"); ST.invalidate();
    const b = $("plan-sim-btn"); if (b) b.textContent = t("simulate");
  }
  map.on("dragstart", () => { follow = false; });
  function along(pts, f) {
    const P = pts.map(xy), cum = [0];
    for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]));
    const s = Math.max(0, Math.min(1, f)) * cum[cum.length - 1];
    let k = 1;
    while (k < cum.length - 1 && cum[k] < s) k++;
    const seg = cum[k] - cum[k - 1] || 1, g = (s - cum[k - 1]) / seg;
    return ll(P[k - 1][0] + (P[k][0] - P[k - 1][0]) * g, P[k - 1][1] + (P[k][1] - P[k - 1][1]) * g);
  }
  /**
   * The vehicle of ride leg l as drawn at ms: when it leaves the boarding stop (dep) and reaches
   * the alighting stop (arr), in service-day seconds, and where it is now (ll, when drawn).
   */
  function vehicleOn(l, ms) {
    const tr = tripOf(l);
    if (tr.kind === "sim") {
      const v = ST.sim.vehicleAt(tr.v.name, ms);
      const r = (v && v.runs[tr.ri] && v.runs[tr.ri].times) ? v.runs[tr.ri] : tr.v.runs[tr.ri];
      const onIt = v && v.runIdx === tr.ri && v.sDisp != null && v.sDisp >= tr.p.d[l.i0] - 3;
      return { dep: r.times[l.i0], arr: r.times[l.i1], ll: onIt ? v.ll : null };
    }
    const m = ST.metroTrains && ST.metroTrains.onTrip(tr.id, ms);
    const p = tr.p;
    // Timetable times; a drawn train held back by the one ahead tells where it really is.
    let dep = tr.start + p.arr[l.i0] + (p.dw ? p.dw[l.i0] : 0), arr = tr.start + p.arr[l.i1];
    if (m) {
      if (m.d < p.pd[l.i0] - 3) dep = Math.max(dep, (ms - shown.midnight) / 1000 + 1);
      if (m.d < p.pd[l.i1] - 3) arr = Math.max(arr, (ms - shown.midnight) / 1000 + 1);
    }
    return { dep, arr, ll: m && m.d >= p.pd[l.i0] - 3 ? m.ll : null };
  }
  /** Advance the simulated traveller to service-day second sec; returns {ll, k, done, missed}. */
  function stepRun(j, ms, sec) {
    const legs = j.legs, S = stops();
    if (sec < run.last - 2) Object.assign(run, newRun(j));       // the clock went back
    run.last = sec;
    for (let guard = 0; guard <= legs.length; guard++) {
      const l = legs[run.k];
      if (!l) return { ll: ends.b.ll, k: legs.length - 1, done: true };
      if (l.type === "walk") {
        const dur = Math.max(1, l.t1 - l.t0);
        if (sec < run.start) return { ll: l.path.pts[0], k: run.k };
        const f = (sec - run.start) / dur;
        if (f < 1) return { ll: along(l.path.pts, f), k: run.k };
        run.start += dur; run.k++;
        continue;
      }
      // Riding: at the stop from run.start; the vehicle must not have left before that.
      const o = vehicleOn(l, ms), from = S[l.from].ll;
      if (o.dep == null || o.dep < run.start - 5) return { ll: from, k: run.k, missed: true };
      if (sec < o.dep) return { ll: from, k: run.k };
      if (sec < o.arr) {
        if (o.ll) return { ll: o.ll, k: run.k };
        return { ll: along(ridePoints(l), (sec - o.dep) / Math.max(1, o.arr - o.dep)), k: run.k };
      }
      run.k++; run.start = o.arr;
    }
    return { ll: ends.b.ll, k: legs.length - 1, done: true };
  }
  async function replan(j, k, ms) {
    run.busy = true;
    ST.toast(t("missed"));
    const l = j.legs[k], S = stops();
    setEnd("a", { ll: S[l.from].ll, label: S[l.from].name() });
    await search(ms);
    if (!simActive) return;
    const next = results && results[0];
    if (!next) { stopSim(); return; }
    showTrip(next);
    run = newRun(next);
  }
  ST.addLayer({
    frame(ctx) {
      if (!simActive || !shown || !me || run.busy) return;
      const sec = (ctx.ms - shown.midnight) / 1000;
      const p = stepRun(shown, ctx.ms, sec);
      me.setLatLng(p.ll);
      if (p.missed) { replan(shown, p.k, ctx.ms); return; }
      if (follow && ctx.slow) ST.focus(p.ll);
      if (ctx.slow) document.querySelectorAll(".plan-step[data-k]").forEach(el => el.classList.toggle("now", +el.dataset.k === p.k && !p.done));
      if (p.done) ST.clock.set(ctx.ms, 1);
    },
  });

  ST.on("panel", name => { if (name === "plan") load(); });
  ST.on("lang", () => { if (shown) showTrip(shown); else if (results) renderResults(); });
  window.planDebug = { load, snap, walkPath, scan, connections, get W() { return W; }, stops, get results() { return results; }, get shown() { return shown; }, vehicleOn, tripOf, ends, setEnd, search };
})();
