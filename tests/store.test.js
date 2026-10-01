// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStore, STORAGE_KEY, splitLegacyCategory, normalizeNames, groupKey } = require("../docs/store.js");

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

const BERLIN = { lat: 52.52, lng: 13.405 };

test("lead CRUD with activity log", async () => {
  const store = createStore(memoryStorage());
  const lead = await store.request("POST", "leads", { company: "Autohaus Berlin", category: "Dealer", subcategory: "GaLa Bau", city: "Berlin", ...BERLIN });
  assert.equal(lead.subcategory, "GaLa Bau");
  assert.equal(lead.status, "gesprek");
  assert.equal((await store.request("GET", "leads")).length, 1);

  const updated = await store.request("PUT", `leads/${lead.id}`, { status: "samenwerking", demo_serre: "Sophie BL" });
  assert.equal(updated.status, "samenwerking");
  assert.equal(updated.demo_serre, "Sophie BL");
  assert.equal(updated.company, "Autohaus Berlin");

  const act = await store.request("POST", `leads/${lead.id}/activities`, { type: "telefoon", text: "Gebeld" });
  const acts = await store.request("GET", `leads/${lead.id}/activities`);
  assert.deepEqual(acts.map((a) => a.type).sort(), ["status", "system", "telefoon"]);

  await store.request("DELETE", `activities/${act.id}`);
  await store.request("DELETE", `leads/${lead.id}`);
  await assert.rejects(store.request("GET", `leads/${lead.id}`), { status: 404 });
});

test("data survives a new store on the same storage", async () => {
  const storage = memoryStorage();
  await createStore(storage).request("POST", "leads", { company: "A" });
  assert.equal((await createStore(storage).request("GET", "leads")).length, 1);
});

test("old statuses and Domein values are migrated", async () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    next_lead_id: 4, next_activity_id: 1, activities: [],
    settings: {
      excluded_categories: ["Merkambassadeur", "Galabau verkoper, monteur"],
      category_colors: { "Dealer Galabau": "#123456", "Merkambassadeur": "#abcdef" },
    },
    leads: [
      { id: 1, company: "A", status: "dealer", category: "Dealer Galabau" },
      { id: 2, company: "B", status: "rejected", category: "Merkambassadeur" },
      { id: 3, company: "C", status: "contacted", category: "Galabau verkoper, monteur" },
    ],
  }));
  const store = createStore(storage);
  const leads = await store.request("GET", "leads");
  assert.deepEqual(leads.map((l) => l.status), ["samenwerking", "geen", "gesprek"]);
  assert.deepEqual(leads.map(groupKey), ["Dealer › GaLa Bau", "Ambassadeur", "Certified Assembler › Monteur-verkoper"]);
  const s = await store.request("GET", "settings");
  assert.deepEqual(s.excluded_categories, ["Ambassadeur", "Certified Assembler › Monteur-verkoper"]);
  assert.equal(s.category_colors["Dealer › GaLa Bau"], "#c2410c");
  assert.equal(s.category_colors["Ambassadeur"], "#f29bd0");

  // Migration runs once: a later edit is not split again.
  await store.request("PUT", "leads/1", { category: "Dealer", subcategory: "" });
  assert.equal(groupKey((await store.request("GET", "leads"))[0]), "Dealer");
});

test("version 3 data is renamed (Ambassador, Specialisatie, Beurs)", async () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    version: 3, next_lead_id: 3, next_activity_id: 1, activities: [],
    settings: { excluded_categories: ["Ambassador", "Beurs"], category_colors: { "Dealer › Specialisatie": "#000001" } },
    leads: [
      { id: 1, company: "A", status: "gesprek", category: "Ambassador", subcategory: "" },
      { id: 2, company: "B", status: "gesprek", category: "Dealer", subcategory: "Specialisatie" },
    ],
  }));
  const store = createStore(storage);
  assert.deepEqual((await store.request("GET", "leads")).map(groupKey), ["Ambassadeur", "Dealer › Gespecialiseerd"]);
  const s = await store.request("GET", "settings");
  assert.deepEqual(s.excluded_categories, ["Ambassadeur", "Beurs", "Beurs › Bezoek", "Beurs › Deelname"]);
  assert.equal(s.category_colors["Dealer › Gespecialiseerd"], "#d32f2f");
});

