/**
 * Thundericon — options page logic.
 * Reads/writes preferences via ThundericonConfig and renders a live preview
 * through the exact same code path the message list uses (ThundericonCore).
 */
"use strict";

const Core = window.ThundericonCore;
const Cfg = window.ThundericonConfig;
const $ = (id) => document.getElementById(id);

// unreadStyle -> the space-separated cue tokens the CSS matches with [~="…"].
// Mirrors UNREAD_STYLE_TOKENS in the renderer so the preview shows the same cues.
const UNREAD_STYLE_TOKENS = {
  barFade: "bar fade",
  bar: "bar",
  dot: "dot",
  glyph: "glyph",
  fill: "fill",
  rowTint: "rowTint",
  ring: "ring",
  fade: "fade"
};

// unreadBarWidth -> accent-bar thickness in px (mirrors the renderer).
const UNREAD_BAR_WIDTHS = { narrow: "2px", medium: "4px", wide: "6px" };

// Build a CSS `content` value from the configured glyph (mirrors the renderer):
// the single character, escaped for a double-quoted CSS string, bullet when empty.
function glyphContent(raw) {
  const ch = Array.from(String(raw == null ? "" : raw))[0] || "";
  if (!ch) {
    return '"\\2022"';
  }
  return '"' + ch.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// Translucent #rrggbb → #rrggbbaa from a 0–100 strength (mirrors the renderer).
function washHex(hex6, pct) {
  const h = Core.normalizeHex(hex6) || "#4aa9ff";
  const p = Number(pct);
  const frac = Number.isFinite(p) ? Math.max(0, Math.min(100, p)) / 100 : 0.5;
  return h + Math.round(frac * 255).toString(16).padStart(2, "0");
}

const SAMPLES = [
  "Ada Lovelace <ada@analytical.org>",
  "Grace Hopper <grace@navy.mil>",
  "alan.turing@bletchley.uk",
  "Katherine Johnson <kjohnson@nasa.gov>",
  '"Margaret Hamilton" <mhamilton@mit.edu>',
  "Linus Torvalds <linus@kernel.org>"
];

let state = { settings: {}, domainColors: {} };
let domainRows = []; // [{ domain, color }]
let saveTimer = null;

// Folder-skip checkboxes: [checkbox id, settings key].
const SKIP_FOLDERS = [
  ["bimiSkipSent", "sent"],
  ["bimiSkipDrafts", "drafts"],
  ["bimiSkipTemplates", "templates"],
  ["bimiSkipOutbox", "outbox"],
  ["bimiSkipJunk", "junk"],
  ["bimiSkipTrash", "trash"]
];

const GRAVATAR_SKIP_FOLDERS = [
  ["gravatarSkipSent", "sent"],
  ["gravatarSkipDrafts", "drafts"],
  ["gravatarSkipTemplates", "templates"],
  ["gravatarSkipOutbox", "outbox"],
  ["gravatarSkipJunk", "junk"],
  ["gravatarSkipTrash", "trash"]
];

init();

// Show the running add-on version (read from the manifest, so it never drifts).
function showVersion() {
  try {
    const rt = (typeof messenger !== "undefined" ? messenger : browser).runtime;
    const el = $("version");
    if (el) {
      el.textContent = "v" + rt.getManifest().version;
    }
  } catch (e) {
    /* runtime unavailable (e.g. opened outside Thunderbird) */
  }
}

async function init() {
  showVersion();
  const cfg = await Cfg.load();
  state.settings = cfg.settings;
  state.domainColors = cfg.domainColors;
  domainRows = Object.keys(state.domainColors).map((d) => ({
    domain: d,
    color: Core.normalizeHex(state.domainColors[d]) || "#6e8198"
  }));

  populate();
  wire();
  wireTabs();
  sideEffects();
  updateCacheStats();
  watchCacheStats();
}

/* ---- tabbed settings board -------------------------------------------- */

// A minimal ARIA tablist: selecting a tab (by click or arrow key) shows its
// panel and hides the rest. Panels are plain .grid containers with
// role="tabpanel"; only one is ever visible, the rest carry the `hidden` attr.
function wireTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  function select(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) {
        panel.hidden = !on;
      }
    }
    if (focus) {
      tab.focus();
    }
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      let next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        next = tabs[(i + 1) % tabs.length];
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        next = tabs[(i - 1 + tabs.length) % tabs.length];
      } else if (e.key === "Home") {
        next = tabs[0];
      } else if (e.key === "End") {
        next = tabs[tabs.length - 1];
      }
      if (next) {
        e.preventDefault();
        select(next, true);
      }
    });
  });
}

