// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const R = require("../docs/roadmap.js");

const HEADER = ["Domein", "Onderneming", "Naam", "Telefoonnummer", "Mailadres", "Website", "Locatie ",
  "Deelstaat", "Regio Duitsland", "Status", "Status informatie ", "Volgende actie ", "Laatste bezoek",
  "Demo-serre", "Notitie"];
const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

// A small sheet in the same layout as the real roadmap (fictional data).
async function sampleWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Blad1");
  ws.getCell("A1").value = "ROADMAP ACD DUITSLAND";
  ws.getCell("A2").value = "Update datum:";
  ws.getRow(4).values = HEADER;
  const rows = [
    [["Dealer Galabau", "Test Galabau", "Max Muster", "+49 1", "a@b.de", "/", "Kastl", "Beieren", "Zuid-oosten", null,
      "1e gesprek", "Terugbellen", new Date(Date.UTC(2026, 3, 10)), "/", "Notitie"], "FFFFC000"],
    [["Merkambassadeur", "Groene Lead", "Anna", null, null, { text: "insta", hyperlink: "https://x" }, "Hamburg",
      "Hamburg", "Noorden", null, { richText: [{ text: "Samen" }, { text: "werking loopt" }] }], "FF00B050"],
    [["Merkambassadeur", "Rode Lead", "Bob"], "FFFF0000"],
    [["Beurs deelname", "/", "Galabau Messe", null, null, null, "Nürnberg", "Beieren"], "FF00B050"],
    [["Dealer Galabau", "Zonder kleur"], null],
  ];
  rows.forEach(([values, color], i) => {
    const row = ws.getRow(5 + i);
    row.values = values;
    if (color) row.getCell(10).fill = fill(color);
  });
  const buffer = await wb.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer);
  return loaded;
}

test("readRoadmap takes status from colour and skips red rows", async () => {
  const res = R.readRoadmap(await sampleWorkbook());
  assert.deepEqual(res.leads.map((l) => [l.data.company, l.data.status]), [
    ["Test Galabau", "gesprek"],
    ["Groene Lead", "samenwerking"],
    ["Galabau Messe", "samenwerking"],
  ]);
  assert.equal(res.skipped.red.length, 1);
  assert.equal(res.skipped.nocolor.length, 1);

  const [first, second, fair] = res.leads.map((l) => l.data);
  assert.equal(first.category, "Dealer Galabau");
  assert.equal(first.city, "Kastl");
  assert.equal(first.website, "", "'/' means empty");
  assert.equal(first.last_visit, "10/04/2026");
  assert.equal(first.status_info, "1e gesprek");
  assert.equal(first.next_action, "Terugbellen");
  assert.equal(first.notes, "Notitie");
  assert.ok(!("regio" in first) && !Object.values(first).includes("Zuid-oosten"), "column I is ignored");
  assert.equal(second.website, "insta");
  assert.equal(second.status_info, "Samenwerking loopt");
  assert.equal(fair.contact_name, "", "fairs: name column becomes the company");
});

test("classifyColor", () => {
  assert.equal(R.classifyColor("FFC000"), "gesprek");
  assert.equal(R.classifyColor("FFA500"), "gesprek");
  assert.equal(R.classifyColor("00B050"), "samenwerking");
  assert.equal(R.classifyColor("4EA72E"), "samenwerking");
  assert.equal(R.classifyColor("FF0000"), "geen");
  assert.equal(R.classifyColor("FFFFFF"), null);
  assert.equal(R.classifyColor(null), null);
});

test("export can be imported again", async () => {
  const leads = [
    { company: "B GmbH", category: "Dealer Galabau", status: "gesprek", city: "Kastl", next_action: "Bellen", next_action_date: "2026-10-06" },
    { company: "A GmbH", category: "Merkambassadeur", status: "samenwerking", city: "Hamburg" },
    { company: "C", category: "Dealer/merkambassadeur", status: "gesprek" },
  ];
  const wb = R.buildRoadmap(ExcelJS, leads, { perCategory: true });
  assert.deepEqual(wb.worksheets.map((w) => w.name),
    ["Overzicht", "Merkambassadeur", "Dealer-merkambassadeur", "Dealer Galabau"]);
  const ws = wb.worksheets[0];
  assert.equal(ws.getCell("B5").value, "A GmbH", "sorted by roadmap group order");
  assert.equal(ws.getCell("I5").value, "Samenwerking loopt");
  assert.equal(ws.getCell("I5").fill.fgColor.argb, "FF00B050");

  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(await wb.xlsx.writeBuffer());
  const back = R.readRoadmap(loaded).leads.map((l) => l.data);
  assert.equal(back.length, 3);
  const b = back.find((l) => l.company === "B GmbH");
  assert.equal(b.status, "gesprek");
  assert.equal(b.next_action, "Bellen (tegen 06/10/2026)");
});

test("placeQueries translates Dutch state names and simplifies place names", () => {
  assert.deepEqual(R.placeQueries("Kastl", "Beieren")[0], { city: "Kastl", state: "Bayern" });
  assert.equal(R.germanState("Hessen (Frankfurt)"), "Hessen");
  assert.equal(R.germanState("Noordrijn Westfalen"), "Nordrhein-Westfalen");
  const q = R.placeQueries("Muldestausee Ot Rösa", "Saksen-Anhalt").map((x) => x.city);
  assert.ok(q.includes("Muldestausee"));
  assert.ok(!R.placeQueries("Bad Bellingen", "").some((x) => x.city === "Bad"));
});