test("spelling variants map to the existing (sub)categories", async () => {
  assert.deepEqual(normalizeNames("Certified assembler", "monteur"), ["Certified Assembler", "Monteur"]);
  assert.deepEqual(normalizeNames(" certified  Assembler ", "Monteur - verkoper"), ["Certified Assembler", "Monteur-verkoper"]);
  assert.deepEqual(normalizeNames("Certified Assembler Monteur", ""), ["Certified Assembler", "Monteur"]);
  assert.deepEqual(normalizeNames("dealer", "Galabau"), ["Dealer", "GaLa Bau"]);
  assert.deepEqual(normalizeNames("Iets anders", "x"), ["Iets anders", "x"]);

  // Stored version 4 data with a variant is merged into the existing category.
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    version: 4, next_lead_id: 3, next_activity_id: 1, activities: [], settings: {},
    leads: [
      { id: 1, company: "A", status: "gesprek", category: "Certified assembler", subcategory: "Monteur verkoper" },
      { id: 2, company: "B", status: "gesprek", category: "Certified Assembler", subcategory: "Monteur" },
    ],
  }));
  const store = createStore(storage);
  assert.deepEqual((await store.request("GET", "leads")).map(groupKey),
    ["Certified Assembler › Monteur-verkoper", "Certified Assembler › Monteur"]);
  // New input is normalised too.
  const lead = await store.request("POST", "leads", { company: "C", category: "CERTIFIED ASSEMBLER", subcategory: "monteur" });
  assert.equal(groupKey(lead), "Certified Assembler › Monteur");
});

test("version 5 colours for Gartencenter, GaLa Bau and Gespecialiseerd are updated", async () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    version: 5, next_lead_id: 1, next_activity_id: 1, activities: [], leads: [],
    settings: { category_colors: { "Dealer › GaLa Bau": "#1f6fd1", "Dealer › Gartencenter": "#7b3fbf", "Dealer › Online retailer": "#0fa3b1", "Ambassadeur": "#123456" } },
  }));
  const c = (await createStore(storage).request("GET", "settings")).category_colors;
  assert.deepEqual([c["Dealer › Gartencenter"], c["Dealer › GaLa Bau"], c["Dealer › Gespecialiseerd"]], ["#1b5e20", "#c2410c", "#d32f2f"]);
  assert.equal(c["Dealer › Online retailer"], "#0fa3b1");
  assert.equal(c["Ambassadeur"], "#123456", "other colours are kept");
});

test("splitLegacyCategory", () => {
  assert.deepEqual(splitLegacyCategory("Dealer gespecialiseerd"), ["Dealer", "Gespecialiseerd"]);
  assert.deepEqual(splitLegacyCategory("Beurs bezoek"), ["Beurs", "Bezoek"]);
  assert.deepEqual(splitLegacyCategory("Certified assembler"), ["Certified Assembler", "Monteur"]);
  assert.deepEqual(splitLegacyCategory("Dealer Nieuw type"), ["Dealer", "Nieuw type"]);
  assert.deepEqual(splitLegacyCategory("Iets anders"), ["Iets anders", ""]);
});

test("validation", async () => {
  const store = createStore(memoryStorage());
  await assert.rejects(store.request("POST", "leads", { company: "" }), { status: 400 });
  await assert.rejects(store.request("POST", "leads", { company: "X", status: "bogus" }), { status: 400 });
  await assert.rejects(store.request("POST", "leads", { company: "X", lat: "abc" }), { status: 400 });
  await assert.rejects(store.request("PUT", "settings", { min_distance_km: -5 }), { status: 400 });
  await assert.rejects(store.request("PUT", "settings", { category_colors: { A: "red" } }), { status: 400 });
});