/* ---- populate controls from state ------------------------------------- */

function populate() {
  const s = state.settings;
  $("enabled").checked = s.enabled !== false;
  $("layoutTable").checked = !s.layouts || s.layouts.table !== false;
  $("layoutCards").checked = !s.layouts || s.layouts.cards !== false;

  $("badgeSize").value = s.badgeSize;
  $("borderRadius").value = s.borderRadius;

  $("fontFamily").value = s.fontFamily;
  $("fontWeight").value = String(s.fontWeight);
  $("initialsCount").value = String(s.initialsCount);
  $("initialsSource").value = s.initialsSource;
  $("uppercase").checked = s.uppercase !== false;

  $("colorMode").value = s.colorMode;
  $("fixedColor").value = Core.normalizeHex(s.fixedColor) || "#6b7280";

  $("unreadEmphasis").checked = s.unreadEmphasis !== false;
  $("unreadStyle").value = s.unreadStyle || "rowTint";
  $("unreadAccentColor").value = Core.normalizeHex(s.unreadAccentColor) || "#4aa9ff";
  $("unreadBarWidth").value = s.unreadBarWidth || "medium";
  $("unreadGlyph").value = s.unreadGlyph != null ? s.unreadGlyph : "»";
  $("unreadGlyphFont").value = s.unreadGlyphFont || Cfg.DEFAULTS.settings.unreadGlyphFont;
  $("unreadGlyphSize").value = s.unreadGlyphSize || 14;
  $("unreadGlyphBold").checked = s.unreadGlyphBold === true;
  $("unreadFillMode").value = s.unreadFillMode || "fixed";
  $("unreadFillColor").value = Core.normalizeHex(s.unreadFillColor) || "#4aa9ff";
  $("unreadRowStrength").value = s.unreadRowStrength || 50;

  $("attachmentsAutoExpand").checked = s.attachmentsAutoExpand !== false;

  $("bimiEnabled").checked = s.bimiEnabled === true;
  $("bimiBaseDomainOnly").checked = s.bimiBaseDomainOnly === true;
  $("bimiRefreshHours").value = String(s.bimiRefreshHours || 168);
  $("bimiDohProvider").value = s.bimiDohProvider || "adguard-family";
  $("bimiDohCustomUrl").value = s.bimiDohCustomUrl || "";

  const skip = s.bimiSkipFolders || {};
  for (const [id, key] of SKIP_FOLDERS) {
    $(id).checked = skip[key] === true;
  }

  $("gravatarEnabled").checked = s.gravatarEnabled === true;
  $("gravatarRefreshHours").value = String(s.gravatarRefreshHours || 168);
  const gravatarSkip = s.gravatarSkipFolders || {};
  for (const [id, key] of GRAVATAR_SKIP_FOLDERS) {
    $(id).checked = gravatarSkip[key] === true;
  }

  renderPalette();
  renderDomains();
  updateOutputs();
}

/* ---- wire listeners --------------------------------------------------- */

function wire() {
  const scalars = [
    "enabled", "layoutTable", "layoutCards", "badgeSize", "borderRadius",
    "fontFamily", "fontWeight", "initialsCount", "initialsSource",
    "uppercase", "colorMode", "fixedColor",
    "unreadEmphasis", "unreadStyle", "unreadAccentColor", "unreadBarWidth",
    "unreadGlyph", "unreadGlyphFont", "unreadGlyphSize", "unreadGlyphBold",
    "unreadFillMode", "unreadFillColor", "unreadRowStrength",
    "attachmentsAutoExpand",
    "bimiEnabled", "bimiBaseDomainOnly",
    "bimiRefreshHours", "bimiDohProvider", "bimiDohCustomUrl",
    "gravatarEnabled", "gravatarRefreshHours"
  ];
  for (const id of scalars) {
    $(id).addEventListener("input", commit);
    $(id).addEventListener("change", commit);
  }
  for (const [id] of SKIP_FOLDERS) {
    $(id).addEventListener("change", commit);
  }
  for (const [id] of GRAVATAR_SKIP_FOLDERS) {
    $(id).addEventListener("change", commit);
  }
  $("bimiClear").addEventListener("click", clearBimiCache);
  $("bimiTest").addEventListener("click", openBimiTest);
  $("gravatarClear").addEventListener("click", clearGravatarCache);
  $("gravatarTest").addEventListener("click", openGravatarTest);
  $("addColor").addEventListener("click", () => {
    state.settings.customPalette = (state.settings.customPalette || []).concat("#6e8198");
    renderPalette();
    commit();
  });
  $("addDomain").addEventListener("click", () => {
    domainRows.push({ domain: "", color: "#6e8198" });
    renderDomains();
    // No commit yet — empty domain is ignored until filled.
    const last = $("domainList").lastElementChild;
    if (last) {
      last.querySelector('input[type="text"]').focus();
    }
  });
  $("reset").addEventListener("click", resetDefaults);
}

