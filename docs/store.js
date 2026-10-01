/* ACD Germany – browser storage for leads, activities and settings.
 *
 * Everything is kept in the browser's localStorage, so the app runs without a
 * server. `request(method, path, body)` mirrors a small REST API so the UI code
 * stays simple. Works in Node too (pass any object with getItem/setItem) for tests.
 */
(function (root) {
  "use strict";

  // Status = colour code of column J in the roadmap sheet.
  const STATUSES = ["gesprek", "samenwerking", "geen"];
  const LEAD_FIELDS = {
    category: "str",        // Domein (column A)
    company: "str",         // Onderneming
    contact_name: "str",    // Naam
    phone: "str", email: "str", website: "str",
    street: "str", postal_code: "str",
    city: "str",            // Locatie (gemeente)
    state: "str",           // Deelstaat
    lat: "float", lng: "float",
    geo_auto: "str",        // "1" when the pin was placed automatically from the municipality
    status: "str",          // Status (colour)
    status_info: "str",     // Status informatie
    next_action: "str",     // Volgende actie
    next_action_date: "str",
    last_visit: "str",      // Laatste bezoek
    demo_serre: "str",      // Demo-serre
    notes: "str",           // Notitie
  };
  // Categories that do not count in the "too close" check unless the user turns them on.
  const DEFAULT_EXCLUDED_CATEGORIES = [
    "Merkambassadeur", "Certified assembler", "Galabau verkoper, monteur",
    "Beurs bezoek", "Beurs deelname",
  ];
  const DEFAULT_SETTINGS = {
    min_distance_km: 50,
    ignore_statuses: ["geen"],
    excluded_categories: DEFAULT_EXCLUDED_CATEGORIES,
    category_colors: {},
  };
  // Colours for categories (pin fill). Known categories from the roadmap get a fixed colour.
  const KNOWN_CATEGORY_COLORS = {
    "Dealer Galabau": "#1f6fd1",
    "Dealer Gartencenter": "#7b3fbf",
    "Dealer Online retailer": "#0fa3b1",
    "Dealer gespecialiseerd": "#1b2a6b",
    "Dealer/merkambassadeur": "#d147a3",
    "Merkambassadeur": "#f29bd0",
    "Certified assembler": "#8c5a3c",
    "Galabau verkoper, monteur": "#6b7280",
    "Beurs bezoek": "#111827",
    "Beurs deelname": "#57534e",
  };
  const PALETTE = ["#2563eb", "#9333ea", "#0891b2", "#be185d", "#4d7c0f", "#a16207",
    "#0f766e", "#7c2d12", "#4338ca", "#64748b", "#db2777", "#155e75"];
  const STORAGE_KEY = "acd-germany-leads-v1";
  const NO_CATEGORY = "Zonder domein";

  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const bad = (msg) => new HttpError(400, msg);
  const notFound = (msg) => new HttpError(404, msg);
  const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const companyKey = (s) => String(s || "").trim().toLowerCase();

  function emptyDb() {
    return { next_lead_id: 1, next_activity_id: 1, leads: [], activities: [], settings: {} };
  }

  // Old status values (before the roadmap import) mapped to the new colour statuses.
  const OLD_STATUS = { dealer: "samenwerking", rejected: "geen", on_hold: "geen" };

  function migrate(db) {
    for (const lead of db.leads) {
      if (!STATUSES.includes(lead.status)) lead.status = OLD_STATUS[lead.status] || "gesprek";
      if (lead.category === undefined) lead.category = "";
    }
    return db;
  }

  function cleanLead(data, partial = false) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("Ongeldige gegevens");
    const out = {};
    for (const [key, kind] of Object.entries(LEAD_FIELDS)) {
      if (!(key in data)) continue;
      const value = data[key];
      if (kind === "float") {
        if (value === null || value === undefined || String(value).trim() === "") out[key] = null;
        else {
          const n = Number(String(value).trim().replace(",", "."));
          if (!Number.isFinite(n)) throw bad(`'${key}' moet een getal zijn`);
          out[key] = n;
        }
      } else {
        out[key] = value === null || value === undefined ? "" : String(value).trim();
      }
    }
    if ((!partial || "company" in out) && !out.company) throw bad("Onderneming is verplicht");
    if ("status" in out) {
      out.status = out.status || "gesprek";
      if (!STATUSES.includes(out.status)) throw bad(`Onbekende status '${out.status}'`);
    }
    if (out.lat != null && (out.lat < -90 || out.lat > 90)) throw bad("Breedtegraad ongeldig");
    if (out.lng != null && (out.lng < -180 || out.lng > 180)) throw bad("Lengtegraad ongeldig");
    return out;
  }

  /* ---------------- store ---------------- */
  function createStore(storage) {
    let memoryDb = null; // fallback when storage is unavailable

    function load() {
      try {
        const raw = storage && storage.getItem(STORAGE_KEY);
        if (raw) return migrate(JSON.parse(raw));
      } catch (e) { /* fall through */ }
      return memoryDb ? JSON.parse(JSON.stringify(memoryDb)) : emptyDb();
    }

    function save(db) {
      assignCategoryColors(db);
      memoryDb = db;
      try {
        if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(db));
      } catch (e) {
        throw new HttpError(507, "Opslaan mislukt: de opslag van de browser is vol of geblokkeerd. " +
          "Download een back-up.");
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

    // Give every category in use a colour, so the legend stays stable.
    function assignCategoryColors(db) {
      const colors = { ...(db.settings.category_colors || {}) };
      const used = new Set(Object.values(colors));
      for (const lead of db.leads) {
        const cat = lead.category || NO_CATEGORY;
        if (colors[cat]) continue;
        const color = KNOWN_CATEGORY_COLORS[cat] ||
          PALETTE.find((c) => !used.has(c)) || PALETTE[Object.keys(colors).length % PALETTE.length];
        colors[cat] = color;
        used.add(color);
      }
      db.settings.category_colors = colors;
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

    function createLead(db, data, logText = "Lead aangemaakt") {
      const lead = {};
      for (const [key, kind] of Object.entries(LEAD_FIELDS)) lead[key] = kind === "float" ? null : "";
      lead.status = "gesprek";
      Object.assign(lead, cleanLead(data));
      const ts = nowIso();
      lead.id = db.next_lead_id++;
      lead.created_at = lead.updated_at = ts;
      db.leads.push(lead);
      addActivityRow(db, lead.id, "system", logText, ts);
      return lead;
    }

    function updateLead(db, lead, data) {
      const changes = cleanLead(data, true);
      if (!Object.keys(changes).length) return lead;
      const ts = nowIso();
      if ("status" in changes && changes.status !== lead.status) {
        addActivityRow(db, lead.id, "status",
          `Status gewijzigd van '${lead.status}' naar '${changes.status}'`, ts);
      }
      Object.assign(lead, changes, { updated_at: ts });
      return lead;
    }

    function getSettings(db) {
      return { ...DEFAULT_SETTINGS, ...db.settings };
    }

    function updateSettings(db, data) {
      if (!data || typeof data !== "object") throw bad("Ongeldige instellingen");
      if ("min_distance_km" in data) {
        const v = Number(data.min_distance_km);
        if (!Number.isFinite(v) || v <= 0 || v > 1000) {
          throw bad("Minimale afstand moet tussen 0 en 1000 km liggen");
        }
        db.settings.min_distance_km = v;
      }
      if ("ignore_statuses" in data) {
        const v = data.ignore_statuses;
        if (!Array.isArray(v) || v.some((s) => !STATUSES.includes(s))) {
          throw bad("ignore_statuses moet een lijst van bekende statussen zijn");
        }
        db.settings.ignore_statuses = v;
      }
      if ("excluded_categories" in data) {
        const v = data.excluded_categories;
        if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
          throw bad("excluded_categories moet een lijst van domeinen zijn");
        }
        db.settings.excluded_categories = v;
      }
      if ("category_colors" in data) {
        const v = data.category_colors;
        if (!v || typeof v !== "object" ||
            Object.values(v).some((c) => !/^#[0-9a-f]{6}$/i.test(c))) {
          throw bad("Ongeldige kleur");
        }
        db.settings.category_colors = { ...(db.settings.category_colors || {}), ...v };
      }
      return getSettings(db);
    }

    // Add or update leads in bulk (Excel import). Leads are matched on company name.
    function importLeads(rows) {
      const db = load();
      const byCompany = new Map(db.leads.map((l) => [companyKey(l.company), l]));
      let created = 0, updated = 0;
      const errors = [];
      rows.forEach((row, i) => {
        try {
          const existing = byCompany.get(companyKey(row.data.company));
          if (existing) {
            // Keep a location the user already set unless the import brings a new municipality.
            const data = { ...row.data };
            if (existing.lat != null && companyKey(existing.city) === companyKey(data.city)) {
              delete data.lat; delete data.lng; delete data.geo_auto;
            }
            updateLead(db, existing, data);
            updated++;
          } else {
            const lead = createLead(db, row.data, "Lead geïmporteerd uit Excel");
            byCompany.set(companyKey(lead.company), lead);
            created++;
          }
        } catch (e) {
          errors.push(`${row.label || "Rij " + (i + 1)}: ${e.message}`);
        }
      });
      save(db);
      return { created, updated, errors };
    }

    function exportBackup() {
      return JSON.stringify({ app: "acd-germany-leads", version: 2, exported_at: nowIso(), db: load() }, null, 2);
    }

    function importBackup(text) {
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { throw bad("Dit is geen geldig back-upbestand"); }
      const db = parsed && parsed.app === "acd-germany-leads" ? parsed.db : null;
      if (!db || !Array.isArray(db.leads) || !Array.isArray(db.activities)) {
        throw bad("Dit is geen geldig back-upbestand");
      }
      db.settings = db.settings || {};
      save(migrate(db));
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
        if (!lead) throw notFound("Lead niet gevonden");
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
        if (!lead) throw notFound("Lead niet gevonden");
        if (method === "GET") {
          return db.activities.filter((a) => a.lead_id === id)
            .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
        }
        if (method === "POST") {
          const text = String((body && body.text) || "").trim();
          if (!text) throw bad("Vul een tekst in");
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
        if (db.activities.length === before) throw notFound("Activiteit niet gevonden");
        save(db);
        return { ok: true };
      }

      if (path === "settings") {
        if (method === "GET") { assignCategoryColors(db); return getSettings(db); }
        if (method === "PUT") { const s = updateSettings(db, body); save(db); return s; }
      }

      throw notFound("Niet gevonden");
    }

    return { request, importLeads, exportBackup, importBackup, persistent };
  }

  const api = { createStore, STATUSES, LEAD_FIELDS, STORAGE_KEY, NO_CATEGORY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LeadStore = api;
})(typeof window !== "undefined" ? window : globalThis);
