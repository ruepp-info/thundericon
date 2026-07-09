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
  const folderFlags = [];
  const readStates = []; // per-index isRead (boolean) or undefined = unknown
  window.gDBView = {
    getMsgHdrAt(i) {
      return authors[i] != null
        ? {
            mime2DecodedAuthor: authors[i],
            messageId: "msg-" + i + "@test",
            folder: { flags: folderFlags[i] || 0 },
            isRead: readStates[i]
          }
        : null;
    }
  };

  window.eval(CORE);
  window.eval(RENDERER);

  return { window, doc, tbody, authors, folderFlags, readStates };
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

test("card rows place the badge in the cell, beside (not inside) the card content", async () => {
  const { window, doc, tbody, authors } = setup();
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG));

  authors[0] = "Cards View <cv@x.org>";
  const card = addRow(doc, { index: 0, kind: "card" });
  tbody.appendChild(card);

  await waitFor(() => card.querySelector(".ti-avatar"));
  const badge = card.querySelector(".ti-avatar");
  assert.ok(badge.classList.contains("ti-avatar--card"));
  assert.equal(badge.textContent, "CV");
  // Sibling of .card-layout inside the same <td>, inserted first.
  assert.equal(badge.parentElement.tagName, "TD");
  assert.equal(badge.parentElement.firstElementChild, badge);
  assert.ok(badge.nextElementSibling.classList.contains("card-layout"));
  // The card cell exposes the sender colour for the rowTint style.
  assert.match(badge.parentElement.style.getPropertyValue("--ti-row-color"), /^#[0-9a-f]{6}$/);
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

/* ---- unread emphasis (Cards layout) ----------------------------------- */

// DEFAULT_CONFIG omits the unread keys, so the renderer's `!== false` default
// leaves emphasis ON — enough for the marker-class tests below.

test("card badges get ti-avatar--unread / --read from the header read state", async () => {
  const { window, doc, tbody, authors, readStates } = setup();
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG));

  authors[0] = "Unread Person <u@x.org>";
  readStates[0] = false;
  authors[1] = "Read Person <r@x.org>";
  readStates[1] = true;
  const unreadCard = addRow(doc, { index: 0, kind: "card" });
  const readCard = addRow(doc, { index: 1, kind: "card" });
  tbody.append(unreadCard, readCard);

  await waitFor(() => badges(tbody).length === 2);
  const ub = unreadCard.querySelector(".ti-avatar");
  const rb = readCard.querySelector(".ti-avatar");
  assert.ok(ub.classList.contains("ti-avatar--unread"));
  assert.ok(!ub.classList.contains("ti-avatar--read"));
  assert.ok(rb.classList.contains("ti-avatar--read"));
  assert.ok(!rb.classList.contains("ti-avatar--unread"));
});

test("table rows never get the unread/read marker classes (Cards only)", async () => {
  const { window, doc, tbody, authors, readStates } = setup();
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG));

  authors[0] = "Unread Row <u@x.org>";
  readStates[0] = false;
  const row = addRow(doc, { index: 0, kind: "row" });
  tbody.appendChild(row);

  await waitFor(() => row.querySelector(".ti-avatar"));
  const b = row.querySelector(".ti-avatar");
  assert.ok(!b.classList.contains("ti-avatar--unread"));
  assert.ok(!b.classList.contains("ti-avatar--read"));
});

test("marking a card read swaps --unread for --read on the same badge", async () => {
  const { window, doc, tbody, authors, readStates } = setup();
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG));

  authors[0] = "Person <p@x.org>";
  readStates[0] = false;
  const card = addRow(doc, { index: 0, kind: "card", text: "Person" });
  tbody.appendChild(card);
  await waitFor(() => {
    const b = card.querySelector(".ti-avatar");
    return b && b.classList.contains("ti-avatar--unread");
  });
  const before = card.querySelector(".ti-avatar");

  // Mark read: flip the header bit and rewrite the card text the way Thunderbird
  // repaints a row on read (fires a childList mutation → re-decoration).
  readStates[0] = true;
  card.querySelector(".card-layout").textContent = "Person";

  await waitFor(() => {
    const b = card.querySelector(".ti-avatar");
    return b && b.classList.contains("ti-avatar--read");
  });
  const after = card.querySelector(".ti-avatar");
  assert.equal(after, before, "same badge node reused");
  assert.ok(!after.classList.contains("ti-avatar--unread"));
  assert.equal(card.querySelectorAll(".ti-avatar").length, 1);
});

