/* ACD Germany – lead manager (frontend) */
"use strict";

// Status = colour code of column J in the roadmap sheet (ring around the pin).
const STATUS_INFO = {
  gesprek:      { label: "Gesprek",            color: "#FFC000" },
  samenwerking: { label: "Samenwerking",       color: "#00B050" },
  geen:         { label: "Geen samenwerking",  color: "#FF0000" },
};
const NO_CATEGORY = LeadStore.NO_CATEGORY;
const GERMANY_BOUNDS = [[47.2, 5.8], [55.1, 15.1]];
const CONFLICT_COLOR = "#c62828";

const state = {
  leads: [],
  settings: { min_distance_km: 50, ignore_statuses: ["geen"], excluded_categories: [], category_colors: {} },
  conflicts: [],
  nearest: new Map(),     // lead id -> { lead, km }
  conflictIds: new Set(), // ids of leads involved in at least one conflict
  selectedId: null,
  editing: null,          // lead being edited (null = new lead)
  picking: false,
  drawerOpenedAt: 0,
  geocoding: null,        // { stop: boolean } while locations are being looked up
  // Selected filters; an empty set means "everything".
  filter: { groups: new Set(), statuses: new Set() },
};

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtKm = (km) => (km < 100 ? km.toFixed(1).replace(".", ",") : Math.round(km)) + " km";
const hasGeo = (l) => l.lat !== null && l.lat !== undefined && l.lng !== null && l.lng !== undefined;
const statusOf = (s) => STATUS_INFO[s] || { label: s, color: "#999" };
// A lead's group: "Categorie › Subcategorie", or only the category. Drives colour, filters and checks.
const categoryOf = (l) => LeadStore.groupKey(l);
const colorOf = (cat) => state.settings.category_colors[cat] || "#64748b";
const isDealer = (key) => key === "Dealer" || key.startsWith("Dealer" + LeadStore.SEP);

/* ---------------- storage & helpers ---------------- */
// All data lives in this browser (localStorage), see store.js.
let browserStorage = null;
try { browserStorage = window.localStorage; } catch (e) { /* blocked */ }
const store = LeadStore.createStore(browserStorage);

function api(path, options = {}) {
  return store.request(options.method || "GET", path, options.body);
}

