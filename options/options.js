/**
 * Thundericon — options page logic.
 * Reads/writes preferences via ThundericonConfig and renders a live preview
 * through the exact same code path the message list uses (ThundericonCore).
 */
"use strict";

const Core = window.ThundericonCore;
const Cfg = window.ThundericonConfig;
const $ = (id) => document.getElementById(id);

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
  sideEffects();
  updateCacheStats();
  watchCacheStats();
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

  $("bimiEnabled").checked = s.bimiEnabled === true;
  $("bimiBaseDomainOnly").checked = s.bimiBaseDomainOnly === true;
  $("bimiRefreshHours").value = String(s.bimiRefreshHours || 24);
  $("bimiDohProvider").value = s.bimiDohProvider || "adguard-family";
  $("bimiDohCustomUrl").value = s.bimiDohCustomUrl || "";

  const skip = s.bimiSkipFolders || {};
  for (const [id, key] of SKIP_FOLDERS) {
    $(id).checked = skip[key] === true;
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
    "uppercase", "colorMode", "fixedColor", "bimiEnabled", "bimiBaseDomainOnly",
    "bimiRefreshHours", "bimiDohProvider", "bimiDohCustomUrl"
  ];
  for (const id of scalars) {
    $(id).addEventListener("input", commit);
    $(id).addEventListener("change", commit);
  }
  for (const [id] of SKIP_FOLDERS) {
    $(id).addEventListener("change", commit);
  }
  $("bimiClear").addEventListener("click", clearBimiCache);
  $("bimiTest").addEventListener("click", openBimiTest);
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
  s.bimiEnabled = $("bimiEnabled").checked;
  s.bimiBaseDomainOnly = $("bimiBaseDomainOnly").checked;
  s.bimiRefreshHours = parseInt($("bimiRefreshHours").value, 10) || 24;
  s.bimiDohProvider = $("bimiDohProvider").value;
  s.bimiDohCustomUrl = $("bimiDohCustomUrl").value.trim();
  s.bimiSkipFolders = {};
  for (const [id, key] of SKIP_FOLDERS) {
    s.bimiSkipFolders[key] = $(id).checked;
  }
}

// Open the standalone BIMI test tool in its own window (tab as a fallback).
async function openBimiTest() {
  const rt = (typeof messenger !== "undefined" ? messenger : browser);
  const url = rt.runtime.getURL("options/bimi-test.html");
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

// Show a small cache-usage summary (entry count, how many hold a logo, and the
// approximate stored size) next to the Clear button — purely informational.
async function updateCacheStats() {
  const el = $("bimiCacheStats");
  if (!el) {
    return;
  }
  try {
    const rt = typeof messenger !== "undefined" ? messenger : browser;
    const stored = await rt.storage.local.get("bimiCache");
    const cache = (stored && stored.bimiCache) || {};
    const keys = Object.keys(cache);
    if (!keys.length) {
      el.textContent = "(empty)";
      return;
    }
    let logos = 0;
    for (const k of keys) {
      if (cache[k] && cache[k].status === "ok") {
        logos++;
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(cache)).length;
    el.textContent =
      keys.length + (keys.length === 1 ? " entry" : " entries") +
      ", " + logos + " with logos · " + formatBytes(bytes);
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

// Refresh the stats live as logos resolve and get persisted in the background.
function watchCacheStats() {
  const rt = typeof messenger !== "undefined" ? messenger : browser;
  if (rt.storage && rt.storage.onChanged) {
    rt.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.bimiCache) {
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
}

function sideEffects() {
  // Conditional groups
  $("fixedGroup").hidden = state.settings.colorMode !== "fixed";
  $("paletteGroup").hidden = state.settings.colorMode !== "customPalette";

  updateEnabledState();
  updateBimiState();
  applyRootVars();
  renderPreview();
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

function applyRootVars() {
  const s = state.settings;
  const root = document.documentElement.style;
  root.setProperty("--ti-size", (Number(s.badgeSize) || 24) + "px");
  root.setProperty("--ti-radius", (s.borderRadius != null ? s.borderRadius : 50) + "%");
  root.setProperty("--ti-font", s.fontFamily || "system-ui, sans-serif");
  root.setProperty("--ti-weight", String(s.fontWeight || 600));
  root.setProperty("--ti-fontscale", String(s.fontScale || 0.42));
  root.setProperty("--ti-transform", s.uppercase === false ? "none" : "uppercase");
}

function renderPreview() {
  const ul = $("preview");
  ul.textContent = "";
  for (const author of SAMPLES) {
    const desc = Core.describe(author, state.settings, state.domainColors);

    const li = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = "ti-avatar ti-avatar--row";
    badge.textContent = desc.initials;
    badge.style.setProperty("--ti-color", desc.background);
    badge.style.setProperty("--ti-fg", desc.foreground);

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
  }
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
