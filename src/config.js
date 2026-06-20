/**
 * Thundericon — configuration & storage.
 *
 * Single source of truth for defaults and for reading/writing user preferences
 * in browser.storage.local. Used by the background page and the options page.
 * Publishes `globalThis.ThundericonConfig`.
 */
(function (root) {
  "use strict";

  const api = (typeof messenger !== "undefined" && messenger) ||
    (typeof browser !== "undefined" && browser) || null;

  const DEFAULTS = {
    settings: {
      enabled: true,
      layouts: { table: true, cards: true },

      // Color determination
      colorMode: "mutedPalette", // mutedPalette | grayscale | lowsatHsl | hslHash | fixed | customPalette
      fixedColor: "#6b7280",
      customPalette: ["#6b7280", "#7c8b73", "#b08968", "#6e8198"],

      // Initials font & styling
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      fontWeight: 600,
      uppercase: true,
      fontScale: 0.42, // initials font-size as a fraction of badge size

      // Badge geometry
      badgeSize: 24, // px (Table view); Cards view scales up via CSS
      borderRadius: 50, // percent (50 = circle, 0 = square)

      // Initials derivation
      initialsCount: 2, // 1 or 2
      initialsSource: "displayName" // displayName | email
    },
    // domain -> hex override map, e.g. { "example.com": "#8a9a5b" }
    domainColors: {}
  };

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function mergeSettings(stored) {
    const out = deepClone(DEFAULTS);
    if (stored && stored.settings) {
      Object.assign(out.settings, stored.settings);
      if (stored.settings.layouts) {
        out.settings.layouts = Object.assign(
          {},
          DEFAULTS.settings.layouts,
          stored.settings.layouts
        );
      }
    }
    if (stored && stored.domainColors && typeof stored.domainColors === "object") {
      out.domainColors = deepClone(stored.domainColors);
    }
    return out;
  }

  /** Read the full, defaults-merged config. */
  async function load() {
    if (!api || !api.storage) {
      return deepClone(DEFAULTS);
    }
    const stored = await api.storage.local.get(["settings", "domainColors"]);
    return mergeSettings(stored);
  }

  /**
   * Persist a partial config. Accepts { settings?, domainColors? }; the provided
   * objects fully replace their stored counterpart (callers pass merged state).
   */
  async function save(patch) {
    if (!api || !api.storage) {
      return;
    }
    const toWrite = {};
    if (patch.settings) {
      toWrite.settings = patch.settings;
    }
    if (patch.domainColors) {
      toWrite.domainColors = patch.domainColors;
    }
    await api.storage.local.set(toWrite);
  }

  /** Subscribe to local-storage changes; returns an unsubscribe function. */
  function subscribe(callback) {
    if (!api || !api.storage || !api.storage.onChanged) {
      return () => {};
    }
    const listener = (changes, areaName) => {
      if (areaName !== "local") {
        return;
      }
      if (changes.settings || changes.domainColors) {
        load().then(callback);
      }
    };
    api.storage.onChanged.addListener(listener);
    return () => api.storage.onChanged.removeListener(listener);
  }

  root.ThundericonConfig = { DEFAULTS, load, save, subscribe, mergeSettings };
})(typeof globalThis !== "undefined" ? globalThis : this);