// Address lookup via OpenStreetMap Nominatim (max. 1 request per second).
// Only the place or address is sent, never names or contact details.
const geocodeCache = new Map();
let lastGeocodeAt = 0;
async function geocode(params) {
  const key = JSON.stringify(params);
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  const wait = 1100 - (Date.now() - lastGeocodeAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocodeAt = Date.now();
  const query = new URLSearchParams({
    format: "jsonv2", addressdetails: "1", limit: "5", countrycodes: "de", "accept-language": "de",
  });
  for (const [k, v] of Object.entries(params)) if (v) query.set(k, v);
  let res;
  try {
    res = await fetch("https://nominatim.openstreetmap.org/search?" + query);
  } catch (e) {
    throw new Error("Locaties zoeken lukt niet (geen internet of geblokkeerd door het netwerk)");
  }
  if (!res.ok) throw new Error(`Locaties zoeken mislukt (${res.status})`);
  const results = (await res.json()).map((item) => {
    const a = item.address || {};
    return {
      label: item.display_name || "",
      lat: Number(item.lat),
      lng: Number(item.lon),
      street: [a.road, a.house_number].filter(Boolean).join(" "),
      postal_code: a.postcode || "",
      city: a.city || a.town || a.village || a.municipality || "",
      state: a.state || "",
    };
  });
  geocodeCache.set(key, results);
  return results;
}

// Find a municipality, trying a few spellings (see Roadmap.placeQueries).
async function geocodePlace(city, stateName) {
  for (const q of Roadmap.placeQueries(city, stateName)) {
    const results = await geocode({ city: q.city, state: q.state, country: "Deutschland" });
    if (results.length) return results[0];
  }
  return null;
}

function downloadFile(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const today = () => new Date().toISOString().slice(0, 10);

function toast(message, isError = false, ms) {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms || (isError ? 7000 : 3500));
}

/* ---------------- distance logic ---------------- */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Does this lead take part in the "too close" check?
function counts(lead) {
  return !state.settings.ignore_statuses.includes(lead.status) &&
    !state.settings.excluded_categories.includes(categoryOf(lead));
}

function computeDistances() {
  const located = state.leads.filter(hasGeo);
  const min = Number(state.settings.min_distance_km);
  state.nearest = new Map();
  state.conflicts = [];
  state.conflictIds = new Set();
  for (let i = 0; i < located.length; i++) {
    const a = located[i];
    for (let j = i + 1; j < located.length; j++) {
      const b = located[j];
      const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
      for (const [x, y] of [[a, b], [b, a]]) {
        const cur = state.nearest.get(x.id);
        if (!cur || km < cur.km) state.nearest.set(x.id, { lead: y, km });
      }
      if (km < min && counts(a) && counts(b)) {
        state.conflicts.push({ a, b, km });
        state.conflictIds.add(a.id);
        state.conflictIds.add(b.id);
      }
    }
  }
  state.conflicts.sort((p, q) => p.km - q.km);
}

function nearestTo(lat, lng, excludeId, limit = 5) {
  return state.leads
    .filter((l) => hasGeo(l) && l.id !== excludeId)
    .map((l) => ({ lead: l, km: haversineKm(lat, lng, l.lat, l.lng) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, limit);
}

// Groups (fixed taxonomy + any in use), sorted like the taxonomy: { key, n, category, subcategory }.
function groupsInUse() {
  const groups = new Map();
  // The fixed categories/subcategories are always listed (with 0 when empty), then any others in use.
  for (const [category, subs] of LeadStore.TAXONOMY) {
    for (const subcategory of subs.length ? subs : [""]) {
      const key = LeadStore.groupKey({ category, subcategory });
      groups.set(key, { key, n: 0, category, subcategory });
    }
  }
  for (const l of state.leads) {
    const key = categoryOf(l);
    if (!groups.has(key)) {
      groups.set(key, { key, n: 0, category: l.category || NO_CATEGORY, subcategory: l.subcategory || "" });
    }
    groups.get(key).n++;
  }
  return [...groups.values()].sort(Roadmap.compareGroups);
}

function categoriesInUse() {
  return groupsInUse().map((g) => [g.key, g.n]);
}

// Render groups with a header per category; subcategories are indented under it.
function groupedHtml(itemFn, groups = groupsInUse()) {
  let html = "", current = null;
  for (const g of groups) {
    const hasSubs = Boolean(g.subcategory) || current === g.category;
    if (g.subcategory && current !== g.category) html += `<div class="group-head">${esc(g.category)}</div>`;
    current = hasSubs ? g.category : null;
    const label = g.subcategory || (hasSubs ? "Zonder subcategorie" : g.category);
    html += itemFn(g, label, hasSubs);
  }
  return html;
}

/* ---------------- map ---------------- */
const map = L.map("map", { zoomSnap: 0.5 }).fitBounds(GERMANY_BOUNDS);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

// Dark green outline of Germany (data in germany.js).
if (window.GERMANY_BORDER) {
  L.geoJSON(window.GERMANY_BORDER, {
    interactive: false,
    style: { color: "#0b5d1e", weight: 3, opacity: 0.9, fill: false },
  }).addTo(map);
}

const layers = {
  circles: L.layerGroup().addTo(map),
  lines: L.layerGroup().addTo(map),
  markers: L.layerGroup().addTo(map),
};
const markerById = new Map();
// Visible leads per map position (pins exactly on top of each other, e.g. same municipality).
let stacks = new Map();
const stackKey = (l) => `${l.lat.toFixed(3)},${l.lng.toFixed(3)}`;
let draftMarker = null;

function renderMap() {
  layers.circles.clearLayers();
  layers.lines.clearLayers();
  layers.markers.clearLayers();
  markerById.clear();
  const radius = Number(state.settings.min_distance_km) * 1000;
  const visible = new Set(filteredLeads().map((l) => l.id));
  stacks = new Map();
  for (const lead of state.leads) {
    if (!hasGeo(lead) || !visible.has(lead.id)) continue;
    const key = stackKey(lead);
    if (!stacks.has(key)) stacks.set(key, []);
    stacks.get(key).push(lead);
  }

  for (const lead of state.leads) {
    if (!hasGeo(lead) || !visible.has(lead.id)) continue;
    const fill = colorOf(categoryOf(lead));
    const inConflict = state.conflictIds.has(lead.id);
    const selected = lead.id === state.selectedId;

    if (counts(lead)) {
      L.circle([lead.lat, lead.lng], {
        radius, color: inConflict ? CONFLICT_COLOR : fill, weight: 1,
        opacity: 0.5, fillOpacity: 0.05, interactive: false,
      }).addTo(layers.circles);
    }
    if (inConflict) {
      // Dashed red halo = too close to another lead.
      L.circleMarker([lead.lat, lead.lng], {
        radius: selected ? 17 : 14, color: CONFLICT_COLOR, weight: 2.5, dashArray: "4 3",
        fill: false, interactive: false,
      }).addTo(layers.markers);
    }
    // Fill = (sub)categorie, ring = status (column J).
    const marker = L.circleMarker([lead.lat, lead.lng], {
      radius: selected ? 11 : 8,
      color: statusOf(lead.status).color, weight: 4,
      fillColor: fill, fillOpacity: 1, bubblingMouseEvents: false,
    }).addTo(layers.markers);
    marker.bindTooltip(esc(lead.company), { direction: "top", offset: [0, -10] });
    marker.bindPopup(() => leadPopup(lead));
    marker.on("click", () => selectLead(lead.id, false));
    markerById.set(lead.id, marker);
  }

  // Small number next to pins that hide other visible leads at the same spot.
  for (const group of stacks.values()) {
    if (group.length < 2) continue;
    L.marker([group[0].lat, group[0].lng], {
      icon: L.divIcon({ className: "stack-count", html: String(group.length), iconSize: [16, 16], iconAnchor: [-6, 20] }),
      interactive: false, keyboard: false, zIndexOffset: 500,
    }).addTo(layers.markers);
  }

  const labelAlways = state.conflicts.length <= 25;
  for (const c of state.conflicts) {
    if (!visible.has(c.a.id) || !visible.has(c.b.id)) continue;
    const line = L.polyline([[c.a.lat, c.a.lng], [c.b.lat, c.b.lng]], {
      color: CONFLICT_COLOR, weight: 2.5, dashArray: "6 6", bubblingMouseEvents: false,
    }).addTo(layers.lines);
    line.bindTooltip(fmtKm(c.km), {
      permanent: labelAlways, direction: "center", className: "dist-label",
    });
  }
  applyLayerToggles();
}

function applyLayerToggles() {
  const toggle = (layer, on) => (on ? map.addLayer(layer) : map.removeLayer(layer));
  toggle(layers.circles, $("#showCircles").checked);
  toggle(layers.lines, $("#showLines").checked);
}

function nearListHtml(near, min) {
  return `<ul class="near-list">${near.map((n) =>
    `<li class="${n.km < min && counts(n.lead) ? "bad" : ""}">${esc(n.lead.company)} – ${fmtKm(n.km)}</li>`).join("")}</ul>`;
}

function statusBadge(status) {
  const info = statusOf(status);
  return `<span class="badge status-${esc(status)}" style="background:${info.color}">${esc(info.label)}</span>`;
}

function leadPopup(lead) {
  const near = nearestTo(lead.lat, lead.lng, lead.id, 3);
  const min = Number(state.settings.min_distance_km);
  const cat = categoryOf(lead);
  const others = (stacks.get(stackKey(lead)) || []).filter((l) => l.id !== lead.id);
  const div = document.createElement("div");
  div.className = "popup";
  div.innerHTML = `
    <h4>${esc(lead.company)}</h4>
    <p>${statusBadge(lead.status)} <span class="cat-chip"><i style="background:${colorOf(cat)}"></i>${esc(cat)}</span></p>
    <p>${esc([lead.city, lead.state].filter(Boolean).join(", "))}</p>
    ${lead.contact_name ? `<p>${esc(lead.contact_name)}${lead.phone ? " · " + esc(lead.phone) : ""}</p>` : ""}
    ${lead.status_info ? `<p class="muted">${esc(lead.status_info)}</p>` : ""}
    ${near.length ? `<strong>Dichtstbijzijnde leads</strong>${nearListHtml(near, min)}` : ""}
    <button class="btn small" type="button" data-open="${lead.id}">Lead openen</button>
    ${others.length ? `<div class="stack-list"><strong>Ook op deze plek (${others.length})</strong>
      ${others.map((o) => `<button type="button" class="stack-item" data-open="${o.id}">
        <i style="background:${colorOf(categoryOf(o))};border-color:${statusOf(o.status).color}"></i>${esc(o.company)}</button>`).join("")}
      </div>` : ""}`;
  div.querySelectorAll("[data-open]").forEach((btn) => btn.addEventListener("click", () =>
    openDrawer(state.leads.find((l) => l.id === Number(btn.dataset.open)))));
  return div;
}

// Clicking empty map space: check the location, or set the location while picking.
map.on("click", (e) => {
  const { lat, lng } = e.latlng;
  if (state.picking) {
    finishPick(lat, lng);
    return;
  }
  const near = nearestTo(lat, lng, null, 3);
  const min = Number(state.settings.min_distance_km);
  const tooClose = near.filter((n) => n.km < min && counts(n.lead));
  const div = document.createElement("div");
  div.className = "popup";
  div.innerHTML = `
    <h4>Deze locatie controleren</h4>
    ${near.length ? nearListHtml(near, min) : "<p>Nog geen leads op de kaart.</p>"}
    <p>${tooClose.length ? `<span class="bad">⚠ ${tooClose.length} lead(s) binnen ${min} km</span>`
      : `✓ Geen lead binnen ${min} km`}</p>
    <button class="btn small" type="button">+ Nieuwe lead hier</button>`;
  div.querySelector("button").addEventListener("click", () => {
    map.closePopup();
    openDrawer(null, { lat, lng });
  });
  L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
});

function renderLegend() {
  // Some categories (Beurs) are only in the category filter, not in the legend.
  const legendGroups = groupsInUse().filter((g) => !LeadStore.HIDDEN_IN_LEGEND.includes(g.category));
  $("#legendBody").innerHTML = `
    <div class="legend-title">Categorie (vulling)</div>
    ${legendGroups.length ? groupedHtml((g, label, sub) => `<label class="legend-item${sub ? " sub" : " single"}" title="Klik om de kleur te wijzigen">
        <input type="color" class="cat-color" data-cat="${esc(g.key)}" value="${colorOf(g.key)}">
        <span>${esc(label)} <span class="muted">(${g.n})</span></span></label>`, legendGroups)
      : `<div class="legend-item muted">Nog geen leads</div>`}
    <div class="legend-title">Status (rand)</div>
    ${Object.entries(STATUS_INFO).filter(([k]) => k !== "geen").map(([, s]) =>
      `<div class="legend-item"><i class="ring" style="border-color:${s.color}"></i>${esc(s.label)}</div>`).join("")}
    <div class="legend-title">Kaart</div>
    <div class="legend-item"><i class="halo"></i>Te dicht bij elkaar</div>
    <div class="legend-item"><i class="line"></i>Grens Duitsland</div>`;
  document.querySelectorAll(".cat-color").forEach((input) => input.addEventListener("change", async () => {
    try {
      state.settings = await api("settings", {
        method: "PUT", body: { category_colors: { [input.dataset.cat]: input.value } },
      });
      renderAll();
    } catch (err) { toast(err.message, true); }
  }));
}

/* ---------------- sidebar ---------------- */
function filteredLeads() {
  const q = $("#search").value.trim().toLowerCase();
  const { groups, statuses } = state.filter;
  return state.leads.filter((l) => {
    if (statuses.size && !statuses.has(l.status)) return false;
    if (groups.size && !groups.has(categoryOf(l))) return false;
    if (!q) return true;
    return [l.company, l.city, l.contact_name, l.state, l.email, l.category, l.subcategory, l.status_info,
      l.next_action, l.notes, l.demo_serre]
      .some((v) => (v || "").toLowerCase().includes(q));
  });
}

function sortedLeads(list) {
  const key = $("#sortBy").value;
  const byText = (k) => (a, b) => (a[k] || "").localeCompare(b[k] || "", "de", { sensitivity: "base" });
  const cmp = {
    category: (a, b) => Roadmap.compareGroups(a, b) || byText("company")(a, b),
    company: byText("company"),
    city: byText("city"),
    updated_at: (a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""),
    nearest: (a, b) => (state.nearest.get(a.id)?.km ?? Infinity) - (state.nearest.get(b.id)?.km ?? Infinity),
  }[key];
  return [...list].sort(cmp);
}

function renderFilters() {
  const { groups: selGroups, statuses: selStatuses } = state.filter;
  const perCategory = new Map();
  for (const g of groupsInUse()) {
    if (!perCategory.has(g.category)) perCategory.set(g.category, []);
    perCategory.get(g.category).push(g);
  }

  // Category filter: a checkbox per category (selects all its subcategories) and per subcategory.
  let html = "";
  for (const [category, groups] of perCategory) {
    const total = groups.reduce((n, g) => n + g.n, 0);
    const onlyCategory = groups.length === 1 && !groups[0].subcategory;
    if (onlyCategory) {
      const g = groups[0];
      html += `<label class="multi-cat"><input type="checkbox" data-group="${esc(g.key)}" ${selGroups.has(g.key) ? "checked" : ""}>
        <i class="swatch" style="background:${colorOf(g.key)}"></i>${esc(category)} <span class="muted">(${total})</span></label>`;
      continue;
    }
    const nSel = groups.filter((g) => selGroups.has(g.key)).length;
    html += `<label class="multi-cat"><input type="checkbox" data-category="${esc(category)}"
      ${nSel === groups.length ? "checked" : ""} ${nSel && nSel < groups.length ? "data-partial" : ""}>
      ${esc(category)} <span class="muted">(${total})</span></label>`;
    for (const g of groups) {
      html += `<label class="sub"><input type="checkbox" data-group="${esc(g.key)}" ${selGroups.has(g.key) ? "checked" : ""}>
        <i class="swatch" style="background:${colorOf(g.key)}"></i>${esc(g.subcategory || "Zonder subcategorie")}
        <span class="muted">(${g.n})</span></label>`;
    }
  }
  const catBox = $("#categoryFilter");
  catBox.querySelector(".multi-panel").innerHTML = html || `<p class="muted">Nog geen leads</p>`;
  catBox.querySelectorAll("[data-partial]").forEach((cb) => { cb.indeterminate = true; });
  catBox.querySelector("summary").textContent = selGroups.size === 0 ? "Alle categorieën"
    : selGroups.size === 1 ? [...selGroups][0] : `${selGroups.size} (sub)categorieën`;
  catBox.classList.toggle("active", selGroups.size > 0);

  const statusBox = $("#statusFilter");
  statusBox.querySelector(".multi-panel").innerHTML = Object.entries(STATUS_INFO).map(([k, s]) =>
    `<label><input type="checkbox" data-status="${k}" ${selStatuses.has(k) ? "checked" : ""}>
      <i class="swatch" style="background:${s.color}"></i>${esc(s.label)}
      <span class="muted">(${state.leads.filter((l) => l.status === k).length})</span></label>`).join("");
  statusBox.querySelector("summary").textContent = selStatuses.size === 0 ? "Alle statussen"
    : selStatuses.size === 1 ? STATUS_INFO[[...selStatuses][0]].label : `${selStatuses.size} statussen`;
  statusBox.classList.toggle("active", selStatuses.size > 0);
  updateFilterSummary();

  const allCategories = [...new Set([...LeadStore.TAXONOMY.map(([c]) => c), ...perCategory.keys()])]
    .filter((c) => c !== NO_CATEGORY);
  $("#categories").innerHTML = allCategories.map((c) => `<option value="${esc(c)}">`).join("");
}

function filtersActive() {
  return state.filter.groups.size + state.filter.statuses.size + ($("#search").value.trim() ? 1 : 0);
}

function updateFilterSummary() {
  const active = filtersActive();
  const shown = active ? filteredLeads().length : state.leads.length;
  $("#filterSummary").textContent = active ? `${shown} van ${state.leads.length} leads getoond` : "";
  $("#clearFilters").hidden = !active;
}

// A checkbox in one of the filter dropdowns changed.
function onFilterChange(e) {
  const cb = e.target;
  const { groups, statuses } = state.filter;
  if (cb.dataset.status) {
    cb.checked ? statuses.add(cb.dataset.status) : statuses.delete(cb.dataset.status);
  } else if (cb.dataset.category) {
    const keys = groupsInUse().filter((g) => g.category === cb.dataset.category).map((g) => g.key);
    keys.forEach((k) => (cb.checked ? groups.add(k) : groups.delete(k)));
  } else if (cb.dataset.group) {
    cb.checked ? groups.add(cb.dataset.group) : groups.delete(cb.dataset.group);
  }
  renderFilters();
  renderList();
  renderMap();
}

function clearFilters() {
  state.filter.groups.clear();
  state.filter.statuses.clear();
  $("#search").value = "";
  document.querySelectorAll(".multi").forEach((d) => { d.open = false; });
  map.closePopup();
  renderFilters();
  renderList();
  renderMap();
  map.fitBounds(GERMANY_BOUNDS);
}

function renderList() {
  const list = sortedLeads(filteredLeads());
  const min = Number(state.settings.min_distance_km);
  $("#leadCount").textContent = state.leads.length;
  if (!list.length) {
    $("#leadList").innerHTML = `<li class="empty">${state.leads.length
      ? "Geen leads gevonden met deze filters."
      : "Nog geen leads. Kies <b>Data → Importeren uit roadmap (Excel)</b>, klik op <b>+ Nieuwe lead</b> of klik op de kaart."}</li>`;
    return;
  }
  $("#leadList").innerHTML = list.map((l) => {
    const cat = categoryOf(l);
    const near = state.nearest.get(l.id);
    let nearHtml = "";
    if (!hasGeo(l)) nearHtml = `<div class="near nogeo">⚠ Geen locatie – open de lead om de locatie te kiezen</div>`;
    else if (near) {
      const bad = state.conflictIds.has(l.id) && near.km < min && counts(near.lead);
      nearHtml = `<div class="near ${bad ? "bad" : ""}">${bad ? "⚠ " : ""}Dichtstbij: ${esc(near.lead.company)} (${fmtKm(near.km)})</div>`;
    }
    return `<li class="lead-item ${l.id === state.selectedId ? "selected" : ""}" data-id="${l.id}">
      <span class="dot" style="background:${colorOf(cat)};border-color:${statusOf(l.status).color}"></span>
      <span class="name">${esc(l.company)}</span>
      ${statusBadge(l.status)}
      <div class="sub">${esc(cat)} · ${esc(l.city || "—")}${l.contact_name ? " · " + esc(l.contact_name) : ""}</div>
      ${l.next_action ? `<div class="sub next">➜ ${esc(l.next_action)}${l.next_action_date ? " (" + esc(l.next_action_date.split("-").reverse().join("/")) + ")" : ""}</div>` : ""}
      ${nearHtml}
    </li>`;
  }).join("");
}

function renderConflicts() {
  const n = state.conflicts.length;
  const min = Number(state.settings.min_distance_km);
  const countEl = $("#conflictCount");
  countEl.textContent = n;
  countEl.classList.toggle("alert", n > 0);
  const { excluded_categories: excluded, ignore_statuses: ignored } = state.settings;
  $("#conflictHint").innerHTML = `
    <p>Paren van leads die minder dan <b>${min} km</b> van elkaar liggen (in vogelvlucht).</p>
    <details class="check-settings">
      <summary>Wie telt mee in de afstandscheck?</summary>
      <div class="check-group"><b>Categorieën</b>
        ${groupedHtml((g, label, sub) => `<label class="${sub ? "sub" : ""}"><input type="checkbox" class="countCategory" value="${esc(g.key)}"
          ${excluded.includes(g.key) ? "" : "checked"}> <i class="swatch" style="background:${colorOf(g.key)}"></i>${esc(label)}</label>`)}
      </div>
      <div class="check-group"><b>Statussen</b>
        ${Object.entries(STATUS_INFO).map(([k, s]) => `<label><input type="checkbox" class="countStatus" value="${k}"
          ${ignored.includes(k) ? "" : "checked"}> ${esc(s.label)}</label>`).join("")}
      </div>
    </details>`;
  document.querySelectorAll(".countCategory, .countStatus").forEach((cb) => cb.addEventListener("change", saveCheckSettings));
  $("#conflictList").innerHTML = n
    ? state.conflicts.map((c, i) => `<li class="conflict-item" data-idx="${i}">
        <span class="dist">${fmtKm(c.km)}</span>
        <div class="pair">${esc(c.a.company)} <span>(${esc(c.a.city || "?")}, ${esc(categoryOf(c.a))})</span></div>
        <div class="pair">↔ ${esc(c.b.company)} <span>(${esc(c.b.city || "?")}, ${esc(categoryOf(c.b))})</span></div>
      </li>`).join("")
    : `<li class="empty">✓ Geen leads die dichter dan ${min} km bij elkaar liggen.</li>`;
}

async function saveCheckSettings() {
  const unchecked = (cls) => [...document.querySelectorAll(`.${cls}`)].filter((cb) => !cb.checked).map((cb) => cb.value);
  // Keep exclusions for categories that currently have no leads.
  const shown = new Set(categoriesInUse().map(([c]) => c));
  const excluded = [...state.settings.excluded_categories.filter((c) => !shown.has(c)), ...unchecked("countCategory")];
  try {
    state.settings = await api("settings", {
      method: "PUT", body: { excluded_categories: excluded, ignore_statuses: unchecked("countStatus") },
    });
    renderAll();
    $(".check-settings").open = true;
  } catch (err) { toast(err.message, true); }
}

function renderAll() {
  computeDistances();
  renderFilters();
  renderList();
  renderConflicts();
  renderLegend();
  renderMap();
}

function selectLead(id, pan = true) {
  state.selectedId = id;
  renderList();
  renderMap();
  const lead = state.leads.find((l) => l.id === id);
  const item = document.querySelector(`.lead-item[data-id="${id}"]`);
  if (item) item.scrollIntoView({ block: "nearest" });
  if (pan && lead && hasGeo(lead)) {
    map.setView([lead.lat, lead.lng], Math.max(map.getZoom(), 9));
    markerById.get(id)?.openPopup();
  }
}

async function reload() {
  const [leads, settings] = await Promise.all([api("leads"), api("settings")]);
  state.leads = leads;
  state.settings = settings;
  $("#minDistance").value = settings.min_distance_km;
  renderAll();
}

/* ---------------- drawer / form ---------------- */
const form = $("#leadForm");

function fillSelect(sel, entries, current) {
  sel.innerHTML = entries.map(([v, label]) =>
    `<option value="${esc(v)}" ${v === current ? "selected" : ""}>${esc(label)}</option>`).join("");
}

// Suggest the subcategories of the chosen category (taxonomy + ones already in use).
function updateSubcategoryOptions() {
  const cat = form.category.value.trim();
  const known = (LeadStore.TAXONOMY.find(([c]) => c.toLowerCase() === cat.toLowerCase()) || [null, []])[1];
  const used = state.leads.filter((l) => (l.category || "").toLowerCase() === cat.toLowerCase() && l.subcategory)
    .map((l) => l.subcategory);
  $("#subcategories").innerHTML = [...new Set([...known, ...used])].map((s) => `<option value="${esc(s)}">`).join("");
}

function openDrawer(lead, coords = null) {
  state.editing = lead;
  form.reset();
  $("#formError").hidden = true;
  $("#geoResults").hidden = true;
  $("#drawerTitle").textContent = lead ? lead.company : "Nieuwe lead";
  fillSelect(form.status, Object.entries(STATUS_INFO).map(([k, s]) => [k, s.label]), lead?.status || "gesprek");
  for (const el of form.elements) {
    if (!el.name || el.name === "status") continue;
    el.value = lead && lead[el.name] !== null && lead[el.name] !== undefined ? lead[el.name] : "";
  }
  updateSubcategoryOptions();
  if (coords) setCoords(coords.lat, coords.lng);
  else updateCoordsUI();
  $("#deleteLead").hidden = !lead;
  $("#activitySection").hidden = !lead;
  if (lead) loadActivities(lead.id);
  $("#drawer").hidden = false;
  state.drawerOpenedAt = Date.now();
  if (!lead) form.company.focus();
}

function closeDrawer() {
  $("#drawer").hidden = true;
  state.editing = null;
  removeDraftMarker();
}

function currentCoords() {
  const lat = parseFloat(form.lat.value), lng = parseFloat(form.lng.value);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

// auto = true when the location comes from the municipality name, not from the user.
function setCoords(lat, lng, auto = false) {
  form.lat.value = lat.toFixed(6);
  form.lng.value = lng.toFixed(6);
  form.geo_auto.value = auto ? "1" : "";
  updateCoordsUI();
}

function updateCoordsUI() {
  const c = currentCoords();
  $("#coordText").textContent = c ? `📍 ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}` : "Nog geen locatie";
  $("#geoAutoNote").hidden = !(c && form.geo_auto.value === "1");
  const box = $("#nearbyBox");
  if (!c) { box.hidden = true; removeDraftMarker(); return; }
  const min = Number(state.settings.min_distance_km);
  const near = nearestTo(c.lat, c.lng, state.editing?.id, 5);
  box.hidden = false;
  $("#nearbyList").innerHTML = near.length
    ? near.map((n) => `<li class="${n.km < min && counts(n.lead) ? "bad" : ""}">
        ${esc(n.lead.company)} (${esc(n.lead.city || "?")}) – ${fmtKm(n.km)}
        ${n.km < min && counts(n.lead) ? " ⚠ te dichtbij" : ""}</li>`).join("")
    : "<li>Nog geen andere leads op de kaart.</li>";
  showDraftMarker(c);
}

function showDraftMarker({ lat, lng }) {
  if (!draftMarker) {
    draftMarker = L.marker([lat, lng], { draggable: true, zIndexOffset: 1000 }).addTo(map);
    draftMarker.bindTooltip("Locatie (versleep om aan te passen)");
    draftMarker.on("dragend", () => {
      const p = draftMarker.getLatLng();
      setCoords(p.lat, p.lng);
    });
  } else {
    draftMarker.setLatLng([lat, lng]);
  }
}

function removeDraftMarker() {
  if (draftMarker) { map.removeLayer(draftMarker); draftMarker = null; }
}

async function geocodeAddress() {
  const street = form.street.value.trim(), plz = form.postal_code.value.trim();
  const city = form.city.value.trim(), stateName = form.state.value.trim();
  if (!street && !plz && !city) { toast("Vul eerst een gemeente, postcode of adres in.", true); return; }
  const btn = $("#geocodeBtn");
  btn.disabled = true;
  btn.textContent = "Zoeken…";
  try {
    let results;
    if (street || plz) {
      results = await geocode({ q: [street, [plz, city].filter(Boolean).join(" ")].filter(Boolean).join(", ") });
    } else {
      const r = await geocodePlace(city, stateName);
      results = r ? [r] : [];
    }
    const ul = $("#geoResults");
    if (!results.length) {
      ul.innerHTML = "<li>Niets gevonden. Probeer alleen de gemeente, of gebruik “Kies op de kaart”.</li>";
    } else {
      ul.innerHTML = results.map((r, i) => `<li data-i="${i}">${esc(r.label)}</li>`).join("");
      ul.querySelectorAll("li[data-i]").forEach((li) => li.addEventListener("click", () => {
        const r = results[Number(li.dataset.i)];
        setCoords(r.lat, r.lng, !street && !plz);
        for (const k of ["street", "postal_code", "city"]) {
          if (!form[k].value.trim() && r[k]) form[k].value = r[k];
        }
        ul.hidden = true;
        map.setView([r.lat, r.lng], 10);
      }));
      if (results.length === 1) ul.querySelector("li").click();
    }
    ul.hidden = results.length === 1;
  } catch (err) {
    toast(err.message + " – je kunt ook “Kies op de kaart” gebruiken.", true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Zoek op de kaart";
  }
}

function startPick() {
  state.picking = true;
  $("#drawer").hidden = true;
  $("#pickBanner").hidden = false;
  document.querySelector(".map-wrap").classList.add("picking");
  map.closePopup();
}

function finishPick(lat, lng) {
  stopPick();
  if (lat !== undefined) setCoords(lat, lng);
}

function stopPick() {
  state.picking = false;
  $("#pickBanner").hidden = true;
  document.querySelector(".map-wrap").classList.remove("picking");
  $("#drawer").hidden = false;
}

async function saveLead(e) {
  e.preventDefault();
  const data = {};
  for (const el of form.elements) if (el.name) data[el.name] = el.value;
  const c = currentCoords();
  data.lat = c ? c.lat : null;
  data.lng = c ? c.lng : null;
  try {
    const saved = state.editing
      ? await api(`leads/${state.editing.id}`, { method: "PUT", body: data })
      : await api("leads", { method: "POST", body: data });
    closeDrawer();
    await reload();
    selectLead(saved.id);
    const conflicts = state.conflicts.filter((x) => x.a.id === saved.id || x.b.id === saved.id);
    toast(conflicts.length
      ? `Opgeslagen. ⚠ ${saved.company} ligt binnen ${state.settings.min_distance_km} km van ${conflicts.length} andere lead(s).`
      : `${saved.company} opgeslagen.`, conflicts.length > 0);
  } catch (err) {
    $("#formError").textContent = err.message;
    $("#formError").hidden = false;
  }
}

async function deleteLead() {
  const lead = state.editing;
  if (!lead || !confirm(`"${lead.company}" en het activiteitenlog verwijderen? Dit kan niet ongedaan worden.`)) return;
  try {
    await api(`leads/${lead.id}`, { method: "DELETE" });
    closeDrawer();
    if (state.selectedId === lead.id) state.selectedId = null;
    await reload();
    toast(`${lead.company} verwijderd.`);
  } catch (err) { toast(err.message, true); }
}

/* ---------------- activities ---------------- */
const SYSTEM_TYPES = new Set(["system", "status"]);
const TYPE_LABEL = { system: "Systeem", status: "Status", note: "Notitie" };

async function loadActivities(leadId) {
  const list = $("#activityList");
  list.innerHTML = "";
  try {
    const items = await api(`leads/${leadId}/activities`);
    if (state.editing?.id !== leadId) return;
    list.innerHTML = items.map((a) => `<li class="${SYSTEM_TYPES.has(a.type) ? "system" : ""}">
      <div class="text"><span class="atype">${esc(TYPE_LABEL[a.type] || a.type)}</span>${esc(a.text)}</div>
      <div class="meta">${esc(new Date(a.created_at).toLocaleString("nl-BE"))}</div>
      ${SYSTEM_TYPES.has(a.type) ? "" : `<button class="del" type="button" data-id="${a.id}" title="Verwijderen">✕</button>`}
    </li>`).join("") || `<li class="meta">Nog geen activiteiten.</li>`;
    list.querySelectorAll(".del").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Deze regel verwijderen?")) return;
      await api(`activities/${b.dataset.id}`, { method: "DELETE" });
      loadActivities(leadId);
    }));
  } catch (err) { toast(err.message, true); }
}

async function addActivity() {
  const text = $("#activityText").value.trim();
  if (!text || !state.editing) return;
  try {
    await api(`leads/${state.editing.id}/activities`, {
      method: "POST", body: { type: $("#activityType").value, text },
    });
    $("#activityText").value = "";
    loadActivities(state.editing.id);
  } catch (err) { toast(err.message, true); }
}

/* ---------------- Excel import ---------------- */
function requireExcel() {
  if (!window.ExcelJS) throw new Error("De Excel-module is nog niet geladen. Probeer het over enkele seconden opnieuw.");
  return window.ExcelJS;
}

async function importRoadmap(file) {
  try {
    const ExcelJS = requireExcel();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const parsed = Roadmap.readRoadmap(wb);
    const { red, nocolor } = parsed.skipped;
    const question = `${parsed.leads.length} leads gevonden in "${file.name}" ` +
      `(${parsed.leads.filter((l) => l.data.status === "samenwerking").length} groen, ` +
      `${parsed.leads.filter((l) => l.data.status === "gesprek").length} oranje).\n` +
      `${red.length} rode rij(en) en ${nocolor.length} rij(en) zonder kleur worden overgeslagen.\n\n` +
      "Bestaande leads met dezelfde naam worden bijgewerkt. Doorgaan?";
    if (!confirm(question)) return;
    const res = store.importLeads(parsed.leads);
    await reload();
    if (nocolor.length) console.warn("Overgeslagen (geen kleur in kolom Status):\n" + nocolor.join("\n"));
    if (res.errors.length) console.warn("Importfouten:\n" + res.errors.join("\n"));
    toast(`Geïmporteerd: ${res.created} nieuw, ${res.updated} bijgewerkt` +
      (res.errors.length ? `, ${res.errors.length} fout(en) – zie console` : "") + ". Locaties worden nu gezocht…",
      res.errors.length > 0);
    geocodeMissing();
  } catch (err) { toast(err.message, true); }
}

// Place a pin for every lead that has a municipality but no location yet.
async function geocodeMissing() {
  if (state.geocoding) return;
  const todo = state.leads.filter((l) => !hasGeo(l) && l.city);
  const noCity = state.leads.filter((l) => !hasGeo(l) && !l.city);
  if (!todo.length) {
    toast(noCity.length ? `${noCity.length} lead(s) zonder gemeente: open ze om de locatie op de kaart te kiezen.`
      : "Alle leads hebben al een locatie.");
    return;
  }
  const job = (state.geocoding = { stop: false });
  const box = $("#geoProgress");
  box.hidden = false;
  const notFound = [];
  let found = 0;
  try {
    for (let i = 0; i < todo.length && !job.stop; i++) {
      const lead = todo[i];
      $("#geoProgressText").textContent = `Locaties zoeken… ${i + 1}/${todo.length}: ${lead.city}`;
      const r = await geocodePlace(lead.city, lead.state);
      if (!r) { notFound.push(`${lead.company} (${lead.city})`); continue; }
      await api(`leads/${lead.id}`, { method: "PUT", body: { lat: r.lat, lng: r.lng, geo_auto: "1" } });
      found++;
      if (found % 5 === 0) await reload();
    }
    await reload();
    const parts = [`${found} locatie(s) gevonden`];
    if (notFound.length) parts.push(`niet gevonden: ${notFound.join(", ")}`);
    if (noCity.length) parts.push(`${noCity.length} zonder gemeente`);
    toast(parts.join(" · ") + (notFound.length || noCity.length
      ? ". Open die leads om de locatie op de kaart te kiezen." : "."), notFound.length > 0, 12000);
  } catch (err) {
    await reload();
    toast(`${err.message}. ${found} locatie(s) gevonden; probeer later opnieuw via Data → Ontbrekende locaties zoeken.`, true, 12000);
  } finally {
    state.geocoding = null;
    box.hidden = true;
  }
}

/* ---------------- Excel export ---------------- */
function openExportDialog() {
  const cats = categoriesInUse();
  $("#exportCategories").innerHTML = cats.length
    ? groupedHtml((g, label, sub) => `<label class="${sub ? "sub" : ""}"><input type="checkbox" name="cat" value="${esc(g.key)}" checked>
      <i class="swatch" style="background:${colorOf(g.key)}"></i>${esc(label)} <span class="muted">(${g.n})</span></label>`)
    : `<p class="muted">Nog geen leads.</p>`;
  $("#exportStatuses").innerHTML = Object.entries(STATUS_INFO).map(([k, s]) => `<label><input type="checkbox" name="status" value="${k}"
    ${k === "geen" ? "" : "checked"}> <i class="swatch" style="background:${s.color}"></i>${esc(s.label)}</label>`).join("");
  updateExportCount();
  $("#exportDialog").hidden = false;
}

function exportSelection() {
  const checked = (name) => new Set([...document.querySelectorAll(`#exportForm input[name=${name}]:checked`)].map((i) => i.value));
  const cats = checked("cat"), statuses = checked("status");
  return state.leads.filter((l) => cats.has(categoryOf(l)) && statuses.has(l.status));
}

function updateExportCount() {
  const n = exportSelection().length;
  $("#exportCount").textContent = `${n} lead(s) geselecteerd.`;
}

async function exportExcel(e) {
  e.preventDefault();
  try {
    const leads = exportSelection();
    if (!leads.length) { toast("Selecteer minstens één lead.", true); return; }
    const layout = $("#exportForm").layout.value;
    const wb = Roadmap.buildRoadmap(requireExcel(), leads, { groupBy: layout === "single" ? null : layout });
    const buffer = await wb.xlsx.writeBuffer();
    const cats = new Set(leads.map((l) => l.category || NO_CATEGORY));
    const groups = new Set(leads.map(categoryOf));
    const name = groups.size === 1 ? [...groups][0] : cats.size === 1 ? [...cats][0] : "";
    const suffix = name ? "_" + name.replace(/[^\w\-]+/g, "-") : "";
    downloadFile(`ROADMAP_ACD_DUITSLAND${suffix}_${today()}.xlsx`,
      new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    $("#exportDialog").hidden = true;
    toast(`Excel met ${leads.length} lead(s) gedownload.`);
  } catch (err) { toast(err.message, true); }
}

/* ---------------- backup ---------------- */
async function restoreBackup(file) {
  if (!confirm("Een back-up terugzetten vervangt ALLE leads in deze browser door de back-up. Doorgaan?")) return;
  try {
    const res = store.importBackup(await file.text());
    state.selectedId = null;
    await reload();
    toast(`Back-up teruggezet: ${res.leads} leads, ${res.activities} activiteiten.`);
  } catch (err) { toast(err.message, true); }
}

async function clearAllLeads() {
  const n = state.leads.length;
  if (!n) { toast("Er zijn geen leads om te verwijderen."); return; }
  if (!confirm(`Alle ${n} leads en hun activiteitenlog verwijderen?\n\n` +
    "Er wordt eerst automatisch een back-up gedownload, zodat je alles kunt terugzetten. " +
    "Je instellingen (kleuren, afstandscheck) blijven behouden.")) return;
  try {
    downloadFile(`acd-leads-backup-${today()}.json`, store.exportBackup(), "application/json");
    const { removed } = store.clearLeads();
    state.selectedId = null;
    closeDrawer();
    await reload();
    toast(`${removed} leads verwijderd. Back-up gedownload. Je kunt nu opnieuw importeren via Data → Importeren uit roadmap.`, false, 8000);
  } catch (err) { toast(err.message, true); }
}

/* ---------------- wiring ---------------- */
function init() {
  ["#search", "#sortBy"].forEach((sel) =>
    $(sel).addEventListener("input", () => { renderList(); renderMap(); updateFilterSummary(); }));
  ["#categoryFilter", "#statusFilter"].forEach((sel) => $(sel).addEventListener("change", onFilterChange));
  $("#clearFilters").addEventListener("click", clearFilters);
  // Close a filter dropdown when clicking elsewhere, and keep only one open.
  document.addEventListener("click", (e) => {
    document.querySelectorAll(".multi").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  });

  $("#leadList").addEventListener("click", (e) => {
    const item = e.target.closest(".lead-item");
    if (!item) return;
    const id = Number(item.dataset.id);
    const lead = state.leads.find((l) => l.id === id);
    if (state.selectedId === id || !hasGeo(lead)) openDrawer(lead);
    else selectLead(id);
  });

  $("#conflictList").addEventListener("click", (e) => {
    const item = e.target.closest(".conflict-item");
    if (!item) return;
    const c = state.conflicts[Number(item.dataset.idx)];
    map.fitBounds([[c.a.lat, c.a.lng], [c.b.lat, c.b.lng]], { padding: [80, 80], maxZoom: 11 });
  });

  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = p.id !== "tab-" + tab.dataset.tab; });
  }));

  $("#minDistance").addEventListener("change", async (e) => {
    try {
      state.settings = await api("settings", { method: "PUT", body: { min_distance_km: e.target.value } });
      renderAll();
      if (!$("#drawer").hidden) updateCoordsUI();
    } catch (err) {
      toast(err.message, true);
      e.target.value = state.settings.min_distance_km;
    }
  });

  // Always start with circles and lines off (also after a refresh that restores form state).
  $("#showCircles").checked = false;
  $("#showLines").checked = false;
  $("#showCircles").addEventListener("change", applyLayerToggles);
  $("#showLines").addEventListener("change", applyLayerToggles);

  $("#newLeadBtn").addEventListener("click", () => openDrawer(null));
  $("#closeDrawer").addEventListener("click", closeDrawer);
  $("#cancelEdit").addEventListener("click", closeDrawer);
  $("#drawer").addEventListener("click", (e) => {
    // Ignore the second click of a double-click that just opened the drawer.
    if (e.target.id === "drawer" && Date.now() - state.drawerOpenedAt > 500) closeDrawer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.picking) stopPick();
    else if (!$("#exportDialog").hidden) $("#exportDialog").hidden = true;
    else if (!$("#drawer").hidden) closeDrawer();
  });
  form.addEventListener("submit", saveLead);
  form.category.addEventListener("input", updateSubcategoryOptions);
  $("#deleteLead").addEventListener("click", deleteLead);
  $("#geocodeBtn").addEventListener("click", geocodeAddress);
  $("#pickBtn").addEventListener("click", startPick);
  $("#cancelPick").addEventListener("click", stopPick);
  $("#addActivity").addEventListener("click", addActivity);
  $("#activityText").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addActivity(); }
  });

  const menu = document.querySelector(".menu");
  menu.addEventListener("click", (e) => { if (e.target.closest(".menu-list button")) menu.open = false; });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.open = false; });

  $("#exportBtn").addEventListener("click", openExportDialog);
  $("#exportForm").addEventListener("submit", exportExcel);
  $("#exportForm").addEventListener("change", updateExportCount);
  $("#exportForm").addEventListener("click", (e) => {
    const link = e.target.closest("[data-check]");
    if (!link) return;
    e.preventDefault();
    const mode = link.dataset.check.split(":")[1];
    document.querySelectorAll("#exportCategories input").forEach((cb) => {
      cb.checked = mode === "all" || (mode === "dealers" && isDealer(cb.value));
    });
    updateExportCount();
  });
  $("#closeExport").addEventListener("click", () => { $("#exportDialog").hidden = true; });
  $("#cancelExport").addEventListener("click", () => { $("#exportDialog").hidden = true; });

  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (e) => {
    if (e.target.files[0]) importRoadmap(e.target.files[0]);
    e.target.value = "";
  });
  $("#geocodeMissingBtn").addEventListener("click", geocodeMissing);
  $("#geoStop").addEventListener("click", () => { if (state.geocoding) state.geocoding.stop = true; });

  $("#backupBtn").addEventListener("click", () =>
    downloadFile(`acd-leads-backup-${today()}.json`, store.exportBackup(), "application/json"));
  $("#restoreBtn").addEventListener("click", () => $("#restoreFile").click());
  $("#clearBtn").addEventListener("click", clearAllLeads);
  $("#restoreFile").addEventListener("change", (e) => {
    if (e.target.files[0]) restoreBackup(e.target.files[0]);
    e.target.value = "";
  });

  if (window.innerWidth < 800) $("#legend").open = false;
  if (!store.persistent()) {
    toast("Je browser blokkeert lokale opslag: leads gaan verloren als je deze pagina sluit. " +
      "Download een back-up voor je afsluit.", true, 15000);
  }

  reload().catch((err) => toast("Leads laden mislukt: " + err.message, true));
}

init();