/* ---- custom palette editor -------------------------------------------- */

function renderPalette() {
  const list = $("paletteList");
  list.textContent = "";
  const palette = state.settings.customPalette || [];
  palette.forEach((color, i) => {
    const chip = document.createElement("div");
    chip.className = "chip";

    const input = document.createElement("input");
    input.type = "color";
    input.value = Core.normalizeHex(color) || "#6e8198";
    input.addEventListener("input", () => {
      state.settings.customPalette[i] = input.value;
      commit();
    });

    const x = document.createElement("button");
    x.className = "x";
    x.type = "button";
    x.textContent = "×";
    x.title = "Remove";
    x.addEventListener("click", () => {
      state.settings.customPalette.splice(i, 1);
      renderPalette();
      commit();
    });

    chip.append(input, x);
    list.append(chip);
  });
}

/* ---- domain mapping editor -------------------------------------------- */

function renderDomains() {
  const list = $("domainList");
  list.textContent = "";
  domainRows.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "domain-row";

    const domain = document.createElement("input");
    domain.type = "text";
    domain.placeholder = "example.com";
    domain.spellcheck = false;
    domain.value = entry.domain;
    domain.addEventListener("input", () => {
      entry.domain = domain.value;
      commit();
    });

    const color = document.createElement("input");
    color.type = "color";
    color.value = Core.normalizeHex(entry.color) || "#6e8198";
    color.addEventListener("input", () => {
      entry.color = color.value;
      commit();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      domainRows.splice(i, 1);
      renderDomains();
      commit();
    });

    row.append(domain, color, remove);
    list.append(row);
  });
}

/* ---- collect, save, side effects -------------------------------------- */

function collectScalars() {
  const s = state.settings;
  s.enabled = $("enabled").checked;
  s.layouts = { table: $("layoutTable").checked, cards: $("layoutCards").checked };
  s.badgeSize = parseInt($("badgeSize").value, 10);
  s.borderRadius = parseInt($("borderRadius").value, 10);
  s.fontFamily = $("fontFamily").value.trim() || Cfg.DEFAULTS.settings.fontFamily;
  s.fontWeight = parseInt($("fontWeight").value, 10);
  s.initialsCount = parseInt($("initialsCount").value, 10);
  s.initialsSource = $("initialsSource").value;
  s.uppercase = $("uppercase").checked;
  s.colorMode = $("colorMode").value;
  s.fixedColor = $("fixedColor").value;
  s.unreadEmphasis = $("unreadEmphasis").checked;
  s.unreadStyle = $("unreadStyle").value;
  s.unreadAccentColor = $("unreadAccentColor").value;
  s.unreadBarWidth = $("unreadBarWidth").value;
  s.unreadGlyph = $("unreadGlyph").value;
  s.unreadGlyphFont = $("unreadGlyphFont").value.trim() || Cfg.DEFAULTS.settings.unreadGlyphFont;
  s.unreadGlyphSize = parseInt($("unreadGlyphSize").value, 10) || 14;
  s.unreadGlyphBold = $("unreadGlyphBold").checked;
  s.unreadFillMode = $("unreadFillMode").value;
  s.unreadFillColor = $("unreadFillColor").value;
  s.unreadRowStrength = parseInt($("unreadRowStrength").value, 10) || 50;
  s.attachmentsAutoExpand = $("attachmentsAutoExpand").checked;
  s.bimiEnabled = $("bimiEnabled").checked;
  s.bimiBaseDomainOnly = $("bimiBaseDomainOnly").checked;
  s.bimiRefreshHours = parseInt($("bimiRefreshHours").value, 10) || 168;
  s.bimiDohProvider = $("bimiDohProvider").value;
  s.bimiDohCustomUrl = $("bimiDohCustomUrl").value.trim();
  s.bimiSkipFolders = {};
  for (const [id, key] of SKIP_FOLDERS) {
    s.bimiSkipFolders[key] = $(id).checked;
  }
  s.gravatarEnabled = $("gravatarEnabled").checked;
  s.gravatarRefreshHours = parseInt($("gravatarRefreshHours").value, 10) || 168;
  s.gravatarSkipFolders = {};
  for (const [id, key] of GRAVATAR_SKIP_FOLDERS) {
    s.gravatarSkipFolders[key] = $(id).checked;
  }
}

