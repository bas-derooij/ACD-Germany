/* ACD Germany – dealer lead manager (frontend) */
"use strict";

const STATUS_INFO = {
  new:         { label: "New",            color: "#3b82f6" },
  contacted:   { label: "Contacted",      color: "#06b6d4" },
  meeting:     { label: "Meeting planned", color: "#8b5cf6" },
  negotiation: { label: "Negotiation",    color: "#f59e0b" },
  dealer:      { label: "Dealer (signed)", color: "#16a34a" },
  on_hold:     { label: "On hold",        color: "#94a3b8" },
  rejected:    { label: "Rejected",       color: "#475569" },
};
const PRIORITY_LABEL = { low: "Low", medium: "Medium", high: "High" };
const GERMANY_BOUNDS = [[47.2, 5.8], [55.1, 15.1]];

const state = {
  leads: [],
  settings: { min_distance_km: 50, ignore_statuses: ["rejected"] },
  conflicts: [],
  nearest: new Map(),     // lead id -> { lead, km }
  conflictIds: new Set(), // ids of leads involved in at least one conflict
  selectedId: null,
  editing: null,          // lead being edited (null = new lead)
  picking: false,
  drawerOpenedAt: 0,
};

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtKm = (km) => (km < 10 ? km.toFixed(1) : Math.round(km)) + " km";
const hasGeo = (l) => l.lat !== null && l.lat !== undefined && l.lng !== null && l.lng !== undefined;
const statusOf = (s) => STATUS_INFO[s] || { label: s, color: "#999" };

/* ---------------- API ---------------- */
// All data lives in this browser (localStorage), see store.js.
let browserStorage = null;
try { browserStorage = window.localStorage; } catch (e) { /* blocked */ }
const store = LeadStore.createStore(browserStorage);

function api(path, options = {}) {
  return store.request(options.method || "GET", path, options.body);
}

// Address lookup via OpenStreetMap Nominatim (max. 1 request per second).
const geocodeCache = new Map();
let lastGeocodeAt = 0;
async function geocode(query) {
  if (geocodeCache.has(query)) return geocodeCache.get(query);
  const wait = 1000 - (Date.now() - lastGeocodeAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocodeAt = Date.now();
  const params = new URLSearchParams({
    q: query, format: "jsonv2", addressdetails: "1", limit: "5",
    countrycodes: "de", "accept-language": "de",
  });
  let res;
  try {
    res = await fetch("https://nominatim.openstreetmap.org/search?" + params);
  } catch (e) {
    throw new Error("Address lookup is not reachable (no internet or blocked by your network)");
  }
  if (!res.ok) throw new Error(`Address lookup failed (${res.status})`);
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
  geocodeCache.set(query, results);
  return results;
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
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

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3000);
}