test("unreadEmphasis:false adds no marker classes and clears the root style token", async () => {
  const { window, doc, tbody, authors, readStates } = setup();
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.settings.unreadEmphasis = false;
  window.__thundericon.apply(JSON.stringify(cfg));

  authors[0] = "Person <p@x.org>";
  readStates[0] = false;
  const card = addRow(doc, { index: 0, kind: "card" });
  tbody.appendChild(card);

  await waitFor(() => card.querySelector(".ti-avatar"));
  await settle();
  const b = card.querySelector(".ti-avatar");
  assert.ok(!b.classList.contains("ti-avatar--unread"));
  assert.ok(!b.classList.contains("ti-avatar--read"));
  assert.equal(doc.documentElement.dataset.tiUnreadStyle, undefined);
});

test("applyConfig sets the accent color and style tokens on the root", async () => {
  const { window, doc } = setup();
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.settings.unreadEmphasis = true;
  cfg.settings.unreadStyle = "barFade";
  cfg.settings.unreadAccentColor = "#123456";
  cfg.settings.unreadBarWidth = "wide";
  window.__thundericon.apply(JSON.stringify(cfg));
  assert.equal(doc.documentElement.dataset.tiUnreadStyle, "bar fade");
  assert.equal(doc.documentElement.style.getPropertyValue("--ti-unread-accent"), "#123456");
  assert.equal(doc.documentElement.style.getPropertyValue("--ti-unread-bar-width"), "6px");

  cfg.settings.unreadStyle = "ring";
  window.__thundericon.apply(JSON.stringify(cfg));
  assert.equal(doc.documentElement.dataset.tiUnreadStyle, "ring");

  cfg.settings.unreadStyle = "dot";
  window.__thundericon.apply(JSON.stringify(cfg));
  assert.equal(doc.documentElement.dataset.tiUnreadStyle, "dot");

  cfg.settings.unreadStyle = "glyph";
  cfg.settings.unreadGlyph = "★";
  cfg.settings.unreadGlyphSize = 20;
  cfg.settings.unreadGlyphBold = true;
  window.__thundericon.apply(JSON.stringify(cfg));
  const rootStyle = doc.documentElement.style;
  assert.equal(doc.documentElement.dataset.tiUnreadStyle, "glyph");
  assert.equal(rootStyle.getPropertyValue("--ti-unread-glyph"), '"★"');
  assert.equal(rootStyle.getPropertyValue("--ti-unread-glyph-size"), "20px");
  assert.equal(rootStyle.getPropertyValue("--ti-unread-glyph-weight"), "700");

  cfg.settings.unreadStyle = "fill";
  cfg.settings.unreadFillMode = "iconColor";
  cfg.settings.unreadFillColor = "#123456";
  window.__thundericon.apply(JSON.stringify(cfg));
  assert.equal(doc.documentElement.dataset.tiUnreadStyle, "fill");
  assert.equal(doc.documentElement.dataset.tiFillMode, "iconColor");
  assert.equal(rootStyle.getPropertyValue("--ti-unread-fill"), "#123456");
  assert.ok(rootStyle.getPropertyValue("--ti-unread-fill-fg"));

  cfg.settings.unreadStyle = "rowTint";
  window.__thundericon.apply(JSON.stringify(cfg));
  assert.equal(doc.documentElement.dataset.tiUnreadStyle, "rowTint");
  assert.equal(doc.documentElement.dataset.tiFillMode, "iconColor");
});

/* ---- BIMI logo branch ------------------------------------------------- */

function bimiConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.settings.bimiEnabled = true;
  cfg.settings.bimiRefreshHours = 24;
  return cfg;
}

