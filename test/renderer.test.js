"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const CORE = fs.readFileSync(path.join(__dirname, "../src/avatar-core.js"), "utf8");
const RENDERER = fs.readFileSync(path.join(__dirname, "../injected/avatar-renderer.js"), "utf8");

const DEFAULT_CONFIG = {
  settings: {
    enabled: true,
    layouts: { table: true, cards: true },
    colorMode: "mutedPalette",
    fontFamily: "system-ui",
    fontWeight: 600,
    uppercase: true,
    fontScale: 0.42,
    badgeSize: 24,
    borderRadius: 50,
    initialsCount: 2,
    initialsSource: "displayName"
  },
  domainColors: {}
};

// Build a jsdom "about:3pane" with the avatar core + renderer loaded into it.
function setup() {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;
  const doc = window.document;

  const table = doc.createElement("table");
  table.id = "threadTree";
  table.setAttribute("is", "tree-view-table");
  const tbody = doc.createElement("tbody");
  tbody.setAttribute("is", "tree-view-table-body");
  table.appendChild(tbody);
  doc.body.appendChild(table);

  const authors = [];
  window.gDBView = {
    getMsgHdrAt(i) {
      return authors[i] != null ? { mime2DecodedAuthor: authors[i] } : null;
    }
  };

  window.eval(CORE);
  window.eval(RENDERER);

  return { window, doc, tbody, authors };
}

function addRow(doc, { index, kind = "row", text = "loading" }) {
  const tr = doc.createElement("tr");
  tr.setAttribute("is", kind === "card" ? "thread-card" : "thread-row");
  tr.index = index;
  const td = doc.createElement("td");
  td.className = "correspondentcol-column";
  if (kind === "card") {
    const card = doc.createElement("div");
    card.className = "card-layout";
    card.textContent = text;
    td.appendChild(card);
  } else {
    td.textContent = text;
  }
  tr.appendChild(td);
  return tr;
}

function badges(root, selector = ".ti-avatar") {
  return [...root.querySelectorAll(selector)];
}

async function waitFor(predicate, timeout = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

const settle = () => new Promise((r) => setTimeout(r, 60));

test("renders one badge per row with correct initials and palette color", async () => {
  const { window, doc, tbody, authors } = setup();
  const Core = window.ThundericonCore;
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG));

  authors[0] = "Ada Lovelace <ada@analytical.org>";
  authors[1] = "Grace Hopper <grace@navy.mil>";
  tbody.appendChild(addRow(doc, { index: 0 }));
  tbody.appendChild(addRow(doc, { index: 1 }));

  await waitFor(() => badges(tbody).length === 2);

  const rows = [...tbody.querySelectorAll('tr[is="thread-row"]')];
  assert.equal(rows[0].querySelectorAll(".ti-avatar").length, 1);
  assert.equal(rows[0].querySelector(".ti-avatar").textContent, "AL");
  assert.equal(rows[1].querySelector(".ti-avatar").textContent, "GH");

  const expected = Core.describe(authors[0], DEFAULT_CONFIG.settings, {});
  assert.equal(
    rows[0].querySelector(".ti-avatar").style.getPropertyValue("--ti-color"),
    expected.background
  );
});

test("does not create duplicate badges under repeated mutations", async () => {
  const { window, doc, tbody, authors } = setup();
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG));

  authors[0] = "Ada Lovelace <ada@x.org>";
  const row = addRow(doc, { index: 0 });
  tbody.appendChild(row);
  await waitFor(() => badges(tbody).length === 1);

  // Poke the row several times the way the tree might during repaint.
  for (let i = 0; i < 5; i++) {
    const filler = doc.createElement("td");
    filler.className = "datecol-column";
    filler.textContent = "now";
    row.appendChild(filler);
  }
  await settle();
  assert.equal(badges(tbody).length, 1, "still exactly one badge");
});

test("recycled row (same element, new sender) updates initials, stays single", async () => {
  const { window, doc, tbody, authors } = setup();
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG));

  authors[0] = "Ada Lovelace <ada@x.org>";
  const row = addRow(doc, { index: 0, text: "Ada Lovelace" });
  tbody.appendChild(row);
  await waitFor(() => row.querySelector(".ti-avatar") && row.querySelector(".ti-avatar").textContent === "AL");

  // Simulate virtualized recycle: the tree repoints the row to another message
  // and rewrites the cell text (which wipes our badge).
  authors[7] = "Bob Smith <bob@y.org>";
  row.index = 7;
  row.querySelector("td.correspondentcol-column").textContent = "Bob Smith";

  await waitFor(() => {
    const b = row.querySelector(".ti-avatar");
    return b && b.textContent === "BS";
  });
  assert.equal(row.querySelectorAll(".ti-avatar").length, 1);
});