// Open the standalone BIMI test tool in its own window (tab as a fallback).
async function openBimiTest() {
  await openTestWindow("options/bimi-test.html");
}

// Open the standalone Gravatar test tool in its own window (tab as a fallback).
async function openGravatarTest() {
  await openTestWindow("options/gravatar-test.html");
}

async function openTestWindow(page) {
  const rt = (typeof messenger !== "undefined" ? messenger : browser);
  const url = rt.runtime.getURL(page);
  try {
    await rt.windows.create({ url, type: "popup", width: 680, height: 640 });
  } catch (e) {
    try {
      await rt.tabs.create({ url });
    } catch (e2) {
      window.open(url, "_blank");
    }
  }
}

// Ask the background to wipe the persisted + in-memory BIMI logo caches.
async function clearBimiCache() {
  const btn = $("bimiClear");
  btn.disabled = true;
  try {
    const rt = (typeof messenger !== "undefined" ? messenger : browser).runtime;
    await rt.sendMessage({ type: "thundericon:clearBimi" });
    flashStatus("Logo cache cleared");
    updateCacheStats();
  } catch (e) {
    flashStatus("Clear failed");
  } finally {
    // updateBimiState re-disables it if BIMI is off.
    updateBimiState();
  }
}

// Ask the background to wipe the persisted + in-memory Gravatar photo caches.
async function clearGravatarCache() {
  const btn = $("gravatarClear");
  btn.disabled = true;
  try {
    const rt = (typeof messenger !== "undefined" ? messenger : browser).runtime;
    await rt.sendMessage({ type: "thundericon:clearGravatar" });
    flashStatus("Photo cache cleared");
    updateCacheStats();
  } catch (e) {
    flashStatus("Clear failed");
  } finally {
    // updateGravatarState re-disables it if Gravatar is off.
    updateGravatarState();
  }
}

// Show a small cache-usage summary (entry count, how many hold an image, and the
// approximate stored size) next to each Clear button — purely informational.
async function updateCacheStats() {
  await updateOneCacheStat("bimiCacheStats", "bimiCache", "logos");
  await updateOneCacheStat("gravatarCacheStats", "gravatarCache", "photos");
}

async function updateOneCacheStat(elId, storageKey, noun) {
  const el = $(elId);
  if (!el) {
    return;
  }
  try {
    const rt = typeof messenger !== "undefined" ? messenger : browser;
    const stored = await rt.storage.local.get(storageKey);
    const cache = (stored && stored[storageKey]) || {};
    const keys = Object.keys(cache);
    if (!keys.length) {
      el.textContent = "(empty)";
      return;
    }
    let hits = 0;
    for (const k of keys) {
      if (cache[k] && cache[k].status === "ok") {
        hits++;
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(cache)).length;
    el.textContent =
      keys.length + (keys.length === 1 ? " entry" : " entries") +
      ", " + hits + " with " + noun + " · " + formatBytes(bytes);
  } catch (e) {
    el.textContent = "";
  }
}

function formatBytes(n) {
  if (n < 1024) {
    return n + " B";
  }
  if (n < 1024 * 1024) {
    return (n / 1024).toFixed(1) + " KB";
  }
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

// Refresh the stats live as logos/photos resolve and get persisted in the background.
function watchCacheStats() {
  const rt = typeof messenger !== "undefined" ? messenger : browser;
  if (rt.storage && rt.storage.onChanged) {
    rt.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes.bimiCache || changes.gravatarCache)) {
        updateCacheStats();
      }
    });
  }
}

