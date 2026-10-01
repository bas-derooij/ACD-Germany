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
    category: "str",        // Categorie (column A of the roadmap)
    subcategory: "str",     // Subcategorie
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
  // Categories and their subcategories, in display order.
  const TAXONOMY = [
    ["Dealer", ["Gartencenter", "GaLa Bau", "Gespecialiseerd", "Online retailer"]],
    ["Certified Assembler", ["Monteur", "Monteur-verkoper"]],
    ["Ambassadeur", []],
    ["Beurs", ["Bezoek", "Deelname"]],
  ];
  // Categories shown in the category filter but not in the map legend.
  const HIDDEN_IN_LEGEND = ["Beurs"];
  // Earlier names -> current names.
  const CATEGORY_ALIASES = { "ambassador": "Ambassadeur", "merkambassadeur": "Ambassadeur" };
  const SUBCATEGORY_ALIASES = { "specialisatie": "Gespecialiseerd" };
  const SEP = " › ";
  // Groups (category, or "category › subcategory") that do not count in the
  // "too close" check unless the user turns them on.
  const DEFAULT_EXCLUDED_CATEGORIES = [
    "Ambassadeur", "Certified Assembler", "Certified Assembler › Monteur",
    "Certified Assembler › Monteur-verkoper", "Beurs", "Beurs › Bezoek", "Beurs › Deelname",
  ];
  const DEFAULT_SETTINGS = {
    min_distance_km: 50,
    ignore_statuses: ["geen"],
    excluded_categories: DEFAULT_EXCLUDED_CATEGORIES,
    category_colors: {},
  };
  // Pin fill colour per group.
  const KNOWN_CATEGORY_COLORS = {
    "Dealer › GaLa Bau": "#1f6fd1",
    "Dealer › Gartencenter": "#7b3fbf",
    "Dealer › Online retailer": "#0fa3b1",
    "Dealer › Gespecialiseerd": "#1b2a6b",
    "Dealer": "#d147a3",
    "Certified Assembler › Monteur": "#8c5a3c",
    "Certified Assembler › Monteur-verkoper": "#d97706",
    "Certified Assembler": "#78716c",
    "Ambassadeur": "#f29bd0",
    "Beurs": "#111827",
    "Beurs › Bezoek": "#111827",
    "Beurs › Deelname": "#57534e",
  };
  const PALETTE = ["#2563eb", "#9333ea", "#0891b2", "#be185d", "#4d7c0f", "#a16207",
    "#0f766e", "#7c2d12", "#4338ca", "#64748b", "#db2777", "#155e75"];
  // "Domein" values from the original roadmap sheet -> [categorie, subcategorie].
  const LEGACY_CATEGORIES = {
    "dealer galabau": ["Dealer", "GaLa Bau"],
    "dealer gartencenter": ["Dealer", "Gartencenter"],
    "dealer online retailer": ["Dealer", "Online retailer"],
    "dealer gespecialiseerd": ["Dealer", "Gespecialiseerd"],
    "dealer/merkambassadeur": ["Dealer", ""],
    "merkambassadeur": ["Ambassadeur", ""],
    "certified assembler": ["Certified Assembler", "Monteur"],
    "galabau verkoper, monteur": ["Certified Assembler", "Monteur-verkoper"],
    "beurs bezoek": ["Beurs", "Bezoek"],
    "beurs deelname": ["Beurs", "Deelname"],
  };
  const DATA_VERSION = 4;

  // Apply renamed categories/subcategories (e.g. Ambassador -> Ambassadeur).
  function normalizeNames(category, subcategory) {
    const c = String(category || "").trim(), s = String(subcategory || "").trim();
    return [CATEGORY_ALIASES[c.toLowerCase()] || c, SUBCATEGORY_ALIASES[s.toLowerCase()] || s];
  }

  function splitLegacyCategory(value) {
    const v = String(value || "").trim();
    const known = LEGACY_CATEGORIES[v.toLowerCase()];
    if (known) return known.slice();
    const m = v.match(/^dealer\s+(.+)$/i);
    if (m) return ["Dealer", m[1]];
    return [v, ""];
  }

  function groupKey(lead) {
    const cat = (lead.category || "").trim() || NO_CATEGORY;
    const sub = (lead.subcategory || "").trim();
    return sub ? cat + SEP + sub : cat;
  }

  const STORAGE_KEY = "acd-germany-leads-v1";
  const NO_CATEGORY = "Zonder categorie";

  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const bad = (msg) => new HttpError(400, msg);
  const notFound = (msg) => new HttpError(404, msg);
  const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const companyKey = (s) => String(s || "").trim().toLowerCase();

  function emptyDb() {
    return { version: DATA_VERSION, next_lead_id: 1, next_activity_id: 1, leads: [], activities: [], settings: {} };
  }

  // Old status values (before the roadmap import) mapped to the new colour statuses.
  const OLD_STATUS = { dealer: "samenwerking", rejected: "geen", on_hold: "geen" };

  function migrate(db) {
    for (const lead of db.leads) {
      if (!STATUSES.includes(lead.status)) lead.status = OLD_STATUS[lead.status] || "gesprek";
      if (lead.category === undefined) lead.category = "";
      if (lead.subcategory === undefined) lead.subcategory = "";
    }
    const version = db.version || 0;
    if (version >= DATA_VERSION) return db;
    const settings = db.settings || (db.settings = {});
    // Rename the group keys used in the settings (distance check, colours).
    const renameKeys = (rename) => {
      if (Array.isArray(settings.excluded_categories)) {
        settings.excluded_categories = [...new Set(settings.excluded_categories.map(rename))];
      }
      if (settings.category_colors) {
        const colors = {};
        for (const [k, c] of Object.entries(settings.category_colors)) {
          const key = rename(k);
          if (!colors[key]) colors[key] = KNOWN_CATEGORY_COLORS[key] || c;
        }
        settings.category_colors = colors;
      }
    };
    if (version < 3) {
      // Version 3: "Domein" split into Categorie + Subcategorie.
      for (const lead of db.leads) {
        if (!lead.subcategory) [lead.category, lead.subcategory] = splitLegacyCategory(lead.category);
      }
      renameKeys((old) => {
        const [category, subcategory] = splitLegacyCategory(old);
        return groupKey({ category, subcategory });
      });
    }
    // Version 4: Ambassador -> Ambassadeur, Specialisatie -> Gespecialiseerd, Beurs subcategories.
    for (const lead of db.leads) {
      [lead.category, lead.subcategory] = normalizeNames(lead.category, lead.subcategory);
    }
    renameKeys((key) => {
      const [category, subcategory] = normalizeNames(...key.split(SEP));
      return groupKey({ category, subcategory });
    });
    if (settings.excluded_categories && settings.excluded_categories.includes("Beurs")) {
      settings.excluded_categories = [...new Set([...settings.excluded_categories, "Beurs › Bezoek", "Beurs › Deelname"])];
    }
    db.version = DATA_VERSION;
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
        if (raw) {
          const db = JSON.parse(raw);
          const version = db.version;
          migrate(db);
          if (db.version !== version) storage.setItem(STORAGE_KEY, JSON.stringify(db));
          return db;
        }
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
      const taxonomyGroups = TAXONOMY.flatMap(([category, subs]) =>
        (subs.length ? subs : [""]).map((subcategory) => ({ category, subcategory })));
      for (const lead of [...taxonomyGroups, ...db.leads]) {
        const cat = groupKey(lead);
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
          throw bad("excluded_categories moet een lijst van categorieën zijn");
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

    // Remove all leads and their activity logs; settings (colours, distance check) are kept.
    function clearLeads() {
      const db = load();
      const removed = db.leads.length;
      db.leads = [];
      db.activities = [];
      save(db);
      return { removed };
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

    return { request, importLeads, clearLeads, exportBackup, importBackup, persistent };
  }

  const api = {
    createStore, groupKey, splitLegacyCategory, normalizeNames,
    STATUSES, LEAD_FIELDS, STORAGE_KEY, NO_CATEGORY, TAXONOMY, HIDDEN_IN_LEGEND, SEP,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LeadStore = api;
})(typeof window !== "undefined" ? window : globalThis);