/* ---------------- distance logic ---------------- */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function counts(lead) {
  return !state.settings.ignore_statuses.includes(lead.status);
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

/* ---------------- map ---------------- */
const map = L.map("map", { zoomSnap: 0.5 }).fitBounds(GERMANY_BOUNDS);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const layers = {
  circles: L.layerGroup().addTo(map),
  lines: L.layerGroup().addTo(map),
  markers: L.layerGroup().addTo(map),
};
const markerById = new Map();
let draftMarker = null;

function renderMap() {
  layers.circles.clearLayers();
  layers.lines.clearLayers();
  layers.markers.clearLayers();
  markerById.clear();
  const radius = Number(state.settings.min_distance_km) * 1000;
  const visible = new Set(filteredLeads().map((l) => l.id));

  for (const lead of state.leads) {
    if (!hasGeo(lead) || !visible.has(lead.id)) continue;
    const info = statusOf(lead.status);
    const inConflict = state.conflictIds.has(lead.id);

    if (counts(lead)) {
      L.circle([lead.lat, lead.lng], {
        radius, color: inConflict ? "#c62828" : info.color, weight: 1,
        opacity: 0.5, fillOpacity: 0.06, interactive: false,
      }).addTo(layers.circles);
    }

    const marker = L.circleMarker([lead.lat, lead.lng], {
      radius: lead.id === state.selectedId ? 11 : 8,
      color: inConflict ? "#c62828" : "#ffffff",
      weight: inConflict ? 3 : 2,
      fillColor: info.color, fillOpacity: 1, bubblingMouseEvents: false,
    }).addTo(layers.markers);
    marker.bindTooltip(esc(lead.company), { direction: "top", offset: [0, -8] });
    marker.bindPopup(() => leadPopup(lead));
    marker.on("click", () => selectLead(lead.id, false));
    markerById.set(lead.id, marker);
  }

  const labelAlways = state.conflicts.length <= 25;
  for (const c of state.conflicts) {
    if (!visible.has(c.a.id) || !visible.has(c.b.id)) continue;
    const line = L.polyline([[c.a.lat, c.a.lng], [c.b.lat, c.b.lng]], {
      color: "#c62828", weight: 2.5, dashArray: "6 6", bubblingMouseEvents: false,
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

function leadPopup(lead) {
  const info = statusOf(lead.status);
  const near = nearestTo(lead.lat, lead.lng, lead.id, 3);
  const min = Number(state.settings.min_distance_km);
  const div = document.createElement("div");
  div.className = "popup";
  div.innerHTML = `
    <h4>${esc(lead.company)}</h4>
    <p><span class="badge" style="background:${info.color}">${esc(info.label)}</span></p>
    <p>${esc([lead.street, [lead.postal_code, lead.city].filter(Boolean).join(" ")].filter(Boolean).join(", "))}</p>
    ${lead.contact_name ? `<p>${esc(lead.contact_name)}${lead.phone ? " · " + esc(lead.phone) : ""}</p>` : ""}
    ${near.length ? `<strong>Nearest leads</strong><ul class="near-list">${near.map((n) =>
      `<li class="${n.km < min ? "bad" : ""}">${esc(n.lead.company)} – ${fmtKm(n.km)}</li>`).join("")}</ul>` : ""}
    <button class="btn small" type="button">Open lead</button>`;
  div.querySelector("button").addEventListener("click", () => openDrawer(lead));
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
  const div = document.createElement("div");
  div.className = "popup";
  const tooClose = near.filter((n) => n.km < min && counts(n.lead));
  div.innerHTML = `
    <h4>Check this location</h4>
    ${near.length ? `<ul class="near-list">${near.map((n) =>
      `<li class="${n.km < min ? "bad" : ""}">${esc(n.lead.company)} – ${fmtKm(n.km)}</li>`).join("")}</ul>` : "<p>No leads on the map yet.</p>"}
    <p>${tooClose.length ? `<span class="bad">⚠ ${tooClose.length} lead(s) within ${min} km</span>`
      : `✓ No lead within ${min} km`}</p>
    <button class="btn small" type="button">+ New lead here</button>`;
  div.querySelector("button").addEventListener("click", () => {
    map.closePopup();
    openDrawer(null, { lat, lng });
  });
  L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
});

function renderLegend() {
  $("#legend").innerHTML = Object.values(STATUS_INFO)
    .map((s) => `<div class="legend-item"><i style="background:${s.color}"></i>${esc(s.label)}</div>`)
    .join("") + `<div class="legend-item"><i style="background:#fff;border:3px solid #c62828;width:13px;height:13px"></i>Too close</div>`;
}

/* ---------------- sidebar ---------------- */
function filteredLeads() {
  const q = $("#search").value.trim().toLowerCase();
  const status = $("#statusFilter").value;
  const prio = $("#priorityFilter").value;
  return state.leads.filter((l) => {
    if (status && l.status !== status) return false;
    if (prio && l.priority !== prio) return false;
    if (!q) return true;
    return [l.company, l.city, l.contact_name, l.postal_code, l.state, l.email, l.brands, l.notes]
      .some((v) => (v || "").toLowerCase().includes(q));
  });
}

function sortedLeads(list) {
  const key = $("#sortBy").value;
  const byText = (k) => (a, b) => (a[k] || "").localeCompare(b[k] || "", "de", { sensitivity: "base" });
  const cmp = {
    company: byText("company"),
    city: byText("city"),
    postal_code: byText("postal_code"),
    updated_at: (a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""),
    nearest: (a, b) => (state.nearest.get(a.id)?.km ?? Infinity) - (state.nearest.get(b.id)?.km ?? Infinity),
  }[key];
  return [...list].sort(cmp);
}

function renderList() {
  const list = sortedLeads(filteredLeads());
  const min = Number(state.settings.min_distance_km);
  $("#leadCount").textContent = state.leads.length;
  if (!list.length) {
    $("#leadList").innerHTML = `<li class="empty">${state.leads.length
      ? "No leads match your filters."
      : "No leads yet. Click <b>+ New lead</b> or click anywhere on the map to start."}</li>`;
    return;
  }
  $("#leadList").innerHTML = list.map((l) => {
    const info = statusOf(l.status);
    const near = state.nearest.get(l.id);
    let nearHtml;
    if (!hasGeo(l)) nearHtml = `<div class="near nogeo">⚠ No location set</div>`;
    else if (near) {
      const bad = state.conflictIds.has(l.id) && near.km < min && counts(near.lead);
      nearHtml = `<div class="near ${bad ? "bad" : ""}">${bad ? "⚠ " : ""}Closest: ${esc(near.lead.company)} (${fmtKm(near.km)})</div>`;
    } else nearHtml = "";
    const place = [l.postal_code, l.city].filter(Boolean).join(" ");
    return `<li class="lead-item ${l.id === state.selectedId ? "selected" : ""}" data-id="${l.id}">
      <span class="dot" style="background:${info.color}"></span>
      <span class="name">${esc(l.company)}</span>
      <span class="badge" style="background:${info.color}">${esc(info.label)}</span>
      <div class="sub">${esc(place || "—")}${l.contact_name ? " · " + esc(l.contact_name) : ""}
        ${l.priority === "high" ? ' · <span class="prio-high">High priority</span>' : ""}
        ${l.next_action_date ? " · Next: " + esc(l.next_action_date) : ""}</div>
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
  const ignored = state.settings.ignore_statuses;
  $("#conflictHint").innerHTML = `
    Pairs of leads that are less than <b>${min} km</b> apart (straight-line distance).
    <br><br>Ignore these statuses in the check:<br>
    ${Object.entries(STATUS_INFO).map(([k, s]) => `<label style="display:inline-block;margin:4px 8px 0 0">
      <input type="checkbox" class="ignoreStatus" value="${k}" ${ignored.includes(k) ? "checked" : ""}> ${esc(s.label)}</label>`).join("")}`;
  document.querySelectorAll(".ignoreStatus").forEach((cb) => cb.addEventListener("change", saveIgnoreStatuses));
  $("#conflictList").innerHTML = n
    ? state.conflicts.map((c, i) => `<li class="conflict-item" data-idx="${i}">
        <span class="dist">${fmtKm(c.km)}</span>
        <div class="pair">${esc(c.a.company)} <span>(${esc(c.a.city || "?")}, ${esc(statusOf(c.a.status).label)})</span></div>
        <div class="pair">↔ ${esc(c.b.company)} <span>(${esc(c.b.city || "?")}, ${esc(statusOf(c.b.status).label)})</span></div>
      </li>`).join("")
    : `<li class="empty">✓ No leads are closer than ${min} km to each other.</li>`;
}

function renderAll() {
  computeDistances();
  renderList();
  renderConflicts();
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

async function saveIgnoreStatuses() {
  const values = [...document.querySelectorAll(".ignoreStatus:checked")].map((cb) => cb.value);
  try {
    state.settings = await api("settings", { method: "PUT", body: { ignore_statuses: values } });
    renderAll();
  } catch (err) { toast(err.message, true); }
}

/* ---------------- drawer / form ---------------- */
const form = $("#leadForm");

function fillSelect(sel, entries, current) {
  sel.innerHTML = entries.map(([v, label]) =>
    `<option value="${v}" ${v === current ? "selected" : ""}>${esc(label)}</option>`).join("");
}

function openDrawer(lead, coords = null) {
  state.editing = lead;
  form.reset();
  $("#formError").hidden = true;
  $("#geoResults").hidden = true;
  $("#drawerTitle").textContent = lead ? lead.company : "New lead";
  fillSelect(form.status, Object.entries(STATUS_INFO).map(([k, s]) => [k, s.label]), lead?.status || "new");
  fillSelect(form.priority, Object.entries(PRIORITY_LABEL), lead?.priority || "medium");
  for (const el of form.elements) {
    if (!el.name || el.name === "status" || el.name === "priority") continue;
    el.value = lead && lead[el.name] !== null && lead[el.name] !== undefined ? lead[el.name] : "";
  }
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

function setCoords(lat, lng) {
  form.lat.value = lat.toFixed(6);
  form.lng.value = lng.toFixed(6);
  updateCoordsUI();
}

function updateCoordsUI() {
  const c = currentCoords();
  $("#coordText").textContent = c ? `📍 ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}` : "No location yet";
  const box = $("#nearbyBox");
  if (!c) { box.hidden = true; removeDraftMarker(); return; }
  const min = Number(state.settings.min_distance_km);
  const near = nearestTo(c.lat, c.lng, state.editing?.id, 5);
  box.hidden = false;
  $("#nearbyList").innerHTML = near.length
    ? near.map((n) => `<li class="${n.km < min && counts(n.lead) ? "bad" : ""}">
        ${esc(n.lead.company)} (${esc(n.lead.city || "?")}) – ${fmtKm(n.km)}
        ${n.km < min && counts(n.lead) ? " ⚠ too close" : ""}</li>`).join("")
    : "<li>No other leads on the map yet.</li>";
  showDraftMarker(c);
}

function showDraftMarker({ lat, lng }) {
  if (!draftMarker) {
    draftMarker = L.marker([lat, lng], { draggable: true, zIndexOffset: 1000 }).addTo(map);
    draftMarker.bindTooltip("New location (drag to adjust)");
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
  const parts = [form.street.value, form.postal_code.value, form.city.value].map((s) => s.trim()).filter(Boolean);
  const q = parts.length ? parts.join(", ") : form.company.value.trim();
  if (!q) { toast("Enter an address, PLZ or city first.", true); return; }
  const btn = $("#geocodeBtn");
  btn.disabled = true;
  btn.textContent = "Searching…";
  try {
    const results = await geocode(q);
    const ul = $("#geoResults");
    if (!results.length) {
      ul.innerHTML = "<li>No results. Try only PLZ + city, or use “Pick on map”.</li>";
    } else {
      ul.innerHTML = results.map((r, i) => `<li data-i="${i}">${esc(r.label)}</li>`).join("");
      ul.querySelectorAll("li[data-i]").forEach((li) => li.addEventListener("click", () => {
        const r = results[Number(li.dataset.i)];
        setCoords(r.lat, r.lng);
        for (const k of ["street", "postal_code", "city", "state"]) {
          if (!form[k].value.trim() && r[k]) form[k].value = r[k];
        }
        ul.hidden = true;
        map.setView([r.lat, r.lng], 10);
      }));
      if (results.length === 1) ul.querySelector("li").click();
    }
    ul.hidden = results.length === 1;
  } catch (err) {
    toast(err.message + " – you can also use “Pick on map”.", true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Find address on map";
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
      ? `Saved. ⚠ ${saved.company} is within ${state.settings.min_distance_km} km of ${conflicts.length} other lead(s).`
      : `Saved ${saved.company}.`, conflicts.length > 0);
  } catch (err) {
    $("#formError").textContent = err.message;
    $("#formError").hidden = false;
  }
}

async function deleteLead() {
  const lead = state.editing;
  if (!lead || !confirm(`Delete "${lead.company}" and its activity log? This cannot be undone.`)) return;
  try {
    await api(`leads/${lead.id}`, { method: "DELETE" });
    closeDrawer();
    if (state.selectedId === lead.id) state.selectedId = null;
    await reload();
    toast(`Deleted ${lead.company}.`);
  } catch (err) { toast(err.message, true); }
}

/* ---------------- activities ---------------- */
async function loadActivities(leadId) {
  const list = $("#activityList");
  list.innerHTML = "";
  try {
    const items = await api(`leads/${leadId}/activities`);
    if (state.editing?.id !== leadId) return;
    list.innerHTML = items.map((a) => `<li class="${a.type === "system" || a.type === "status" ? "system" : ""}">
      <div class="text"><span class="atype">${esc(a.type)}</span>${esc(a.text)}</div>
      <div class="meta">${esc(new Date(a.created_at).toLocaleString("de-DE"))}</div>
      ${a.type === "system" || a.type === "status" ? "" : `<button class="del" type="button" data-id="${a.id}" title="Delete">✕</button>`}
    </li>`).join("") || `<li class="meta">No activities yet.</li>`;
    list.querySelectorAll(".del").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Delete this entry?")) return;
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

/* ---------------- import ---------------- */
async function importCsv(file) {
  try {
    const data = store.importCsv(await file.text());
    await reload();
    const msg = `Imported: ${data.created} new, ${data.updated} updated.`;
    if (data.errors.length) {
      toast(`${msg} ${data.errors.length} row(s) skipped – see browser console.`, true);
      console.warn("CSV import errors:\n" + data.errors.join("\n"));
    } else toast(msg);
  } catch (err) { toast(err.message, true); }
}

async function restoreBackup(file) {
  if (!confirm("Restoring a backup replaces ALL leads in this browser with the backup. Continue?")) return;
  try {
    const res = store.importBackup(await file.text());
    state.selectedId = null;
    await reload();
    toast(`Backup restored: ${res.leads} leads, ${res.activities} activities.`);
  } catch (err) { toast(err.message, true); }
}

/* ---------------- wiring ---------------- */
function init() {
  fillSelect($("#statusFilter"), [["", "All statuses"], ...Object.entries(STATUS_INFO).map(([k, s]) => [k, s.label])], "");
  fillSelect($("#priorityFilter"), [["", "All priorities"], ...Object.entries(PRIORITY_LABEL)], "");
  renderLegend();

  ["#search", "#statusFilter", "#priorityFilter", "#sortBy"].forEach((sel) =>
    $(sel).addEventListener("input", () => { renderList(); renderMap(); }));

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
    else if (!$("#drawer").hidden) closeDrawer();
  });
  form.addEventListener("submit", saveLead);
  $("#deleteLead").addEventListener("click", deleteLead);
  $("#geocodeBtn").addEventListener("click", geocodeAddress);
  $("#pickBtn").addEventListener("click", startPick);
  $("#cancelPick").addEventListener("click", stopPick);
  $("#addActivity").addEventListener("click", addActivity);
  $("#activityText").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addActivity(); }
  });

  $("#exportBtn").addEventListener("click", () =>
    downloadFile(`leads-${today()}.csv`, "\ufeff" + store.exportCsv(), "text/csv;charset=utf-8"));
  $("#backupBtn").addEventListener("click", () =>
    downloadFile(`acd-leads-backup-${today()}.json`, store.exportBackup(), "application/json"));
  $("#restoreBtn").addEventListener("click", () => $("#restoreFile").click());
  const menu = document.querySelector(".menu");
  menu.addEventListener("click", (e) => { if (e.target.closest(".menu-list button")) menu.open = false; });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.open = false; });
  $("#restoreFile").addEventListener("change", (e) => {
    if (e.target.files[0]) restoreBackup(e.target.files[0]);
    e.target.value = "";
  });
  if (!store.persistent()) {
    toast("Your browser blocks local storage: leads will be lost when you close this page. " +
      "Download a backup before closing.", true);
  }

  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (e) => {
    if (e.target.files[0]) importCsv(e.target.files[0]);
    e.target.value = "";
  });

  reload().catch((err) => toast("Could not load leads: " + err.message, true));
}

init();
