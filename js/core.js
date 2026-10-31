/* Shared app core: language, settings, clock, map, panels, detail card, search,
 * filters and the frame loop. Layers (metro.js, live.js) plug into window.ST. */
(function () {
  "use strict";

  // ---------- Settings ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem("st." + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("st." + key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
    },
  };

  // ---------- Language ----------
  const STRINGS = {
    appTitle: ["Градски транспорт София", "Sofia Transport Live"],
    menu: ["Меню", "Menu"], search: ["Търсене", "Search"], filter: ["Филтър", "Filter"],
    layers: ["Карта", "Map"], locate: ["Моето местоположение", "My location"],
    searchPlaceholder: ["Линия, спирка или номер на возило", "Line, stop or vehicle number"],
    lineFilterPlaceholder: ["Намери линия…", "Find a line…"],
    vehicleTypes: ["Видове транспорт", "Vehicle types"], lines: ["Линии", "Lines"],
    resetFilter: ["Покажи всички", "Show all"], mapStyle: ["Стил на картата", "Map style"],
    styleVector: ["Векторна", "Vector"], styleOsm: ["OpenStreetMap", "OpenStreetMap"],
    styleNoWebgl: ["Браузърът няма WebGL — показва се OpenStreetMap.", "Your browser has no WebGL, so OpenStreetMap tiles are shown."],
    theme: ["Тема", "Theme"], themeAuto: ["Авто", "Auto"], themeLight: ["Светла", "Light"], themeDark: ["Тъмна", "Dark"],
    display: ["Показване", "Display"], showBodies: ["Превозни средства в цял ръст", "Full-length vehicles"],
    showStops: ["Спирки (при приближаване)", "Stops (when zoomed in)"],
    language: ["Език", "Language"], counts: ["В движение сега", "Running now"],
    metroTime: ["Време на метрото", "Metro time"],
    metroTimeHint: ["Метрото е симулирано по разписание и може да се превърта. Автобусите, трамваите и тролейбусите са на живо и се виждат само в реално време.",
                    "The metro is simulated from the timetable and can be time-travelled. Buses, trams and trolleybuses are live and only shown in real time."],
    now: ["Сега", "Now"], metroDelay: ["Закъснение на метрото (сек., минус = по-рано)", "Metro runs late by (seconds, negative = early)"],
    reset: ["Нулирай", "Reset"], about: ["Информация", "About"],
    kind_metro: ["Метро", "Metro"], kind_tram: ["Трамвай", "Tram"], kind_trolley: ["Тролейбус", "Trolleybus"],
    kind_bus: ["Автобус", "Bus"], kind_night: ["Нощен", "Night"],
    kinds_metro: ["Метро", "Metro"], kinds_tram: ["Трамваи", "Trams"], kinds_trolley: ["Тролейбуси", "Trolleybuses"],
    kinds_bus: ["Автобуси", "Buses"], kinds_night: ["Нощни", "Night lines"],
    live: ["На живо", "Live"], liveStale: ["Данните закъсняват", "Feed delayed"], liveError: ["Няма връзка с данните", "Feed unavailable"],
    simulated: ["Симулация", "Simulated"], liveHidden: ["Наземният транспорт е само на живо", "Surface transport is live only"],
    noResults: ["Няма резултати", "No results"], stop: ["Спирка", "Stop"], station: ["Метростанция", "Metro station"],
    vehicle: ["Возило", "Vehicle"], line: ["Линия", "Line"],
    min: ["мин", "min"], sec: ["сек", "s"], nowShort: ["сега", "now"],
    nextStop: ["Следваща спирка", "Next stop"], atStop: ["На спирка", "At stop"], speed: ["Скорост", "Speed"],
    kmh: ["км/ч", "km/h"], delay: ["Закъснение", "Delay"], onTime: ["Навреме", "On time"],
    late: ["закъснява {m} мин", "{m} min late"], early: ["подранява {m} мин", "{m} min early"],
    occupancy: ["Заетост", "Occupancy"], model: ["Модел", "Model"], fleetNo: ["Инв. №", "Fleet no."],
    length: ["Дължина", "Length"], lowFloor: ["Нископодово", "Low floor"], partialLowFloor: ["Частично нископодово", "Partly low floor"],
    ac: ["Климатик", "Air conditioning"], yes: ["да", "yes"], no: ["не", "no"], unknownModel: ["Неизвестен модел", "Unknown model"],
    lastUpdate: ["Обновено преди {s} сек", "Updated {s} s ago"], departures: ["Заминавания", "Departures"],
    noDepartures: ["Няма данни за заминавания в следващия час", "No departure data for the next hour"],
    stopsOnRoute: ["Спирки по маршрута", "Stops on the route"], showLineOnly: ["Само тази линия", "Only this line"],
    showAllLines: ["Всички линии", "All lines"], directions: ["Посоки", "Directions"],
    vehiclesOnLine: ["{n} возила на линията", "{n} vehicles on the line"], toward: ["към", "to"],
    occ_0: ["Празно", "Empty"], occ_1: ["Много свободни места", "Many seats free"], occ_2: ["Малко свободни места", "Few seats free"],
    occ_3: ["Само правостоящи", "Standing room only"], occ_4: ["Пълно", "Crushed standing"], occ_5: ["Пълно", "Full"],
    occ_6: ["Не приема пътници", "Not accepting passengers"],
    realtime: ["по реално време", "real time"], scheduled: ["по разписание", "scheduled"],
    locating: ["Търсене на местоположение…", "Finding your location…"], locateFailed: ["Местоположението не е достъпно", "Location unavailable"],
    aboutText: ["Автобуси, трамваи и тролейбуси: позиции на живо от официалния GTFS-realtime поток на {cgm}. Метро: изчислени позиции по официалното разписание (GTFS) и коловозите от {osm}. Модели на возилата: по инвентарни номера, по данни на {lt}, transphoto.org и Уикипедия. Неофициален проект.",
                "Buses, trams and trolleybuses: live positions from the official GTFS-realtime feed of the {cgm}. Metro: positions estimated from the official timetable (GTFS) on track geometry from {osm}. Vehicle models: by fleet number, from {lt}, transphoto.org and Wikipedia. Unofficial project."],
    cgm: ["Центъра за градска мобилност", "Sofia Urban Mobility Center"],
  };
  let lang = store.get("lang", "bg");
  function t(key, vars) {
    const pair = STRINGS[key];
    let s = pair ? pair[lang === "bg" ? 0 : 1] : key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
    return s;
  }
  function applyI18n() {
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll("[data-i18n-title]")) { el.title = t(el.dataset.i18nTitle); el.setAttribute("aria-label", el.title); }
    for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
    document.getElementById("about").innerHTML = t("aboutText", {
      cgm: `<a href="https://www.sofiatraffic.bg/" target="_blank" rel="noopener">${t("cgm")}</a>`,
      osm: `<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>`,
      lt: `<a href="https://livetransport.eu/sofia" target="_blank" rel="noopener">livetransport.eu</a>`,
    }) + ` <a href="https://github.com/jukfiuune/sofia-metro" target="_blank" rel="noopener">GitHub</a>`;
    document.querySelectorAll("#lang-choice button").forEach(b => b.classList.toggle("active", b.dataset.lang === lang));
  }

  // ---------- Theme ----------
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  let themeSetting = store.get("theme", "auto");
  const isDark = () => themeSetting === "dark" || (themeSetting === "auto" && darkQuery.matches);

  // ---------- Clock (Sofia local time) ----------
  const TZ = "Europe/Sofia";
  const fmtParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  function sofiaParts(ms) {
    const o = {};
    for (const { type, value } of fmtParts.formatToParts(new Date(ms))) o[type] = +value;
    return o;
  }
  const ymd = (y, m, d) => `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
  function shiftDay(p, days) {
    const dt = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
    return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  function sofiaToEpoch(y, mo, d, h, mi) {
    let guess = Date.UTC(y, mo - 1, d, h, mi);
    for (let i = 0; i < 2; i++) {
      const p = sofiaParts(guess);
      guess += Date.UTC(y, mo - 1, d, h, mi) - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    }
    return guess;
  }
  const hhmm = s => {
    s = ((Math.round(s) % 86400) + 86400) % 86400;
    return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}`;
  };
  const hhmmEpoch = ms => { const p = sofiaParts(ms); return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; };

  // Formatting Intl parts is slow; cache per whole second (a few distinct instants per frame).
  const partsCache = new Map();
  function clockAt(ms) {
    const whole = Math.floor(ms / 1000);
    let p = partsCache.get(whole);
    if (!p) {
      if (partsCache.size > 8) partsCache.clear();
      p = sofiaParts(whole * 1000);
      partsCache.set(whole, p);
    }
    return { p, sec: p.hour * 3600 + p.minute * 60 + p.second + (ms - whole * 1000) / 1000 };
  }

  const clock = {
    base: Date.now(), realBase: performance.now(), speed: 1, live: true,
    now() { return this.base + (performance.now() - this.realBase) * this.speed; },
    set(ms, speed = this.speed) { this.base = ms; this.realBase = performance.now(); this.speed = speed; },
    isRealtime() { return this.live && this.speed === 1; },
  };

  // ---------- Map ----------
  const map = L.map("map", { zoomControl: false, minZoom: 10, maxZoom: 19, zoomSnap: 0.5, wheelPxPerZoomLevel: 90 });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
  for (const [name, z] of [["lines", 405], ["routes", 408], ["tracks", 415], ["stops", 418], ["stations", 420],
    ["bodies", 630], ["vehicles", 640], ["selected", 645]]) map.createPane(name).style.zIndex = z;
  const saved = store.get("view", null);
  if (saved) map.setView([saved[0], saved[1]], saved[2]);
  else map.setView([42.6977, 23.3219], 12.5);
  map.on("moveend", () => { const c = map.getCenter(); store.set("view", [+c.lat.toFixed(5), +c.lng.toFixed(5), map.getZoom()]); });

  // Low-end phones (little memory or few cores) start on the lighter raster map.
  const lowEnd = (navigator.deviceMemory && navigator.deviceMemory <= 3) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
    (navigator.connection && navigator.connection.saveData);
  let mapStyle = store.get("mapStyle", lowEnd ? "osm" : "vector");
  const basemap = createBasemap(map, { style: mapStyle, theme: isDark() ? "dark" : "light", lang });
  function applyTheme() {
    const dark = isDark();
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const used = basemap.apply({ style: mapStyle, theme: dark ? "dark" : "light", lang });
    document.documentElement.classList.toggle("raster", used === "osm");
    document.querySelectorAll("#theme-choice button").forEach(b => b.classList.toggle("active", b.dataset.theme === themeSetting));
    document.querySelectorAll("#style-choice button").forEach(b => b.classList.toggle("active", b.dataset.style === mapStyle));
    document.getElementById("style-hint").textContent = basemap.canVector ? "" : t("styleNoWebgl");
    emit("theme");
  }
  darkQuery.addEventListener("change", () => { if (themeSetting === "auto") applyTheme(); });

  const LAT0 = 42.69;
  const metresPerPixel = () => 156543.03392 * Math.cos(LAT0 * Math.PI / 180) / Math.pow(2, map.getZoom());

  // ---------- Events ----------
  const listeners = {};
  function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
  function emit(ev, ...args) { for (const fn of listeners[ev] || []) fn(...args); }

  // ---------- Panels ----------
  let openPanel = null;
  function showPanel(name) {
    for (const el of document.querySelectorAll(".panel")) el.hidden = el.id !== `panel-${name}`;
    document.querySelectorAll(".rail-btn[data-panel]").forEach(b => b.classList.toggle("active", b.dataset.panel === name));
    openPanel = name;
    document.body.classList.toggle("panel-open", !!name);
    if (name === "search") setTimeout(() => document.getElementById("search-input").focus(), 30);
    emit("panel", name);
  }
  document.querySelectorAll(".rail-btn[data-panel]").forEach(b => b.addEventListener("click", () =>
    showPanel(openPanel === b.dataset.panel ? null : b.dataset.panel)));
  document.querySelectorAll(".panel-close").forEach(b => b.addEventListener("click", () => showPanel(null)));

  // ---------- Detail card ----------
  const cardEl = document.getElementById("card"), cardBody = document.getElementById("card-body");
  let card = null;
  function openCard(spec) {
    if (card && card.onClose) card.onClose();
    card = spec;
    cardEl.hidden = false;
    document.body.classList.add("card-open");
    if (window.matchMedia("(max-width: 700px)").matches) showPanel(null);
    renderCard(true);
  }
  function closeCard() {
    if (card && card.onClose) card.onClose();
    card = null;
    cardEl.hidden = true;
    document.body.classList.remove("card-open");
    emit("cardclose");
  }
  function renderCard(force) {
    if (!card) return;
    const html = card.render();
    if (html === null) { closeCard(); return; }
    if (force || html !== card.last) {
      const scroll = cardBody.scrollTop;
      cardBody.innerHTML = html;
      cardBody.scrollTop = force ? 0 : scroll;
      card.last = html;
      if (card.after) card.after(cardBody);
    }
  }
  document.getElementById("card-close").addEventListener("click", closeCard);
  cardBody.addEventListener("click", e => {
    const a = e.target.closest("[data-action]");
    if (a) { e.preventDefault(); emit("action", a.dataset.action, a.dataset, a); }
  });
  on("action", (action, data) => {
    if (action !== "only-line") return;
    const only = filters.lines.size === 1 && filters.lines.has(data.line);
    setFilter({ lines: only ? [] : [data.line] });
    renderCard(true);
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { if (card) closeCard(); else showPanel(null); } });

  /** Bring a point into the part of the map not covered by the card (and optionally zoom in). */
  function focus(ll, minZoom) {
    const z = Math.max(map.getZoom(), minZoom || 0);
    const size = map.getSize(), mobile = window.matchMedia("(max-width: 700px)").matches;
    const cardOpen = !!card;
    const area = { x0: mobile ? 0 : 70, y0: 50, x1: size.x - (cardOpen && !mobile ? 400 : 0), y1: size.y - (cardOpen && mobile ? size.y * 0.58 : 0) };
    const p = map.project(ll, z), c = map.project(map.getCenter(), z), half = size.divideBy(2);
    const screen = p.subtract(c).add(half);
    const inside = screen.x > area.x0 + 30 && screen.x < area.x1 - 30 && screen.y > area.y0 + 30 && screen.y < area.y1 - 30;
    if (inside && z === map.getZoom()) return;
    const target = L.point((area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2);
    map.setView(map.unproject(p.subtract(target.subtract(half)), z), z, { animate: true });
  }

  // ---------- Search ----------
  const providers = [];
  const searchInput = document.getElementById("search-input"), resultsEl = document.getElementById("search-results");
  const norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ё/g, "е").trim();
  /** Match score of a normalised query against a name: whole-prefix 3, every word starts a word 2, substring 1. */
  function matchScore(q, name) {
    const n = norm(name).replace(/[.,„"“”()\-]/g, " ").replace(/\s+/g, " ").trim();
    if (!n) return 0;
    if (n.startsWith(q)) return 3;
    const words = n.split(" "), qs = q.replace(/[.,„"“”()\-]/g, " ").split(/\s+/).filter(Boolean);
    if (qs.length && qs.every(w => words.some(x => x.startsWith(w)))) return 2;
    return n.includes(q) ? 1 : 0;
  }
  let lastResults = [];
  function runSearch() {
    const q = norm(searchInput.value);
    if (!q) { resultsEl.innerHTML = ""; lastResults = []; return; }
    let results = [];
    for (const p of providers) results.push(...p(q, searchInput.value.trim()));
    results.sort((a, b) => b.score - a.score);
    lastResults = results.slice(0, 40);
    resultsEl.innerHTML = lastResults.length
      ? lastResults.map((r, i) => `<button class="result" data-i="${i}">${r.icon || ""}<span class="result-text"><span class="result-label">${r.label}</span>${r.sub ? `<span class="result-sub">${r.sub}</span>` : ""}</span></button>`).join("")
      : `<div class="empty">${t("noResults")}</div>`;
  }
  searchInput.addEventListener("input", runSearch);
  searchInput.addEventListener("keydown", e => { if (e.key === "Enter" && lastResults[0]) { lastResults[0].action(); } });
  resultsEl.addEventListener("click", e => {
    const b = e.target.closest(".result");
    if (b) lastResults[+b.dataset.i].action();
  });

  // ---------- Filters ----------
  const KINDS = ["metro", "tram", "trolley", "bus", "night"];
  const KIND_COLORS = { metro: "#2d54a4", tram: "#F7941D", trolley: "#27AAE1", bus: "#BE1E2D", night: "#1d1f23" };
  const filters = { kinds: new Set(store.get("kinds", KINDS)), lines: new Set(store.get("lines", [])) };
  const lineRegistry = [];   // {id, name, kind, color, text}
  function routeVisible(id, kind) {
    if (filters.lines.size) return filters.lines.has(id);
    return filters.kinds.has(kind);
  }
  function setFilter(change) {
    if (change.kinds) filters.kinds = new Set(change.kinds);
    if (change.lines) filters.lines = new Set(change.lines);
    store.set("kinds", [...filters.kinds]);
    store.set("lines", [...filters.lines]);
    renderFilter();
    emit("filter");
    invalidate();
  }
  const kindIcon = (kind, size = 20) => `<span class="kind-icon k-${kind}" style="--s:${size}px">${KIND_SVG[kind]}</span>`;
  const KIND_SVG = {
    metro: '<svg viewBox="0 0 24 24"><path d="M5 19 9 5l3 8 3-8 4 14"/></svg>',
    tram: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9 3h6M12 3v3M9 21l1-3M15 21l-1-3M6 12h12"/></svg>',
    trolley: '<svg viewBox="0 0 24 24"><rect x="5" y="8" width="14" height="10" rx="2.5"/><path d="M9 8 13 2M12 8l4-6M5 13h14M8 21v-3M16 21v-3"/></svg>',
    bus: '<svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="14" rx="2.5"/><path d="M5 11h14M8 21v-3M16 21v-3"/></svg>',
    night: '<svg viewBox="0 0 24 24"><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/></svg>',
  };
  const lineChip = (l, extra = "") => `<span class="line-chip k-${l.kind}" style="--c:${l.color};--t:${l.text}"${extra}>${l.name}</span>`;

  function renderFilter() {
    document.getElementById("kind-filter").innerHTML = KINDS.map(k =>
      `<button class="chip kind${filters.kinds.has(k) ? " on" : ""}" data-kind="${k}">${kindIcon(k, 18)}${t("kinds_" + k)}</button>`).join("");
    const q = norm(document.getElementById("line-filter-input").value || "");
    const list = lineRegistry.filter(l => !q || norm(l.name).startsWith(q));
    document.getElementById("line-filter").innerHTML = list.map(l =>
      `<button class="chip line${filters.lines.has(l.id) ? " on" : ""}" data-line="${l.id}" title="${t("kind_" + l.kind)}">${lineChip(l)}</button>`).join("");
    document.getElementById("filter-dot").hidden = !(filters.lines.size || filters.kinds.size < KINDS.length);
  }
  document.getElementById("kind-filter").addEventListener("click", e => {
    const b = e.target.closest("[data-kind]"); if (!b) return;
    const k = new Set(filters.kinds);
    k.has(b.dataset.kind) ? k.delete(b.dataset.kind) : k.add(b.dataset.kind);
    setFilter({ kinds: k, lines: [] });
  });
  document.getElementById("line-filter").addEventListener("click", e => {
    const b = e.target.closest("[data-line]"); if (!b) return;
    const s = new Set(filters.lines);
    s.has(b.dataset.line) ? s.delete(b.dataset.line) : s.add(b.dataset.line);
    setFilter({ lines: s });
  });
  document.getElementById("line-filter-input").addEventListener("input", renderFilter);
  document.getElementById("filter-reset").addEventListener("click", () => setFilter({ kinds: KINDS, lines: [] }));

  // ---------- Display settings ----------
  const display = { bodies: store.get("bodies", false), stops: store.get("stops", true) };
  const BODY_ZOOM = 16.5;
  // Bodies are sub-pixel when zoomed out, so the setting only applies from zoom 14.
  const bodiesWanted = () => (display.bodies && map.getZoom() >= 14) || map.getZoom() >= BODY_ZOOM;
  const bodyBox = document.getElementById("show-bodies"), stopsBox = document.getElementById("show-stops");
  bodyBox.checked = display.bodies; stopsBox.checked = display.stops;
  bodyBox.addEventListener("change", () => { display.bodies = bodyBox.checked; store.set("bodies", display.bodies); invalidate(); });
  stopsBox.addEventListener("change", () => { display.stops = stopsBox.checked; store.set("stops", display.stops); emit("stops"); });
  document.getElementById("theme-choice").addEventListener("click", e => {
    const b = e.target.closest("[data-theme]"); if (!b) return;
    themeSetting = b.dataset.theme; store.set("theme", themeSetting); applyTheme();
  });
  document.getElementById("style-choice").addEventListener("click", e => {
    const b = e.target.closest("[data-style]"); if (!b) return;
    mapStyle = b.dataset.style; store.set("mapStyle", mapStyle); applyTheme();
  });
  document.getElementById("lang-choice").addEventListener("click", e => {
    const b = e.target.closest("[data-lang]"); if (!b) return;
    lang = b.dataset.lang; store.set("lang", lang);
    applyI18n(); applyTheme(); renderFilter(); runSearch(); emit("lang"); renderCard(true);
  });

  // ---------- Metro time controls ----------
  const simInput = document.getElementById("sim-time"), liveBtn = document.getElementById("live-btn");
  const speedBtns = [...document.querySelectorAll("#speed button")];
  function syncTimeInputs() {
    const p = sofiaParts(clock.now());
    if (document.activeElement !== simInput)
      simInput.value = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    liveBtn.classList.toggle("is-live", clock.isRealtime());
    speedBtns.forEach(b => b.classList.toggle("active", +b.dataset.speed === clock.speed));
  }
  simInput.addEventListener("change", () => {
    const m = simInput.value.match(/^(\d+)-(\d+)-(\d+)T(\d+):(\d+)/);
    if (!m) return;
    clock.live = false;
    clock.set(sofiaToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5]));
    syncTimeInputs(); emit("clock"); invalidate();
  });
  liveBtn.addEventListener("click", () => { clock.live = true; clock.set(Date.now(), 1); syncTimeInputs(); emit("clock"); invalidate(); });
  speedBtns.forEach(b => b.addEventListener("click", () => {
    const s = +b.dataset.speed;
    if (s !== 1) clock.live = false;
    clock.set(clock.now(), s);
    syncTimeInputs(); emit("clock"); invalidate();
  }));

  // ---------- Location ----------
  let locMarker = null;
  document.getElementById("locate").addEventListener("click", () => {
    if (!navigator.geolocation) return toast(t("locateFailed"));
    toast(t("locating"));
    navigator.geolocation.getCurrentPosition(pos => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      if (!locMarker) locMarker = L.circleMarker(ll, { pane: "selected", radius: 7, weight: 3, color: "#fff", fillColor: "#1a73e8", fillOpacity: 1 }).addTo(map);
      else locMarker.setLatLng(ll);
      map.setView(ll, Math.max(map.getZoom(), 16));
      toast(null);
    }, () => toast(t("locateFailed")), { enableHighAccuracy: true, timeout: 10000 });
  });

  // ---------- Status chip / toast ----------
  const statusClock = document.getElementById("status-clock"), statusText = document.getElementById("status-text");
  const statusFeed = document.getElementById("status-feed");
  let toastTimer = null;
  function toast(msg) {
    statusText.textContent = msg || "";
    clearTimeout(toastTimer);
    if (msg) toastTimer = setTimeout(() => { statusText.textContent = ""; emit("status"); }, 4000);
  }
  function setFeedState(state, title) {
    statusFeed.className = `feed-dot ${state}`;
    statusFeed.title = title || "";
  }

  // ---------- Frame loop ----------
  // Redraw only as often as the fastest vehicle moves about half a pixel (and at
  // least 4× a second for the clock); zoomed out that is a few times a second.
  // The interval also adapts to the device: if a redraw costs c ms, wait at least 3c
  // after it, so slow phones keep three quarters of their time for scrolling and input.
  const V_FASTEST = 80 / 3.6;
  const layers = [];
  let lastDraw = 0, lastSlow = 0, dirty = true, drawCost = 2;
  const invalidate = () => { dirty = true; };
  map.on("move zoom", invalidate);
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const interval = Math.max(Math.min(250, 500 * metresPerPixel() / (V_FASTEST * Math.max(1, clock.speed))), 3 * drawCost);
    if (now - lastDraw < (dirty ? 2 * drawCost : interval)) return;
    dirty = false;
    lastDraw = now;
    const slow = now - lastSlow > 240;
    if (slow) lastSlow = now;
    const ctx = { now, ms: clock.now(), zoom: map.getZoom(), mpp: metresPerPixel(), slow,
      bodies: bodiesWanted(), view: map.getBounds().pad(0.25) };
    for (const l of layers) l.frame(ctx);
    drawCost = drawCost * 0.9 + (performance.now() - now) * 0.1;
    if (slow) {
      const { p } = clockAt(ctx.ms);
      statusClock.textContent = [p.hour, p.minute, p.second].map(v => String(v).padStart(2, "0")).join(":");
      document.getElementById("status").classList.toggle("simulated", !clock.isRealtime());
      if (!statusText.textContent || statusText.dataset.auto) {
        statusText.textContent = clock.isRealtime() ? "" : `${t("simulated")} · ${clock.speed}×`;
        statusText.dataset.auto = clock.isRealtime() ? "" : "1";
      }
      renderCard(false);
      if (openPanel === "menu") renderCounts();
    }
  }
  setInterval(syncTimeInputs, 5000);

  const countProviders = [];
  function renderCounts() {
    const rows = countProviders.flatMap(p => p());
    document.getElementById("counts").innerHTML = rows.map(r =>
      `<div class="count-row">${r.icon}<span class="count-label">${r.label}</span><span class="count-n">${r.n}</span></div>`).join("");
  }

  // ---------- Public API ----------
  window.ST = {
    store, t, get lang() { return lang; }, get dark() { return isDark(); }, TZ,
    sofiaParts, ymd, shiftDay, hhmm, hhmmEpoch, clockAt, clock,
    map, metresPerPixel, invalidate, on, emit,
    addLayer(layer) { layers.push(layer); },
    openCard, closeCard, get card() { return card; }, renderCard, focus,
    addSearch(fn) { providers.push(fn); }, norm, matchScore,
    KINDS, KIND_COLORS, kindIcon, lineChip, filters, routeVisible, setFilter,
    registerLines(list) { lineRegistry.push(...list); renderFilter(); },
    lineInfo: id => lineRegistry.find(l => l.id === id),
    display, bodiesWanted, toast, setFeedState, showPanel,
    addCounts(fn) { countProviders.push(fn); },
    debugFrame() { dirty = true; lastDraw = 0; frame(); },
    get drawCost() { return drawCost; }, lowEnd,
  };

  applyI18n();
  applyTheme();
  renderFilter();
  syncTimeInputs();
  requestAnimationFrame(frame);
})();
