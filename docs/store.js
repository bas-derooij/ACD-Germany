/* ACD Germany – browser storage for leads, activities and settings.
 *
 * Everything is kept in the browser's localStorage, so the app runs without a
 * server. `request(method, path, body)` mirrors a small REST API so the UI code
 * stays simple. Works in Node too (pass any object with getItem/setItem) for tests.
 */
(function (root) {
  "use strict";

  const STATUSES = ["new", "contacted", "meeting", "negotiation", "dealer", "on_hold", "rejected"];
  const PRIORITIES = ["low", "medium", "high"];
  const LEAD_FIELDS = {
    company: "str", contact_name: "str", email: "str", phone: "str", website: "str",
    street: "str", postal_code: "str", city: "str", state: "str",
    lat: "float", lng: "float", status: "str", priority: "str", source: "str",
    assigned_to: "str", brands: "str", notes: "str", next_action: "str", next_action_date: "str",
  };
  const CSV_COLUMNS = ["id", ...Object.keys(LEAD_FIELDS), "created_at", "updated_at"];
  const DEFAULT_SETTINGS = { min_distance_km: 50, ignore_statuses: ["rejected"] };
  const STORAGE_KEY = "acd-germany-leads-v1";

  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const bad = (msg) => new HttpError(400, msg);
  const notFound = (msg) => new HttpError(404, msg);
  const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  function emptyDb() {
    return { next_lead_id: 1, next_activity_id: 1, leads: [], activities: [], settings: {} };
  }

  function cleanLead(data, partial = false) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("Expected an object");
    const out = {};
    for (const [key, kind] of Object.entries(LEAD_FIELDS)) {
      if (!(key in data)) continue;
      const value = data[key];
      if (kind === "float") {
        if (value === null || value === undefined || String(value).trim() === "") out[key] = null;
        else {
          const n = Number(String(value).trim().replace(",", "."));
          if (!Number.isFinite(n)) throw bad(`'${key}' must be a number`);
          out[key] = n;
        }
      } else {
        out[key] = value === null || value === undefined ? "" : String(value).trim();
      }
    }
    if ((!partial || "company" in out) && !out.company) throw bad("Company name is required");
    if ("status" in out) {
      out.status = out.status || "new";
      if (!STATUSES.includes(out.status)) throw bad(`Unknown status '${out.status}'`);
    }
    if ("priority" in out) {
      out.priority = out.priority || "medium";
      if (!PRIORITIES.includes(out.priority)) throw bad(`Unknown priority '${out.priority}'`);
    }
    if (out.lat != null && (out.lat < -90 || out.lat > 90)) throw bad("Latitude out of range");
    if (out.lng != null && (out.lng < -180 || out.lng > 180)) throw bad("Longitude out of range");
    return out;
  }

  /* ---------------- CSV ---------------- */
  function csvEscape(value, delimiter) {
    const s = value === null || value === undefined ? "" : String(value);
    return /["\r\n]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function parseCsv(text, delimiter) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === delimiter) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((v) => v.trim() !== ""));
  }

  /* ---------------- store ---------------- */
  function createStore(storage) {
    let memoryDb = null; // fallback when storage is unavailable

    function load() {
      try {
        const raw = storage && storage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) { /* fall through */ }
      return memoryDb ? JSON.parse(JSON.stringify(memoryDb)) : emptyDb();
    }

    function save(db) {
      memoryDb = db;
      try {
        if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(db));
      } catch (e) {
        throw new HttpError(507, "Could not save: browser storage is full or blocked. " +
          "Please download a backup.");
      }
    }

    function persistent() {
      try {
        const k = STORAGE_KEY + "-test";
        storage.setItem(k, "1");
        storage.removeItem(k);
        return true;
      } catch (e) { return false; }
    }

    function listLeads(db) {
      const counts = new Map();
      for (const a of db.activities) counts.set(a.lead_id, (counts.get(a.lead_id) || 0) + 1);
      return db.leads
        .map((l) => ({ ...l, activity_count: counts.get(l.id) || 0 }))
        .sort((a, b) => a.company.localeCompare(b.company, "de", { sensitivity: "base" }));
    }

    function addActivityRow(db, leadId, type, text, ts) {
      const act = { id: db.next_activity_id++, lead_id: leadId, type, text, created_at: ts };
      db.activities.push(act);
      return act;
    }

    function createLead(db, data) {
      const lead = {};
      for (const key of Object.keys(LEAD_FIELDS)) lead[key] = LEAD_FIELDS[key] === "float" ? null : "";
      lead.status = "new";
      lead.priority = "medium";
      Object.assign(lead, cleanLead(data));
      const ts = nowIso();
      lead.id = db.next_lead_id++;
      lead.created_at = lead.updated_at = ts;
      db.leads.push(lead);
      addActivityRow(db, lead.id, "system", "Lead created", ts);
      return lead;
    }

    function updateLead(db, lead, data) {
      const changes = cleanLead(data, true);
      if (!Object.keys(changes).length) return lead;
      const ts = nowIso();
      if ("status" in changes && changes.status !== lead.status) {
        addActivityRow(db, lead.id, "status",
          `Status changed from '${lead.status}' to '${changes.status}'`, ts);
      }
      Object.assign(lead, changes, { updated_at: ts });
      return lead;
    }

    function getSettings(db) {
      return { ...DEFAULT_SETTINGS, ...db.settings };
    }

    function updateSettings(db, data) {
      if (!data || typeof data !== "object") throw bad("Expected an object");
      if ("min_distance_km" in data) {
        const v = Number(data.min_distance_km);
        if (!Number.isFinite(v) || v <= 0 || v > 1000) {
          throw bad("Minimum distance must be between 0 and 1000 km");
        }
        db.settings.min_distance_km = v;
      }
      if ("ignore_statuses" in data) {
        const v = data.ignore_statuses;
        if (!Array.isArray(v) || v.some((s) => !STATUSES.includes(s))) {
          throw bad("ignore_statuses must be a list of known statuses");
        }
        db.settings.ignore_statuses = v;
      }
      return getSettings(db);
    }

    function exportCsv() {
      const db = load();
      const lines = [CSV_COLUMNS.join(";")];
      for (const lead of listLeads(db)) {
        lines.push(CSV_COLUMNS.map((c) => csvEscape(lead[c], ";")).join(";"));
      }
      return lines.join("\r\n") + "\r\n";
    }

    function importCsv(text) {
      text = String(text || "").replace(/^﻿/, "");
      if (!text.trim()) throw bad("The CSV file is empty");
      const firstLine = text.split(/\r?\n/, 1)[0];
      const count = (ch) => firstLine.split(ch).length - 1;
      const delimiter = count(";") >= count(",") ? ";" : ",";
      const [header, ...rows] = parseCsv(text, delimiter);
      const keys = header.map((h) => h.trim().toLowerCase());
      const db = load();
      let created = 0, updated = 0;
      const errors = [];
      rows.forEach((values, idx) => {
        const row = {};
        keys.forEach((k, i) => { row[k] = values[i] ?? ""; });
        const data = {};
        for (const k of Object.keys(LEAD_FIELDS)) if (k in row) data[k] = row[k];
        try {
          const id = row.id && row.id.trim() ? Number(row.id) : null;
          const existing = id ? db.leads.find((l) => l.id === id) : null;
          if (existing) { updateLead(db, existing, data); updated++; }
          else { createLead(db, data); created++; }
        } catch (e) {
          errors.push(`Line ${idx + 2}: ${e.message}`);
        }
      });
      save(db);
      return { created, updated, errors };
    }

    function exportBackup() {
      return JSON.stringify({ app: "acd-germany-leads", version: 1, exported_at: nowIso(), db: load() }, null, 2);
    }

    function importBackup(text) {
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { throw bad("This is not a valid backup file"); }
      const db = parsed && parsed.app === "acd-germany-leads" ? parsed.db : null;
      if (!db || !Array.isArray(db.leads) || !Array.isArray(db.activities)) {
        throw bad("This is not a valid backup file");
      }
      save(db);
      return { leads: db.leads.length, activities: db.activities.length };
    }

    async function request(method, path, body) {
      const db = load();
      let m;

      if (path === "leads") {
        if (method === "GET") return listLeads(db);
        if (method === "POST") { const lead = createLead(db, body); save(db); return lead; }
      }

      if ((m = path.match(/^leads\/(\d+)$/))) {
        const id = Number(m[1]);
        const lead = db.leads.find((l) => l.id === id);
        if (!lead) throw notFound("Lead not found");
        if (method === "GET") return lead;
        if (method === "PUT") { updateLead(db, lead, body); save(db); return lead; }
        if (method === "DELETE") {
          db.leads = db.leads.filter((l) => l.id !== id);
          db.activities = db.activities.filter((a) => a.lead_id !== id);
          save(db);
          return { ok: true };
        }
      }

      if ((m = path.match(/^leads\/(\d+)\/activities$/))) {
        const id = Number(m[1]);
        const lead = db.leads.find((l) => l.id === id);
        if (!lead) throw notFound("Lead not found");
        if (method === "GET") {
          return db.activities.filter((a) => a.lead_id === id)
            .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
        }
        if (method === "POST") {
          const text = String((body && body.text) || "").trim();
          if (!text) throw bad("Activity text is required");
          const type = String((body && body.type) || "note").trim() || "note";
          const ts = nowIso();
          const act = addActivityRow(db, id, type, text, ts);
          lead.updated_at = ts;
          save(db);
          return act;
        }
      }

      if ((m = path.match(/^activities\/(\d+)$/)) && method === "DELETE") {
        const id = Number(m[1]);
        const before = db.activities.length;
        db.activities = db.activities.filter((a) => a.id !== id);
        if (db.activities.length === before) throw notFound("Activity not found");
        save(db);
        return { ok: true };
      }

      if (path === "settings") {
        if (method === "GET") return getSettings(db);
        if (method === "PUT") { const s = updateSettings(db, body); save(db); return s; }
      }

      throw notFound("Not found");
    }

    return { request, exportCsv, importCsv, exportBackup, importBackup, persistent };
  }

  const api = { createStore, parseCsv, STATUSES, PRIORITIES, CSV_COLUMNS, STORAGE_KEY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LeadStore = api;
})(typeof window !== "undefined" ? window : globalThis);
