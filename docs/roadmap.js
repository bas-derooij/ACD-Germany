/* ACD Germany – read and write the "ROADMAP ACD DUITSLAND" Excel layout.
 *
 * readRoadmap(workbook)   -> leads found in the sheet (status taken from the colour of column J)
 * buildRoadmap(ExcelJS, leads, options) -> a styled workbook in the same layout
 *
 * Needs ExcelJS (window.ExcelJS in the browser, require("exceljs") in Node).
 */
(function (root) {
  "use strict";

  const Store = root.LeadStore || (typeof require !== "undefined" ? require("./store.js") : null);

  const STATUS_INFO = {
    gesprek: { label: "Gesprek", color: "FFC000" },
    samenwerking: { label: "Samenwerking", color: "00B050" },
    geen: { label: "Geen samenwerking", color: "FF0000" },
  };

  // Header text in the sheet -> lead field. Column I (Regio Duitsland) is ignored on purpose.
  const HEADER_FIELDS = {
    "domein": "category",       // original roadmap: split into categorie + subcategorie
    "categorie": "category",
    "subcategorie": "subcategory",
    "onderneming": "company",
    "naam": "contact_name",
    "telefoonnummer": "phone",
    "mailadres": "email",
    "website": "website",
    "locatie": "city",
    "deelstaat": "state",
    "status": "status",
    "status informatie": "status_info",
    "volgende actie": "next_action",
    "laatste bezoek": "last_visit",
    "demo-serre": "demo_serre",
    "notitie": "notes",
  };
  const EXPORT_COLUMNS = [
    ["Categorie", "category", 20], ["Subcategorie", "subcategory", 18], ["Onderneming", "company", 30], ["Naam", "contact_name", 24],
    ["Telefoonnummer", "phone", 20], ["Mailadres", "email", 30], ["Website", "website", 30],
    ["Locatie", "city", 20], ["Deelstaat", "state", 20], ["Status", "status", 18],
    ["Status informatie", "status_info", 45], ["Volgende actie", "next_action", 35],
    ["Laatste bezoek", "last_visit", 15], ["Demo-serre", "demo_serre", 20], ["Notitie", "notes", 45],
  ];
  const EMPTY_MARKERS = new Set(["/", "?", "-"]);

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase().replace(/[:.]$/, "");
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDate = (d) => `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;

  function cellText(value) {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return fmtDate(value);
    if (typeof value === "object") {
      if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join("");
      if ("text" in value) return cellText(value.text);
      if ("result" in value) return cellText(value.result);
      return "";
    }
    const s = String(value).trim();
    return EMPTY_MARKERS.has(s) ? "" : s;
  }

  /* ---------- colours ---------- */
  function themeColors(workbook) {
    const xml = workbook && workbook._themes && Object.values(workbook._themes)[0];
    if (typeof xml !== "string") return null;
    const scheme = xml.match(/<a:clrScheme[\s\S]*?<\/a:clrScheme>/);
    if (!scheme) return null;
    const get = (tag) => {
      const m = scheme[0].match(new RegExp(`<a:${tag}>[\\s\\S]*?(?:val|lastClr)="([0-9A-Fa-f]{6})"`));
      return m ? m[1] : null;
    };
    // Excel theme index order: lt1, dk1, lt2, dk2, accent1..6
    return ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].map(get);
  }

  function fillHex(cell, theme) {
    const fill = cell && cell.fill;
    if (!fill || fill.type !== "pattern" || !fill.fgColor || fill.pattern === "none") return null;
    const c = fill.fgColor;
    if (c.argb) return c.argb.slice(-6);
    if (c.theme !== undefined && theme) return theme[c.theme] || null;
    return null;
  }

  function classifyColor(hex) {
    if (!hex) return null;
    const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255,
      b = parseInt(hex.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d < 0.2 || max < 0.25) return null; // grey, white or black
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    if (h < 15 || h >= 330) return "geen";
    if (h < 66) return "gesprek";
    if (h < 180) return "samenwerking";
    return null;
  }

  function statusFromText(text) {
    const t = norm(text);
    if (!t) return null;
    if (t.includes("geen samenwerking") || t === "rood") return "geen";
    if (t.startsWith("samenwerking") || t === "groen") return "samenwerking";
    if (t.startsWith("gesprek") || t === "oranje") return "gesprek";
    return null;
  }

  /* ---------- import ---------- */
  function readRoadmap(workbook) {
    const theme = themeColors(workbook);
    for (const ws of workbook.worksheets) {
      // Find the header row (the one with "Onderneming").
      let headerRow = null;
      for (let r = 1; r <= Math.min(ws.rowCount, 20) && !headerRow; r++) {
        ws.getRow(r).eachCell((cell) => { if (norm(cellText(cell.value)) === "onderneming") headerRow = r; });
      }
      if (!headerRow) continue;
      const columns = {};
      ws.getRow(headerRow).eachCell((cell, col) => {
        const field = HEADER_FIELDS[norm(cellText(cell.value))];
        if (field && !(field in columns)) columns[field] = col;
      });

      const result = { sheet: ws.name, leads: [], skipped: { red: [], nocolor: [], empty: 0 } };
      for (let r = headerRow + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const data = {};
        for (const [field, col] of Object.entries(columns)) {
          if (field !== "status") data[field] = cellText(row.getCell(col).value);
        }
        if (Object.values(data).every((v) => !v)) { result.skipped.empty++; continue; }
        // Rows without a company (e.g. trade fairs) use the name column as company.
        if (!data.company && data.contact_name) { data.company = data.contact_name; data.contact_name = ""; }
        // Old "Domein" values such as "Dealer Galabau" become Dealer › GaLa Bau.
        if (!data.subcategory) [data.category, data.subcategory] = Store.splitLegacyCategory(data.category);
        [data.category, data.subcategory] = Store.normalizeNames(data.category, data.subcategory);
        const label = `Rij ${r} (${data.company || "zonder naam"})`;

        const statusCell = columns.status ? row.getCell(columns.status) : null;
        const status = (statusCell && statusFromText(cellText(statusCell.value))) ||
          classifyColor(fillHex(statusCell, theme));
        if (status === "geen") { result.skipped.red.push(label); continue; }
        if (!status) { result.skipped.nocolor.push(label); continue; }
        data.status = status;
        result.leads.push({ label, data });
      }
      return result;
    }
    throw new Error("Geen roadmap-tabblad gevonden: er is geen kolom 'Onderneming'.");
  }

  /* ---------- export ---------- */
  // Order: categories and subcategories as in the taxonomy, unknown ones alphabetically after.
  function compareGroups(a, b) {
    const cats = Store.TAXONOMY.map(([c]) => c);
    const rank = (list, v) => { const i = list.indexOf(v); return i === -1 ? list.length : i; };
    const subs = (cat) => (Store.TAXONOMY.find(([c]) => c === cat) || [null, []])[1];
    const ca = a.category || "", cb = b.category || "";
    return rank(cats, ca) - rank(cats, cb) || ca.localeCompare(cb, "de") ||
      rank(subs(ca), a.subcategory || "") - rank(subs(ca), b.subcategory || "") ||
      (a.subcategory || "").localeCompare(b.subcategory || "", "de");
  }

  function sortLeads(leads) {
    return [...leads].sort((a, b) =>
      compareGroups(a, b) || a.company.localeCompare(b.company, "de", { sensitivity: "base" }));
  }

  function sheetName(name, used) {
    let base = String(name || Store.NO_CATEGORY).replace(/[\[\]:*?\/\\]/g, "-").slice(0, 31) || "Blad";
    let candidate = base, i = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${base.slice(0, 27)} (${i++})`;
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function addSheet(wb, name, leads, today) {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 4 }] });
    ws.columns = EXPORT_COLUMNS.map(([, , width]) => ({ width }));

    ws.mergeCells("A1:C1");
    Object.assign(ws.getCell("A1"), { value: "ROADMAP ACD DUITSLAND" });
    ws.getCell("A1").font = { bold: true, size: 14 };
    ws.mergeCells("H1:K1");
    ws.getCell("H1").value = "Legende: ROOD = geen samenwerking   |   ORANJE = gesprek   |   GROEN = samenwerking";
    ws.getCell("H1").font = { italic: true };
    ws.getCell("A2").value = "Update datum:";
    ws.getCell("A2").font = { bold: true };
    ws.getCell("B2").value = today;
    ws.getCell("B2").numFmt = "dd/mm/yyyy";
    ws.getCell("B2").alignment = { horizontal: "left" };

    const header = ws.getRow(4);
    EXPORT_COLUMNS.forEach(([title], i) => {
      const cell = header.getCell(i + 1);
      cell.value = title;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
      cell.alignment = { vertical: "middle", wrapText: true };
    });
    header.height = 22;

    const thin = { style: "thin", color: { argb: "FFD0D5DD" } };
    sortLeads(leads).forEach((lead, i) => {
      const row = ws.getRow(5 + i);
      EXPORT_COLUMNS.forEach(([, field], c) => {
        const cell = row.getCell(c + 1);
        let value = lead[field] || "";
        if (field === "status") {
          const info = STATUS_INFO[lead.status] || STATUS_INFO.gesprek;
          value = info.label;
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + info.color } };
          cell.font = { bold: true, color: { argb: lead.status === "gesprek" ? "FF000000" : "FFFFFFFF" } };
        }
        if (field === "next_action" && lead.next_action_date) {
          const [y, m, d] = lead.next_action_date.split("-");
          value = `${value}${value ? " " : ""}(tegen ${d}/${m}/${y})`;
        }
        cell.value = value;
        cell.alignment = { vertical: "top", wrapText: true };
        cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      });
    });
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: EXPORT_COLUMNS.length } };
    return ws;
  }

  /* options.groupBy: "category" or "subcategory" adds one tab per group after an overview tab. */
  function buildRoadmap(ExcelJS, leads, options = {}) {
    const wb = new ExcelJS.Workbook();
    wb.creator = "ACD Germany lead manager";
    const now = new Date();
    const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const used = new Set();
    const groupBy = options.groupBy;
    addSheet(wb, sheetName(groupBy ? "Overzicht" : "Roadmap", used), leads, today);
    if (groupBy) {
      const groups = new Map();
      for (const lead of sortLeads(leads)) {
        const key = groupBy === "subcategory" ? Store.groupKey(lead) : (lead.category || Store.NO_CATEGORY);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(lead);
      }
      for (const [cat, list] of groups) addSheet(wb, sheetName(cat, used), list, today);
    }
    return wb;
  }

  // Dutch federal-state names used in the roadmap -> German names (for the address lookup).
  const STATE_NAMES = {
    "baden-wurttemberg": "Baden-Württemberg", "baden-württemberg": "Baden-Württemberg",
    "baden-württenmberg": "Baden-Württemberg", "baden württemberg": "Baden-Württemberg",
    "beieren": "Bayern", "bayern": "Bayern",
    "berlijn": "Berlin", "berlin": "Berlin",
    "brandenburg": "Brandenburg", "bremen": "Bremen", "hamburg": "Hamburg",
    "hessen": "Hessen", "hessen (frankfurt)": "Hessen",
    "mecklenburg": "Mecklenburg-Vorpommern", "mecklenburg-voor-pommeren": "Mecklenburg-Vorpommern",
    "mecklenburg-vorpommern": "Mecklenburg-Vorpommern",
    "nedersaksen": "Niedersachsen", "niedersachsen": "Niedersachsen",
    "noordrijn-westfalen": "Nordrhein-Westfalen", "noordrijn westfalen": "Nordrhein-Westfalen",
    "nordrijn-westfalen": "Nordrhein-Westfalen", "nordrhein-westfalen": "Nordrhein-Westfalen",
    "rijnland-palts": "Rheinland-Pfalz", "rijnland palts": "Rheinland-Pfalz", "rheinland-pfalz": "Rheinland-Pfalz",
    "saarland": "Saarland",
    "saksen": "Sachsen", "sachsen": "Sachsen",
    "saksen-anhalt": "Sachsen-Anhalt", "sachsen-anhalt": "Sachsen-Anhalt",
    "sleeswijk-holstein": "Schleswig-Holstein", "schleswig-holstein": "Schleswig-Holstein",
    "thüringen": "Thüringen", "thuringen": "Thüringen", "thueringen": "Thüringen",
  };
  const germanState = (s) => STATE_NAMES[norm(s)] || "";

  // Search variants for a municipality, most specific first.
  function placeQueries(city, state) {
    const out = [];
    const add = (c, s) => {
      c = String(c || "").trim();
      if (c && !out.some((q) => q.city === c && q.state === s)) out.push({ city: c, state: s });
    };
    const st = germanState(state);
    const cleaned = String(city || "")
      .replace(/\(.*?\)/g, " ")
      .replace(/\s+(OT|Ot|ot)\s+.*$/, "")
      .split("/")[0].trim();
    if (st) add(city, st);
    add(city, "");
    if (st) add(cleaned, st);
    add(cleaned, "");
    // "Baiersbronn Obertal" -> "Baiersbronn", but keep names like "Bad Bellingen" whole.
    const first = cleaned.split(/\s+/)[0];
    if (first && first !== cleaned && first.length > 3 && !/^(bad|sankt|st\.?|neu|alt|groß|klein)$/i.test(first)) {
      add(first, st);
    }
    return out;
  }

  const api = {
    readRoadmap, buildRoadmap, classifyColor, cellText, placeQueries, germanState,
    STATUS_INFO, EXPORT_COLUMNS, compareGroups,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Roadmap = api;
})(typeof window !== "undefined" ? window : globalThis);