test("renders a BIMI logo image when the host resolves one, initials otherwise", async () => {
  const { window, doc, tbody, authors } = setup();
  const LOGO = "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E";
  window.__thundericonHost = {
    resolveBimi(domain, hdr, cb) {
      cb(domain === "brand.com" ? LOGO : null);
    }
  };
  window.__thundericon.apply(JSON.stringify(bimiConfig()));

  authors[0] = "Brand Co <hello@brand.com>";
  authors[1] = "Plain Person <p@plain.org>";
  tbody.appendChild(addRow(doc, { index: 0 }));
  tbody.appendChild(addRow(doc, { index: 1 }));

  await waitFor(() => tbody.querySelector(".ti-avatar--bimi img"));
  await settle();

  const rows = [...tbody.querySelectorAll('tr[is="thread-row"]')];
  const logoBadge = rows[0].querySelector(".ti-avatar");
  assert.ok(logoBadge.classList.contains("ti-avatar--bimi"));
  const img = logoBadge.querySelector("img");
  assert.ok(img, "logo row has an <img>");
  assert.equal(img.getAttribute("src"), LOGO);
  assert.equal(logoBadge.textContent, "", "initials text cleared under the logo");
  assert.equal(rows[0].querySelectorAll(".ti-avatar").length, 1);

  const plainBadge = rows[1].querySelector(".ti-avatar");
  assert.equal(plainBadge.querySelector("img"), null);
  assert.equal(plainBadge.textContent, "PP");
  assert.ok(!plainBadge.classList.contains("ti-avatar--bimi"));
});

test("DMARC gate is per-message: a spoofed message keeps initials though the domain has a logo", async () => {
  const { window, doc, tbody, authors } = setup();
  const LOGO = "data:image/svg+xml,logo";
  window.__thundericonHost = {
    resolveBimi(domain, hdr, cb) {
      // Same domain for both, but only the authenticated message gets the logo.
      cb(hdr.messageId === "msg-0@test" ? LOGO : null);
    }
  };
  window.__thundericon.apply(JSON.stringify(bimiConfig()));

  authors[0] = "Real Brand <hi@brand.com>"; // passes the gate
  authors[1] = "Spoofed Brand <hi@brand.com>"; // fails -> initials
  tbody.appendChild(addRow(doc, { index: 0 }));
  tbody.appendChild(addRow(doc, { index: 1 }));

  await waitFor(() => tbody.querySelector(".ti-avatar--bimi img"));
  await settle();

  const rows = [...tbody.querySelectorAll('tr[is="thread-row"]')];
  assert.ok(rows[0].querySelector("img"), "authenticated message shows the logo");
  assert.equal(rows[1].querySelector("img"), null, "spoofed message shows initials");
  assert.ok(!rows[1].querySelector(".ti-avatar").classList.contains("ti-avatar--bimi"));
});

test("does not consult the host when BIMI is disabled", async () => {
  const { window, doc, tbody, authors } = setup();
  let calls = 0;
  window.__thundericonHost = {
    resolveBimi() {
      calls++;
    }
  };
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG)); // bimiEnabled absent => off

  authors[0] = "Brand Co <hello@brand.com>";
  tbody.appendChild(addRow(doc, { index: 0 }));
  await waitFor(() => tbody.querySelector(".ti-avatar"));
  await settle();

  assert.equal(calls, 0, "host never called while BIMI is off");
  assert.equal(tbody.querySelector(".ti-avatar").textContent, "BC");
});

test("disabling BIMI reverts a shown logo back to initials", async () => {
  const { window, doc, tbody, authors } = setup();
  window.__thundericonHost = {
    resolveBimi(domain, hdr, cb) {
      cb("data:image/svg+xml,logo");
    }
  };
  window.__thundericon.apply(JSON.stringify(bimiConfig()));

  authors[0] = "Brand Co <hello@brand.com>";
  const row = addRow(doc, { index: 0 });
  tbody.appendChild(row);
  await waitFor(() => row.querySelector(".ti-avatar--bimi img"));

  const off = bimiConfig();
  off.settings.bimiEnabled = false;
  window.__thundericon.apply(JSON.stringify(off));

  await waitFor(() => {
    const b = row.querySelector(".ti-avatar");
    return b && !b.classList.contains("ti-avatar--bimi") && b.textContent === "BC";
  });
  assert.equal(row.querySelector("img"), null, "logo <img> removed");
  assert.equal(row.querySelectorAll(".ti-avatar").length, 1);
});

