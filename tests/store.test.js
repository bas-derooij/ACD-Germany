// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStore, parseCsv } = require("../docs/store.js");

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
  const lead = await store.request("POST", "leads", { company: "Autohaus Berlin", city: "Berlin", ...BERLIN });
  assert.equal(lead.status, "new");
  assert.equal(lead.priority, "medium");
  assert.equal((await store.request("GET", "leads")).length, 1);

  const updated = await store.request("PUT", `leads/${lead.id}`, { status: "contacted" });
  assert.equal(updated.status, "contacted");
  assert.equal(updated.company, "Autohaus Berlin");

  const act = await store.request("POST", `leads/${lead.id}/activities`, { type: "call", text: "Called owner" });
  const acts = await store.request("GET", `leads/${lead.id}/activities`);
  assert.deepEqual(acts.map((a) => a.type).sort(), ["call", "status", "system"]);

  await store.request("DELETE", `activities/${act.id}`);
  await store.request("DELETE", `leads/${lead.id}`);
  await assert.rejects(store.request("GET", `leads/${lead.id}`), { status: 404 });
});

test("data survives a new store on the same storage", async () => {
  const storage = memoryStorage();
  await createStore(storage).request("POST", "leads", { company: "A" });
  assert.equal((await createStore(storage).request("GET", "leads")).length, 1);
});

test("validation", async () => {
  const store = createStore(memoryStorage());
  await assert.rejects(store.request("POST", "leads", { company: "" }), { status: 400 });
  await assert.rejects(store.request("POST", "leads", { company: "X", status: "bogus" }), { status: 400 });
  await assert.rejects(store.request("POST", "leads", { company: "X", lat: "abc" }), { status: 400 });
  await assert.rejects(store.request("PUT", "settings", { min_distance_km: -5 }), { status: 400 });
});

test("settings", async () => {
  const store = createStore(memoryStorage());
  assert.equal((await store.request("GET", "settings")).min_distance_km, 50);
  const s = await store.request("PUT", "settings", { min_distance_km: "20", ignore_statuses: [] });
  assert.equal(s.min_distance_km, 20);
  assert.deepEqual(s.ignore_statuses, []);
});

test("CSV export and import round trip", async () => {
  const store = createStore(memoryStorage());
  await store.request("POST", "leads", { company: "Händler; Süd", city: "München", lat: 48.137, lng: 11.575, notes: 'Say "hi"\nline 2' });
  let csv = store.exportCsv();
  csv = csv.replace("München", "Muenchen") + ';Neuer Händler;;;;;;;Köln;;50,94;6,96;;;;;;;;;;;\r\n';
  const result = store.importCsv(csv);
  assert.deepEqual(result, { created: 1, updated: 1, errors: [] });
  const leads = await store.request("GET", "leads");
  const byName = Object.fromEntries(leads.map((l) => [l.company, l]));
  assert.equal(byName["Händler; Süd"].city, "Muenchen");
  assert.equal(byName["Händler; Süd"].notes, 'Say "hi"\nline 2');
  assert.equal(byName["Neuer Händler"].lat, 50.94);
});

test("CSV import with commas and bad rows", () => {
  const store = createStore(memoryStorage());
  const res = store.importCsv("company,city,lat,lng,status\nA GmbH,Hamburg,53.55,9.99,dealer\n,Nowhere,,,\n");
  assert.equal(res.created, 1);
  assert.equal(res.errors.length, 1);
});

test("backup and restore", async () => {
  const a = createStore(memoryStorage());
  const lead = await a.request("POST", "leads", { company: "A" });
  await a.request("POST", `leads/${lead.id}/activities`, { text: "note" });
  const b = createStore(memoryStorage());
  assert.deepEqual(b.importBackup(a.exportBackup()), { leads: 1, activities: 2 });
  assert.equal((await b.request("GET", "leads"))[0].company, "A");
  assert.throws(() => b.importBackup("{}"), { status: 400 });
});

test("parseCsv handles quotes", () => {
  assert.deepEqual(parseCsv('a;b\n"x;1";"he said ""hi"""\n', ";"), [["a", "b"], ["x;1", 'he said "hi"']]);
});

test("works without storage (memory fallback)", async () => {
  const store = createStore(null);
  await store.request("POST", "leads", { company: "A" });
  assert.equal((await store.request("GET", "leads")).length, 1);
  assert.equal(store.persistent(), false);
});