test("settings and category colours", async () => {
  const store = createStore(memoryStorage());
  let s = await store.request("GET", "settings");
  assert.equal(s.min_distance_km, 50);
  assert.deepEqual(s.ignore_statuses, ["geen"]);
  assert.ok(s.excluded_categories.includes("Ambassadeur"));

  await store.request("POST", "leads", { company: "A", category: "Dealer", subcategory: "GaLa Bau" });
  await store.request("POST", "leads", { company: "B", category: "Iets nieuws" });
  await store.request("POST", "leads", { company: "C" });
  s = await store.request("GET", "settings");
  assert.equal(s.category_colors["Dealer › GaLa Bau"], "#c2410c");
  assert.match(s.category_colors["Iets nieuws"], /^#[0-9a-f]{6}$/);
  assert.ok(s.category_colors["Zonder categorie"]);

  s = await store.request("PUT", "settings", {
    min_distance_km: "20", excluded_categories: ["Iets nieuws"], category_colors: { "Iets nieuws": "#123456" },
  });
  assert.equal(s.min_distance_km, 20);
  assert.deepEqual(s.excluded_categories, ["Iets nieuws"]);
  assert.equal(s.category_colors["Iets nieuws"], "#123456");
  assert.equal(s.category_colors["Dealer › GaLa Bau"], "#c2410c");
});

test("importLeads creates and updates by company name", async () => {
  const store = createStore(memoryStorage());
  const first = store.importLeads([
    { label: "Rij 5", data: { company: "Beispiel Gartencenter", city: "Musterstadt", status: "gesprek" } },
    { label: "Rij 6", data: { company: "", city: "Nowhere" } },
  ]);
  assert.equal(first.created, 1);
  assert.equal(first.errors.length, 1);

  const [lead] = await store.request("GET", "leads");
  await store.request("PUT", `leads/${lead.id}`, { lat: 48.07, lng: 11.38 });
  const second = store.importLeads([
    { data: { company: " beispiel gartencenter ", city: "Musterstadt", status: "samenwerking", notes: "x" } },
  ]);
  assert.deepEqual([second.created, second.updated], [0, 1]);
  const [after] = await store.request("GET", "leads");
  assert.equal(after.status, "samenwerking");
  assert.equal(after.lat, 48.07, "location kept when the municipality did not change");
});

test("clearLeads removes leads and activities but keeps settings", async () => {
  const store = createStore(memoryStorage());
  await store.request("PUT", "settings", { min_distance_km: 30 });
  const lead = await store.request("POST", "leads", { company: "A" });
  await store.request("POST", `leads/${lead.id}/activities`, { text: "notitie" });
  assert.deepEqual(store.clearLeads(), { removed: 1 });
  assert.equal((await store.request("GET", "leads")).length, 0);
  assert.equal((await store.request("GET", "settings")).min_distance_km, 30);
  const again = store.importLeads([{ data: { company: "A", status: "gesprek" } }]);
  assert.equal(again.created, 1);
});

test("backup and restore", async () => {
  const a = createStore(memoryStorage());
  const lead = await a.request("POST", "leads", { company: "A" });
  await a.request("POST", `leads/${lead.id}/activities`, { text: "notitie" });
  const b = createStore(memoryStorage());
  assert.deepEqual(b.importBackup(a.exportBackup()), { leads: 1, activities: 2 });
  assert.equal((await b.request("GET", "leads"))[0].company, "A");
  assert.throws(() => b.importBackup("{}"), { status: 400 });
});

test("works without storage (memory fallback)", async () => {
  const store = createStore(null);
  await store.request("POST", "leads", { company: "A" });
  assert.equal((await store.request("GET", "leads")).length, 1);
  assert.equal(store.persistent(), false);
});