test("skips BIMI lookups in excluded folders (Sent) and keeps initials", async () => {
  const { window, doc, tbody, authors, folderFlags } = setup();
  let calls = 0;
  window.__thundericonHost = {
    resolveBimi(domain, hdr, cb) {
      calls++;
      cb("data:image/svg+xml,logo");
    }
  };
  const cfg = bimiConfig();
  cfg.settings.bimiSkipFolders = { sent: true };
  window.__thundericon.apply(JSON.stringify(cfg));

  authors[0] = "Brand Co <hello@brand.com>";
  folderFlags[0] = 0x00000200; // nsMsgFolderFlags.SentMail
  tbody.appendChild(addRow(doc, { index: 0 }));
  await waitFor(() => tbody.querySelector(".ti-avatar"));
  await settle();

  assert.equal(calls, 0, "host never consulted for an excluded folder");
  const badge = tbody.querySelector(".ti-avatar");
  assert.equal(badge.querySelector("img"), null);
  assert.equal(badge.textContent, "BC");
});

test("still resolves BIMI in a non-excluded folder (Inbox)", async () => {
  const { window, doc, tbody, authors, folderFlags } = setup();
  window.__thundericonHost = {
    resolveBimi(domain, hdr, cb) {
      cb("data:image/svg+xml,logo");
    }
  };
  const cfg = bimiConfig();
  cfg.settings.bimiSkipFolders = { sent: true, drafts: true, junk: true };
  window.__thundericon.apply(JSON.stringify(cfg));

  authors[0] = "Brand Co <hello@brand.com>";
  folderFlags[0] = 0x00001000; // nsMsgFolderFlags.Inbox — not excluded
  tbody.appendChild(addRow(doc, { index: 0 }));
  await waitFor(() => tbody.querySelector(".ti-avatar--bimi img"));
  assert.ok(tbody.querySelector(".ti-avatar--bimi img"));
});

/* ---- Gravatar photo branch -------------------------------------------- */

function gravatarConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.settings.gravatarEnabled = true;
  cfg.settings.gravatarRefreshHours = 168;
  return cfg;
}

test("renders a Gravatar photo when the host resolves one, initials otherwise", async () => {
  const { window, doc, tbody, authors } = setup();
  const PHOTO = "data:image/png;base64,iVBORw0KGgo=";
  window.__thundericonHost = {
    resolveGravatar(email, cb) {
      cb(email === "gp@photos.test" ? PHOTO : null);
    }
  };
  window.__thundericon.apply(JSON.stringify(gravatarConfig()));

  authors[0] = "Gravatar Person <gp@photos.test>";
  authors[1] = "Plain Person <p@plain.org>";
  tbody.appendChild(addRow(doc, { index: 0 }));
  tbody.appendChild(addRow(doc, { index: 1 }));

  await waitFor(() => tbody.querySelector(".ti-avatar--photo img"));
  await settle();

  const rows = [...tbody.querySelectorAll('tr[is="thread-row"]')];
  const photoBadge = rows[0].querySelector(".ti-avatar");
  assert.ok(photoBadge.classList.contains("ti-avatar--photo"));
  assert.ok(!photoBadge.classList.contains("ti-avatar--bimi"));
  const img = photoBadge.querySelector("img");
  assert.ok(img, "photo row has an <img>");
  assert.equal(img.getAttribute("src"), PHOTO);
  assert.equal(photoBadge.textContent, "", "initials text cleared under the photo");
  assert.equal(rows[0].querySelectorAll(".ti-avatar").length, 1);

  const plainBadge = rows[1].querySelector(".ti-avatar");
  assert.equal(plainBadge.querySelector("img"), null);
  assert.equal(plainBadge.textContent, "PP");
  assert.ok(!plainBadge.classList.contains("ti-avatar--photo"));
});

test("Gravatar photo takes precedence over a BIMI logo when both resolve", async () => {
  const { window, doc, tbody, authors } = setup();
  const PHOTO = "data:image/png;base64,photo";
  const LOGO = "data:image/svg+xml,logo";
  window.__thundericonHost = {
    resolveGravatar(email, cb) {
      cb(PHOTO);
    },
    resolveBimi(domain, hdr, cb) {
      cb(LOGO);
    }
  };
  const cfg = gravatarConfig();
  cfg.settings.bimiEnabled = true;
  window.__thundericon.apply(JSON.stringify(cfg));

  authors[0] = "Both Co <hi@both.test>";
  const row = addRow(doc, { index: 0 });
  tbody.appendChild(row);

  await waitFor(() => row.querySelector(".ti-avatar--photo img"));
  await settle();

  const badge = row.querySelector(".ti-avatar");
  assert.ok(badge.classList.contains("ti-avatar--photo"), "shows the photo");
  assert.ok(!badge.classList.contains("ti-avatar--bimi"), "not the logo");
  assert.equal(badge.querySelector("img").getAttribute("src"), PHOTO);
  assert.equal(row.querySelectorAll(".ti-avatar").length, 1);
});