test("unchanged recycled row keeps the same badge element (idempotent)", async () => {
  const { window, doc, tbody, authors } = setup();
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG));

  authors[0] = "Ada Lovelace <ada@x.org>";
  const row = addRow(doc, { index: 0 });
  tbody.appendChild(row);
  await waitFor(() => row.querySelector(".ti-avatar"));
  const first = row.querySelector(".ti-avatar");

  // Mutation that does NOT change the sender: append an unrelated cell.
  const extra = doc.createElement("td");
  extra.className = "subjectcol-column";
  extra.textContent = "Re: hi";
  row.appendChild(extra);
  await settle();

  const after = row.querySelector(".ti-avatar");
  assert.equal(after, first, "same badge node reused, not rebuilt");
  assert.equal(row.querySelectorAll(".ti-avatar").length, 1);
});

test("respects disabled card layout but still decorates table rows", async () => {
  const { window, doc, tbody, authors } = setup();
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.settings.layouts.cards = false;
  window.__thundericon.apply(JSON.stringify(cfg));

  authors[0] = "Card Person <card@x.org>";
  authors[1] = "Row Person <row@x.org>";
  const card = addRow(doc, { index: 0, kind: "card" });
  const row = addRow(doc, { index: 1, kind: "row" });
  tbody.appendChild(card);
  tbody.appendChild(row);

  await waitFor(() => row.querySelector(".ti-avatar"));
  await settle();
  assert.equal(card.querySelectorAll(".ti-avatar").length, 0, "card not decorated");
  assert.equal(row.querySelectorAll(".ti-avatar").length, 1, "row decorated");
});

test("card rows place the badge inside the card layout", async () => {
  const { window, doc, tbody, authors } = setup();
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG));

  authors[0] = "Cards View <cv@x.org>";
  const card = addRow(doc, { index: 0, kind: "card" });
  tbody.appendChild(card);

  await waitFor(() => card.querySelector(".card-layout .ti-avatar"));
  const badge = card.querySelector(".ti-avatar");
  assert.ok(badge.classList.contains("ti-avatar--card"));
  assert.equal(badge.textContent, "CV");
});

test("applies geometry through root CSS variables", async () => {
  const { window, doc } = setup();
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.settings.badgeSize = 30;
  cfg.settings.borderRadius = 0;
  cfg.settings.uppercase = false;
  window.__thundericon.apply(JSON.stringify(cfg));

  const root = doc.documentElement.style;
  assert.equal(root.getPropertyValue("--ti-size"), "30px");
  assert.equal(root.getPropertyValue("--ti-radius"), "0%");
  assert.equal(root.getPropertyValue("--ti-transform"), "none");
});

test("scrapes the correspondent cell when gDBView is unavailable", async () => {
  const { window, doc, tbody } = setup();
  delete window.gDBView; // force the fallback path
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG));

  const row = addRow(doc, { index: 0, text: "Acme Bot" });
  tbody.appendChild(row);

  await waitFor(() => row.querySelector(".ti-avatar"));
  assert.equal(row.querySelector(".ti-avatar").textContent, "AB");
});

test("disabling via config removes all badges; re-enabling restores them", async () => {
  const { window, doc, tbody, authors } = setup();
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG));
  authors[0] = "Ada Lovelace <ada@x.org>";
  tbody.appendChild(addRow(doc, { index: 0 }));
  await waitFor(() => badges(tbody).length === 1);

  const off = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  off.settings.enabled = false;
  window.__thundericon.apply(JSON.stringify(off));
  await settle();
  assert.equal(badges(tbody).length, 0, "all badges removed when disabled");

  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG));
  await waitFor(() => badges(tbody).length === 1);
  assert.equal(badges(tbody).length, 1, "restored when re-enabled");
});

test("destroy() removes every badge and clears root variables", async () => {
  const { window, doc, tbody, authors } = setup();
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG));
  authors[0] = "Ada Lovelace <ada@x.org>";
  tbody.appendChild(addRow(doc, { index: 0 }));
  await waitFor(() => badges(tbody).length === 1);

  window.__thundericon.destroy();
  await settle();
  assert.equal(badges(tbody).length, 0);
  assert.equal(doc.documentElement.style.getPropertyValue("--ti-size"), "");
});