function serializeDomains() {
  const map = {};
  for (const r of domainRows) {
    const d = r.domain.trim().toLowerCase().replace(/^mailto:/, "").replace(/^@+/, "");
    if (d) {
      map[d] = r.color;
    }
  }
  state.domainColors = map;
}

function commit() {
  collectScalars();
  serializeDomains();
  updateOutputs();
  sideEffects();
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await Cfg.save({ settings: state.settings, domainColors: state.domainColors });
    flashStatus("Saved");
  }, 200);
}

function flashStatus(text) {
  const el = $("status");
  el.textContent = text;
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => (el.textContent = ""), 1200);
}

function updateOutputs() {
  $("badgeSizeOut").textContent = $("badgeSize").value + "px";
  $("borderRadiusOut").textContent =
    $("borderRadius").value === "50" ? "circle" : $("borderRadius").value + "%";
  $("unreadGlyphSizeOut").textContent = $("unreadGlyphSize").value + "px";
  $("unreadRowStrengthOut").textContent = $("unreadRowStrength").value + "%";
}

function sideEffects() {
  // Conditional groups
  $("fixedGroup").hidden = state.settings.colorMode !== "fixed";
  $("paletteGroup").hidden = state.settings.colorMode !== "customPalette";

  updateEnabledState();
  updateUnreadState();
  updateBimiState();
  updateGravatarState();
  applyRootVars();
  renderPreview();
}

// The style select and accent color only matter when unread emphasis is on. The
// accent color is hidden for the "fade" style, which uses no accent color.
function updateUnreadState() {
  const on = $("unreadEmphasis").checked;
  const style = $("unreadStyle").value;
  const hasBar = style === "bar" || style === "barFade";
  const isGlyph = style === "glyph";
  // Both "fill" (icon square) and "rowTint" (whole row) use the same fill
  // color/mode controls; the accent drives the bar/dot/glyph/ring instead.
  const usesFill = style === "fill" || style === "rowTint";
  const isRow = style === "rowTint"; // background strength only applies to the row wash
  const usesAccent = !usesFill && style !== "fade";
  $("unreadStyle").disabled = !on;
  $("unreadAccentColor").disabled = !on || !usesAccent;
  $("unreadBarWidth").disabled = !on || !hasBar;
  for (const id of ["unreadGlyph", "unreadGlyphFont", "unreadGlyphSize", "unreadGlyphBold"]) {
    $(id).disabled = !on || !isGlyph;
  }
  $("unreadFillMode").disabled = !on || !usesFill;
  $("unreadFillColor").disabled = !on || !usesFill;
  $("unreadRowStrength").disabled = !on || !isRow;
  $("unreadGroup").classList.toggle("disabled", !on);
  $("unreadColorGroup").hidden = !usesAccent;
  $("unreadWidthGroup").hidden = !hasBar; // width only applies to the bar
  $("unreadGlyphGroup").hidden = !isGlyph; // character options only for the glyph
  $("unreadFillGroup").hidden = !usesFill; // fill color/mode for fill + row tint
  $("unreadRowStrengthRow").hidden = !isRow; // strength only for the row background
}

// The per-view toggles only matter when the master switch is on, so gray them
// out (and disable them) while "Show avatars" is off — makes the dependency clear.
function updateEnabledState() {
  const on = $("enabled").checked;
  $("layoutTable").disabled = !on;
  $("layoutCards").disabled = !on;
  $("layoutGroup").classList.toggle("disabled", !on);
}

// The refresh interval, provider and clear button only matter when BIMI is on.
// The custom-URL field is shown only for the "custom" provider.
function updateBimiState() {
  const on = $("bimiEnabled").checked;
  $("bimiBaseDomainOnly").disabled = !on;
  $("bimiRefreshHours").disabled = !on;
  $("bimiDohProvider").disabled = !on;
  $("bimiClear").disabled = !on;
  $("bimiGroup").classList.toggle("disabled", !on);
  for (const [id] of SKIP_FOLDERS) {
    $(id).disabled = !on;
  }

  const custom = $("bimiDohProvider").value === "custom";
  $("bimiCustomGroup").hidden = !custom;
  $("bimiDohCustomUrl").disabled = !on || !custom;
}

// The refresh interval, folder skips and clear button only matter when Gravatar
// is on, so gray them out (and disable them) while it is off.
function updateGravatarState() {
  const on = $("gravatarEnabled").checked;
  $("gravatarRefreshHours").disabled = !on;
  $("gravatarClear").disabled = !on;
  $("gravatarGroup").classList.toggle("disabled", !on);
  for (const [id] of GRAVATAR_SKIP_FOLDERS) {
    $(id).disabled = !on;
  }
}

