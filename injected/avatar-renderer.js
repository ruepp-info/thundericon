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

  // nsMsgFolderFlags values used to skip BIMI/Gravatar lookups by folder role.
  // Kept as raw numbers so the renderer needs no privileged Ci access.
  const FOLDER_FLAGS = {
    sent: 0x00000200,
    drafts: 0x00000400,
    templates: 0x00400000,
    outbox: 0x00000800,
    junk: 0x40000000,
    trash: 0x00000100
  };

  let settings = {};
  let domainColors = {};
  let tbody = null;
  let observer = null;
  let rowKeys = new WeakMap(); // row element -> last rendered signature
  let pending = new Set(); // rows queued for (re)decoration
  let flushScheduled = false;
  let enabled = true; // gates all decoration; flipped by config
  let unreadOn = false; // unread-emphasis feature (Cards layout); set by config

  // BIMI: resolution is async and gated per-message by DMARC (a domain may have a
  // logo, yet a spoofed message from it must still show initials). So results are
  // cached by message-id, NOT by domain. Values: string data URL (show logo) or
  // null (resolved, no logo → initials). The privileged experiment owns the real
  // DNS/SVG cache; this just avoids re-crossing the bridge for a known message.
  let bimiEnabled = false;
  let bimiByMsg = new Map(); // messageId -> dataURL string | null
  let bimiPendingMsg = new Set(); // messageId currently being resolved

  // Gravatar: like BIMI, resolution is async and per-message, but keyed on the
  // sender address (the host hashes it). Photos take precedence over BIMI logos.
  let gravatarEnabled = false;
  let gravatarByMsg = new Map(); // messageId -> dataURL string | null
  let gravatarPendingMsg = new Set(); // messageId currently being resolved

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

    const hdr = getMsgHdr(row);
    const author = authorFrom(hdr, row);
    const desc = Core.describe(author, settings, domainColors);

    // Unread emphasis (Cards layout only). Read state comes straight off the
    // header; when it's unknown (gDBView unavailable → scraped fallback) we mark
    // neither, so a message is never mislabeled read/unread. `stateTag` folds
    // into the recycle signature below so a read<->unread flip repaints the row.
    const knownRead = hdr && typeof hdr.isRead === "boolean";
    const unread = layout === "card" && unreadOn && knownRead && hdr.isRead === false;
    const read = layout === "card" && unreadOn && knownRead && hdr.isRead === true;
    const stateTag = unreadOn ? (unread ? "|U" : read ? "|R" : "|?") : "";

    // Gravatar / BIMI are active for this row unless its folder is excluded
    // (own/untrusted mail like Sent, Drafts or Junk).
    const gravatarOn = gravatarEnabled && !folderSkipped(hdr, settings.gravatarSkipFolders);
    const bimiOn = bimiEnabled && !folderSkipped(hdr, settings.bimiSkipFolders);

    // Pick the image to show for this specific message, if already resolved.
    // Precedence: Gravatar photo > BIMI logo > initials. A map entry whose value
    // is null means "resolved, nothing to show" → fall through to the next source.
    const msgId = hdr && hdr.messageId ? hdr.messageId : "";
    let img = null;
    let kind = "";
    if (gravatarOn && msgId && gravatarByMsg.get(msgId)) {
      img = gravatarByMsg.get(msgId);
      kind = "photo";
    } else if (bimiOn && msgId && bimiByMsg.get(msgId)) {
      img = bimiByMsg.get(msgId);
      kind = "bimi";
    }

    // Signature folds in which image we render, so an async image arriving
    // (initials -> photo/logo) still triggers a re-render on the recycled-row
    // fast path, as does a photo superseding a logo.
    const sig = desc.key + (img ? (kind === "photo" ? "|G" : "|B") : "|I") + stateTag;
    if (rowKeys.get(row) === sig && existing) {
      return; // recycled row, identical render — nothing to do
    }
    rowKeys.set(row, sig);

    let badge = existing;
    if (!badge) {
      badge = doc.createElement("span");
      badge.className =
        "ti-avatar " + (layout === "card" ? "ti-avatar--card" : "ti-avatar--row");
      placeBadge(row, badge, layout);
    }
    if (img) {
      renderLogo(badge, img, author || desc.initials, kind);
    } else {
      renderInitials(badge, desc, author);
    }

    // Read/unread marker classes (Cards only). CSS in avatars.css keys off these
    // plus the root `data-ti-unread-style` tokens; toggling false removes them, so
    // disabling the feature (a config push resets rowKeys → re-decorates all rows)
    // strips them cleanly.
    badge.classList.toggle("ti-avatar--unread", unread);
    badge.classList.toggle("ti-avatar--read", read);

    // Not yet resolved → ask the privileged host. Both run in parallel; negative
    // results are cached, so this converges (and stays cheap) once all are known.
    if (gravatarOn && msgId && hdr && !gravatarByMsg.has(msgId)) {
      requestGravatar(desc.email, msgId);
    }
    if (bimiOn && msgId && hdr && !bimiByMsg.has(msgId)) {
      requestBimi(desc.email, hdr, msgId);
    }
  }

  // Should a lookup be skipped for this message because of its folder? Reads the
  // message folder's flags and matches them against the given skip set.
  function folderSkipped(hdr, skip) {
    let flags = 0;
    try {
      if (hdr && hdr.folder) {
        flags = hdr.folder.flags || 0;
      }
    } catch (e) {
      return false; // can't tell → don't skip
    }
    if (!flags) {
      return false;
    }
    skip = skip || {};
    for (const key in FOLDER_FLAGS) {
      if (skip[key] && (flags & FOLDER_FLAGS[key]) !== 0) {
        return true;
      }
    }
    return false;
  }

  function renderInitials(badge, desc, author) {
    badge.classList.remove("ti-avatar--bimi");
    badge.classList.remove("ti-avatar--photo");
    const img = badge.querySelector("img");
    if (img) {
      img.remove();
    }
    badge.textContent = desc.initials;
    badge.style.setProperty("--ti-color", desc.background);
    badge.style.setProperty("--ti-fg", desc.foreground);
    badge.title = author || desc.initials;
  }

  // Swap initials for an image. `kind` selects the styling: "photo" (Gravatar,
  // cropped to fill) or "bimi" (brand logo, contained with transparent padding).
  function renderLogo(badge, dataUrl, title, kind) {
    const photo = kind === "photo";
    badge.classList.toggle("ti-avatar--photo", photo);
    badge.classList.toggle("ti-avatar--bimi", !photo);
    badge.textContent = "";
    let img = badge.querySelector("img");
    if (!img) {
      img = doc.createElement("img");
      img.decoding = "async";
      img.alt = "";
      badge.appendChild(img);
    }
    if (img.getAttribute("src") !== dataUrl) {
      img.setAttribute("src", dataUrl);
    }
    badge.title = title || "";
  }

  // Ask the privileged experiment to resolve a BIMI logo for this message. The
  // host enforces the DMARC gate and owns the TTL'd DNS/SVG cache; we just record
  // the per-message answer and re-scan visible rows when a logo actually arrives.
  function requestBimi(email, hdr, msgId) {
    const host = win.__thundericonHost;
    if (!host || typeof host.resolveBimi !== "function") {
      return;
    }
    const domain = email ? Core.domainOf(email) : "";
    if (!domain || bimiPendingMsg.has(msgId)) {
      return;
    }
    bimiPendingMsg.add(msgId);
    try {
      host.resolveBimi(domain, hdr, (dataUrl) => {
        bimiPendingMsg.delete(msgId);
        if (!bimiEnabled) {
          return; // disabled while in flight
        }
        bimiByMsg.set(msgId, dataUrl || null);
        // Only a positive result changes what is on screen (rows show initials by
        // default); re-enqueue so the matching row swaps in its logo. Idle-batched
        // and deduped, so this stays cheap and converges once all are cached.
        if (dataUrl) {
          enqueueAllRows();
        }
      });
    } catch (e) {
      bimiPendingMsg.delete(msgId);
    }
  }

  // Ask the privileged experiment to resolve a Gravatar photo for this message.
  // The host hashes the address and owns the TTL'd image cache; we record the
  // per-message answer and re-scan visible rows when a photo actually arrives.
  function requestGravatar(email, msgId) {
    const host = win.__thundericonHost;
    if (!host || typeof host.resolveGravatar !== "function") {
      return;
    }
    if (!email || gravatarPendingMsg.has(msgId)) {
      return;
    }
    gravatarPendingMsg.add(msgId);
    try {
      host.resolveGravatar(email, (dataUrl) => {
        gravatarPendingMsg.delete(msgId);
        if (!gravatarEnabled) {
          return; // disabled while in flight
        }
        gravatarByMsg.set(msgId, dataUrl || null);
        // Only a positive result changes what is on screen (rows show initials or
        // a BIMI logo by default); re-enqueue so the matching row swaps in its
        // photo. Idle-batched and deduped, so this stays cheap and converges.
        if (dataUrl) {
          enqueueAllRows();
        }
      });
    } catch (e) {
      gravatarPendingMsg.delete(msgId);
    }
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

  // The real message header via the DB view — the only source of the email
  // address (domain→color, BIMI) and message-id (BIMI/DMARC). May be null.
  function getMsgHdr(row) {
    try {
      const view = win.gDBView;
      const idx = rowIndex(row);
      if (view && idx >= 0) {
        return view.getMsgHdrAt(idx) || null;
      }
    } catch (e) {
      /* fall through; caller scrapes the visible text */
    }
    return null;
  }

  function authorFrom(hdr, row) {
    if (hdr) {
      const a = hdr.mime2DecodedAuthor || hdr.author || "";
      if (a) {
        return a;
      }
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
    "--ti-transform",
    "--ti-unread-accent",
    "--ti-unread-bar-width"
  ];

  // unreadStyle -> the space-separated tokens the CSS matches with [~="…"].
  const UNREAD_STYLE_TOKENS = {
    barFade: "bar fade",
    bar: "bar",
    dot: "dot",
    ring: "ring",
    fade: "fade"
  };

  // unreadBarWidth -> accent-bar thickness in px.
  const UNREAD_BAR_WIDTHS = { narrow: "2px", medium: "4px", wide: "6px" };

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

    // Unread emphasis (Cards layout). The accent color drives the bar/ring; the
    // style tokens on the root gate which cues the CSS applies (empty when off).
    unreadOn = settings.unreadEmphasis !== false;
    rootStyle.setProperty("--ti-unread-accent", settings.unreadAccentColor || "#4aa9ff");
    rootStyle.setProperty(
      "--ti-unread-bar-width",
      UNREAD_BAR_WIDTHS[settings.unreadBarWidth] || UNREAD_BAR_WIDTHS.medium
    );
    const styleTokens = UNREAD_STYLE_TOKENS[settings.unreadStyle] || UNREAD_STYLE_TOKENS.barFade;
    if (unreadOn) {
      doc.documentElement.dataset.tiUnreadStyle = styleTokens;
    } else {
      delete doc.documentElement.dataset.tiUnreadStyle;
    }

    // Force a full recompute: color mode / initials may have changed.
    rowKeys = new WeakMap();
    enabled = settings.enabled !== false;

    // Re-resolve BIMI/Gravatar on every config push. Cheap (the host keeps TTL'd
    // caches, so usually no network), and it lets the options "Clear" buttons take
    // effect: clearing storage + re-pushing config drops these per-message caches.
    bimiEnabled = settings.bimiEnabled === true;
    bimiByMsg = new Map();
    bimiPendingMsg = new Set();
    gravatarEnabled = settings.gravatarEnabled === true;
    gravatarByMsg = new Map();
    gravatarPendingMsg = new Set();

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
        delete doc.documentElement.dataset.tiUnreadStyle;
        rowKeys = new WeakMap();
        pending = new Set();
        bimiByMsg = new Map();
        bimiPendingMsg = new Set();
        gravatarByMsg = new Map();
        gravatarPendingMsg = new Set();
      } catch (e) {
        /* best effort */
      }
    }
  };
})();
