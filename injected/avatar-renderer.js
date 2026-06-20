/**
 * Thundericon — injected renderer (runs inside about:3pane).
 *
 * Loaded via loadSubScript so `window`/`document` here are the message list's.
 * Publishes a singleton controller at `globalThis.__thundericon` with:
 *    apply(jsonConfig)  – (re)configure and render
 *    destroy()          – disconnect and remove all traces
 *
 * Performance contract (keeps the main thread free):
 *   - a single MutationObserver on the virtualized thread tbody
 *   - mutations are coalesced and processed in idle, time-sliced batches
 *   - rows are recycled, so each row's last sender is cached (WeakMap) and
 *     unchanged rows are skipped; decoration is idempotent
 *   - geometry/font come from inherited CSS variables set once on the root,
 *     so only per-sender color is written per badge
 */
(function () {
  "use strict";

  const win = globalThis;
  const doc = win.document;

  // Idempotent load: if we are already mounted, do nothing (start.js re-applies).
  if (win.__thundericon) {
    return;
  }

  const ROW_SELECTOR = 'tr[is="thread-row"], tr[is="thread-card"]';
  const Core = win.ThundericonCore;

  let settings = {};
  let domainColors = {};
  let tbody = null;
  let observer = null;
  let rowKeys = new WeakMap(); // row element -> last rendered sender key
  let pending = new Set(); // rows queued for (re)decoration
  let flushScheduled = false;
  let enabled = true; // gates all decoration; flipped by config

  /* ---- tbody discovery -------------------------------------------------- */

  function findTbody() {
    const table =
      doc.getElementById("threadTree") ||
      doc.querySelector('table[is="tree-view-table"]');
    if (table) {
      return (
        table.querySelector('tbody[is="tree-view-table-body"]') ||
        table.querySelector("tbody")
      );
    }
    return doc.querySelector('tbody[is="tree-view-table-body"]');
  }

  function ensureObserver(retries) {
    if (settings.enabled === false) {
      return;
    }
    if (!tbody || !tbody.isConnected) {
      tbody = findTbody();
    }
    if (!tbody) {
      if (retries > 0) {
        win.setTimeout(() => ensureObserver(retries - 1), 200);
      }
      return;
    }
    if (!observer) {
      observer = new win.MutationObserver(onMutations);
    } else {
      observer.disconnect();
    }
    observer.observe(tbody, {
      childList: true,
      subtree: true,
      characterData: true
    });
    enqueueAllRows();
  }

  /* ---- mutation handling ------------------------------------------------ */

  function onMutations(records) {
    for (const m of records) {
      const el = m.target && m.target.nodeType === 1 ? m.target : m.target && m.target.parentElement;
      // Ignore mutations we caused inside our own badges (re-entrancy guard).
      if (el && el.closest && el.closest(".ti-avatar")) {
        continue;
      }
      collectRow(el);
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) {
          continue;
        }
        if (node.classList && node.classList.contains("ti-avatar")) {
          continue;
        }
        collectRow(node);
      }
    }
    if (pending.size) {
      scheduleFlush();
    }
  }

  function collectRow(node) {
    let el = node;
    if (!el) {
      return;
    }
    if (el.nodeType !== 1) {
      el = el.parentElement;
    }
    if (!el || !el.closest) {
      return;
    }
    const row = el.matches(ROW_SELECTOR) ? el : el.closest(ROW_SELECTOR);
    if (row) {
      pending.add(row);
    }
  }

  /* ---- idle, time-sliced flush ----------------------------------------- */

  const requestIdle =
    win.requestIdleCallback ||
    ((cb) => win.setTimeout(() => cb({ timeRemaining: () => 8, didTimeout: true }), 16));

  function scheduleFlush() {
    if (flushScheduled) {
      return;
    }
    flushScheduled = true;
    requestIdle(flush, { timeout: 500 });
  }

  function flush(deadline) {
    flushScheduled = false;
    if (!enabled) {
      pending = new Set(); // drop anything queued before we were disabled
      return;
    }
    const rows = pending;
    pending = new Set();
    const list = [...rows];

    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      if (row.isConnected) {
        try {
          decorate(row);
        } catch (e) {
          /* never let one row break the batch */
        }
      }
      // Yield if we are about to overrun the idle slice; requeue the rest.
      if ((i & 31) === 31 && deadline && deadline.timeRemaining && deadline.timeRemaining() < 3) {
        for (let j = i + 1; j < list.length; j++) {
          pending.add(list[j]);
        }
        break;
      }
    }
    if (pending.size) {
      scheduleFlush();
    }
  }

  /* ---- decoration ------------------------------------------------------- */

  function classify(row) {
    if (row.matches('tr[is="thread-card"]')) {
      return "card";
    }
    if (row.matches('tr[is="thread-row"]')) {
      return "row";
    }
    return null;
  }

  function layoutEnabled(layout) {
    const L = settings.layouts || {};
    return layout === "card" ? L.cards !== false : L.table !== false;
  }

  function decorate(row) {
    if (!enabled) {
      return;
    }
    const layout = classify(row);
    if (!layout) {
      return;
    }
    const existing = findBadge(row);
    if (!layoutEnabled(layout)) {
      if (existing) {
        existing.remove();
        rowKeys.delete(row);
      }
      return;
    }

    const author = resolveAuthor(row);
    const desc = Core.describe(author, settings, domainColors);

    if (rowKeys.get(row) === desc.key && existing) {
      return; // recycled row, same sender, badge intact — nothing to do
    }
    rowKeys.set(row, desc.key);

    let badge = existing;
    if (!badge) {
      badge = doc.createElement("span");
      badge.className =
        "ti-avatar " + (layout === "card" ? "ti-avatar--card" : "ti-avatar--row");
      placeBadge(row, badge, layout);
    }
    badge.textContent = desc.initials;
    badge.style.setProperty("--ti-color", desc.background);
    badge.style.setProperty("--ti-fg", desc.foreground);
    badge.title = author || desc.initials;
  }

  function findBadge(row) {
    return row.querySelector(".ti-avatar");
  }

  function placeBadge(row, badge, layout) {
    if (layout === "card") {
      // Put the badge in the card's table cell as a *sibling* of the card
      // content (not inside .card-layout's grid), so CSS can lay the cell out as
      // [ avatar | existing 2-line card ] without disturbing the card.
      const content = row.querySelector(".card-layout");
      const cell = (content && content.closest("td")) || row.querySelector("td") || row;
      cell.prepend(badge);
      return;
    }
    const cell =
      row.querySelector("td.correspondentcol-column") ||
      row.querySelector("td.sendercol-column") ||
      row.querySelector("td.subjectcol-column") ||
      row.querySelector("td");
    if (cell) {
      cell.prepend(badge);
    }
  }

  /* ---- sender resolution ------------------------------------------------ */

  function rowIndex(row) {
    if (typeof row.index === "number") {
      return row.index;
    }
    if (typeof row._index === "number") {
      return row._index;
    }
    if (row.dataset && row.dataset.index != null && row.dataset.index !== "") {
      return parseInt(row.dataset.index, 10);
    }
    const aria = row.getAttribute && row.getAttribute("aria-rowindex");
    if (aria != null) {
      return parseInt(aria, 10) - 1; // aria-rowindex is 1-based incl. header
    }
    return -1;
  }

  function resolveAuthor(row) {
    // Preferred: the real header via the DB view — the only source of the email
    // address, which domain-to-color mappings need.
    try {
      const view = win.gDBView;
      const idx = rowIndex(row);
      if (view && idx >= 0) {
        const hdr = view.getMsgHdrAt(idx);
        if (hdr) {
          return hdr.mime2DecodedAuthor || hdr.author || "";
        }
      }
    } catch (e) {
      /* fall through to scraping */
    }
    // Fallback: scrape the visible correspondent text (display name only).
    const cell =
      row.querySelector(".correspondentcol-column") ||
      row.querySelector(".sendercol-column") ||
      row.querySelector(".recipientcol-column");
    if (cell) {
      return cellText(cell);
    }
    const sender = row.querySelector(".thread-card-sender, .sender, .card-sender");
    if (sender) {
      return cellText(sender);
    }
    return "";
  }

  // Read an element's text while ignoring any avatar badge we injected into it.
  function cellText(cell) {
    let text = "";
    for (const node of cell.childNodes) {
      if (
        node.nodeType === 1 &&
        node.classList &&
        node.classList.contains("ti-avatar")
      ) {
        continue;
      }
      text += node.textContent;
    }
    return text.trim();
  }

  /* ---- bulk operations -------------------------------------------------- */

  function enqueueAllRows() {
    const target = tbody && tbody.isConnected ? tbody : (tbody = findTbody());
    if (!target) {
      return;
    }
    for (const row of target.querySelectorAll(ROW_SELECTOR)) {
      pending.add(row);
    }
    if (pending.size) {
      scheduleFlush();
    }
  }

  function removeAllBadges() {
    const target = tbody || findTbody();
    if (!target) {
      return;
    }
    for (const badge of target.querySelectorAll(".ti-avatar")) {
      badge.remove();
    }
  }

  /* ---- config application ---------------------------------------------- */

  const ROOT_VARS = [
    "--ti-size",
    "--ti-radius",
    "--ti-font",
    "--ti-weight",
    "--ti-fontscale",
    "--ti-transform"
  ];

  function applyConfig(cfg) {
    cfg = cfg || {};
    settings = cfg.settings || {};
    domainColors = cfg.domainColors || {};

    const rootStyle = doc.documentElement.style;
    rootStyle.setProperty("--ti-size", (Number(settings.badgeSize) || 24) + "px");
    rootStyle.setProperty(
      "--ti-radius",
      (settings.borderRadius != null ? settings.borderRadius : 50) + "%"
    );
    rootStyle.setProperty("--ti-font", settings.fontFamily || "system-ui, sans-serif");
    rootStyle.setProperty("--ti-weight", String(settings.fontWeight || 600));
    rootStyle.setProperty("--ti-fontscale", String(settings.fontScale || 0.42));
    rootStyle.setProperty(
      "--ti-transform",
      settings.uppercase === false ? "none" : "uppercase"
    );

    // Force a full recompute: color mode / initials may have changed.
    rowKeys = new WeakMap();
    enabled = settings.enabled !== false;

    if (!enabled) {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      pending = new Set(); // cancel any in-flight flush work
      removeAllBadges();
      return;
    }

    ensureObserver(25); // ~5s of retries while about:3pane finishes loading
    enqueueAllRows();
  }

  /* ---- public controller ------------------------------------------------ */

  win.__thundericon = {
    apply(json) {
      try {
        applyConfig(typeof json === "string" ? JSON.parse(json) : json);
      } catch (e) {
        console.error("[Thundericon] apply failed:", e);
      }
    },
    destroy() {
      try {
        enabled = false; // stop any in-flight flush from re-decorating
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        removeAllBadges();
        const rootStyle = doc.documentElement.style;
        for (const v of ROOT_VARS) {
          rootStyle.removeProperty(v);
        }
        rowKeys = new WeakMap();
        pending = new Set();
      } catch (e) {
        /* best effort */
      }
    }
  };
})();