function applyRootVars() {
  const s = state.settings;
  const root = document.documentElement.style;
  root.setProperty("--ti-size", (Number(s.badgeSize) || 24) + "px");
  root.setProperty("--ti-radius", (s.borderRadius != null ? s.borderRadius : 50) + "%");
  root.setProperty("--ti-font", s.fontFamily || "system-ui, sans-serif");
  root.setProperty("--ti-weight", String(s.fontWeight || 600));
  root.setProperty("--ti-fontscale", String(s.fontScale || 0.42));
  root.setProperty("--ti-transform", s.uppercase === false ? "none" : "uppercase");

  // Mirror the Cards-view unread emphasis onto the root so the preview shows it
  // (the preview reuses the same accent color + cue tokens as the renderer).
  root.setProperty("--ti-unread-accent", Core.normalizeHex(s.unreadAccentColor) || "#4aa9ff");
  root.setProperty(
    "--ti-unread-bar-width",
    UNREAD_BAR_WIDTHS[s.unreadBarWidth] || UNREAD_BAR_WIDTHS.medium
  );
  root.setProperty("--ti-unread-glyph", glyphContent(s.unreadGlyph));
  root.setProperty("--ti-unread-glyph-font", s.unreadGlyphFont || "inherit");
  root.setProperty("--ti-unread-glyph-size", (Number(s.unreadGlyphSize) || 14) + "px");
  root.setProperty("--ti-unread-glyph-weight", s.unreadGlyphBold ? "700" : "400");
  const fillColor = Core.normalizeHex(s.unreadFillColor) || "#4aa9ff";
  root.setProperty("--ti-unread-fill", fillColor);
  root.setProperty("--ti-unread-fill-fg", Core.pickForeground(fillColor));
  root.setProperty("--ti-unread-fill-wash", washHex(fillColor, s.unreadRowStrength));
  if (s.unreadEmphasis !== false) {
    document.documentElement.dataset.tiUnreadStyle =
      UNREAD_STYLE_TOKENS[s.unreadStyle] || UNREAD_STYLE_TOKENS.bar;
    document.documentElement.dataset.tiFillMode =
      s.unreadFillMode === "iconColor" ? "iconColor" : "fixed";
  } else {
    delete document.documentElement.dataset.tiUnreadStyle;
    delete document.documentElement.dataset.tiFillMode;
  }
}

function renderPreview() {
  const ul = $("preview");
  ul.textContent = "";
  // Show the Cards-view unread emphasis in the preview: tag alternating samples
  // read/unread (only when the feature is on) so the accent bar / fade / ring is
  // visible right here. The badge marker classes match the renderer's; the
  // preview-scoped rules in options.css gate on the same data-ti-unread-style.
  const unreadOn = state.settings.unreadEmphasis !== false;
  SAMPLES.forEach((author, i) => {
    const desc = Core.describe(author, state.settings, state.domainColors);

    const li = document.createElement("li");
    li.style.setProperty("--ti-row-color", desc.background); // for the rowTint style
    li.style.setProperty("--ti-row-wash", washHex(desc.background, state.settings.unreadRowStrength));
    const badge = document.createElement("span");
    badge.className = "ti-avatar ti-avatar--row";
    badge.textContent = desc.initials;
    badge.style.setProperty("--ti-color", desc.background);
    badge.style.setProperty("--ti-fg", desc.foreground);
    if (unreadOn) {
      const unread = i % 2 === 0;
      badge.classList.toggle("ti-avatar--unread", unread);
      badge.classList.toggle("ti-avatar--read", !unread);
    }

    const text = document.createElement("span");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = desc.name || desc.email || "(unknown)";
    const addr = document.createElement("span");
    addr.className = "addr";
    addr.textContent = desc.email || "";
    text.append(name, addr);

    li.append(badge, text);
    ul.append(li);
  });
}

/* ---- reset ------------------------------------------------------------ */

function resetDefaults() {
  const d = JSON.parse(JSON.stringify(Cfg.DEFAULTS));
  state.settings = d.settings;
  state.domainColors = d.domainColors;
  domainRows = [];
  populate();
  commit();
  flashStatus("Reset to defaults");
}