test("falls back to the BIMI logo when there is no Gravatar photo", async () => {
  const { window, doc, tbody, authors } = setup();
  const LOGO = "data:image/svg+xml,logo";
  window.__thundericonHost = {
    resolveGravatar(email, cb) {
      cb(null); // no photo
    },
    resolveBimi(domain, hdr, cb) {
      cb(LOGO);
    }
  };
  const cfg = gravatarConfig();
  cfg.settings.bimiEnabled = true;
  window.__thundericon.apply(JSON.stringify(cfg));

  authors[0] = "Brand Co <hi@brand.test>";
  const row = addRow(doc, { index: 0 });
  tbody.appendChild(row);

  await waitFor(() => row.querySelector(".ti-avatar--bimi img"));
  const badge = row.querySelector(".ti-avatar");
  assert.ok(badge.classList.contains("ti-avatar--bimi"));
  assert.ok(!badge.classList.contains("ti-avatar--photo"));
  assert.equal(badge.querySelector("img").getAttribute("src"), LOGO);
});

test("does not consult the host for Gravatar when it is disabled", async () => {
  const { window, doc, tbody, authors } = setup();
  let calls = 0;
  window.__thundericonHost = {
    resolveGravatar() {
      calls++;
    }
  };
  window.__thundericon.apply(JSON.stringify(DEFAULT_CONFIG)); // gravatarEnabled absent => off

  authors[0] = "Gravatar Person <gp@photos.test>";
  tbody.appendChild(addRow(doc, { index: 0 }));
  await waitFor(() => tbody.querySelector(".ti-avatar"));
  await settle();

  assert.equal(calls, 0, "host never called while Gravatar is off");
  assert.equal(tbody.querySelector(".ti-avatar").textContent, "GP");
});

test("skips Gravatar lookups in excluded folders (Sent) and keeps initials", async () => {
  const { window, doc, tbody, authors, folderFlags } = setup();
  let calls = 0;
  window.__thundericonHost = {
    resolveGravatar(email, cb) {
      calls++;
      cb("data:image/png;base64,photo");
    }
  };
  const cfg = gravatarConfig();
  cfg.settings.gravatarSkipFolders = { sent: true };
  window.__thundericon.apply(JSON.stringify(cfg));

  authors[0] = "Gravatar Person <gp@photos.test>";
  folderFlags[0] = 0x00000200; // nsMsgFolderFlags.SentMail
  tbody.appendChild(addRow(doc, { index: 0 }));
  await waitFor(() => tbody.querySelector(".ti-avatar"));
  await settle();

  assert.equal(calls, 0, "host never consulted for an excluded folder");
  const badge = tbody.querySelector(".ti-avatar");
  assert.equal(badge.querySelector("img"), null);
  assert.equal(badge.textContent, "GP");
});

test("disabling Gravatar reverts a shown photo back to initials", async () => {
  const { window, doc, tbody, authors } = setup();
  window.__thundericonHost = {
    resolveGravatar(email, cb) {
      cb("data:image/png;base64,photo");
    }
  };
  window.__thundericon.apply(JSON.stringify(gravatarConfig()));

  authors[0] = "Gravatar Person <gp@photos.test>";
  const row = addRow(doc, { index: 0 });
  tbody.appendChild(row);
  await waitFor(() => row.querySelector(".ti-avatar--photo img"));

  const off = gravatarConfig();
  off.settings.gravatarEnabled = false;
  window.__thundericon.apply(JSON.stringify(off));

  await waitFor(() => {
    const b = row.querySelector(".ti-avatar");
    return b && !b.classList.contains("ti-avatar--photo") && b.textContent === "GP";
  });
  assert.equal(row.querySelector("img"), null, "photo <img> removed");
  assert.equal(row.querySelectorAll(".ti-avatar").length, 1);
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
